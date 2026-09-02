import { insertScores } from '../db/repositories/walletScoreHistory.js';
import {
  listWalletsForScoring,
  setWalletActive,
  updateWalletScore,
  type WatchlistWallet,
} from '../db/repositories/watchlistWallets.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { fetchWalletStats } from '../gmgn/walletStats.js';
import { WALLET_SCORING_LOOP_PACING_MS } from './intervals.js';
import {
  ADVISORY_TOKEN_COUNT_FLOOR,
  ADVISORY_WIN_RATE_FLOOR,
} from '../telegram/commands.js';
import { delay } from '../util/delay.js';

/**
 * Layer 2 — re-scoring. Σκοράρει active ΚΑΙ auto-deactivated wallets (`below_threshold`)
 * σε κάθε κύκλο — ΟΧΙ πια μόνο `listActiveWallets` — ώστε ένα auto-deactivated wallet να
 * έχει την ευκαιρία να ξαναπεράσει το threshold και να επανενεργοποιηθεί. Τα manually
 * `/unwatch`-ed ΔΕΝ σκοράρονται πια — ο χρήστης τα απέκλεισε σκόπιμα, δεν έχει νόημα να
 * ξοδεύουμε weight πάνω τους (βλ. `listWalletsForScoring`).
 *
 * Κόστος: weight 3 **ανά wallet** — το `portfolio stats` δε κάνει batch παρά το help text
 * (δοκιμασμένο). Ανεκτό όσο η watchlist είναι μικρή· αν μεγαλώσει σημαντικά, το interval
 * πρέπει να αραιώσει ή να χωριστεί σε ξεχωριστά loops ανά source.
 *
 * ⚠️ Το default `portfolio stats` (χωρίς --period) είναι 7-ήμερο κυλιόμενο παράθυρο, ΟΧΙ
 * lifetime — επιβεβαιωμένο πραγματικό call 2026-09-02 (--period all έδωσε ΤΑΥΤΟΣΗΜΑ
 * αποτελέσματα με --period 30d σε γνωστό wallet — το GMGN δε φαίνεται να έχει
 * πραγματικά δεδομένα πέρα από ~30 μέρες, ό,τι κι αν λέει το "all"). Αυτό σημαίνει ότι
 * το `trade_count >= 15` είναι ήδη "15+ θέσεις στις τελευταίες 7 μέρες" — αρκετά αυστηρό,
 * ήδη "πρόσφατη φόρμα" παρά lifetime ρεκόρ. Δεν αλλάζουμε το period εδώ — ήδη το πιο
 * πρόσφατο διαθέσιμο.
 *
 * Auto-deactivate/reactivate απαιτεί ΔΥΟ συνεχόμενες μετρήσεις (όχι μία), ακριβώς επειδή
 * ένα 7-ήμερο κυλιόμενο παράθυρο είναι φυσικά πιο θορυβώδες από lifetime — αλλιώς
 * ρισκάρουμε flapping ενεργό/ανενεργό σε κάθε μικρή διακύμανση. Reuse το ΗΔΗ
 * αποθηκευμένο `wallet.winRate`/`tradeCount` (η προηγούμενη μέτρηση) αντί για νέο query
 * στο `wallet_score_history` — και τα δύο readings διαθέσιμα ήδη μέσα στον βρόχο.
 */
export interface ScoringResult {
  walletsScored: number;
  failures: number;
  alerts: string[];
}

export async function runWalletScoringCycle(): Promise<ScoringResult> {
  const wallets = await listWalletsForScoring();
  const scores: {
    walletAddress: string;
    winRate: number | null;
    pnlMultiplier: number | null;
    tradeCount: number | null;
  }[] = [];
  const alerts: string[] = [];
  let failures = 0;

  try {
    for (const wallet of wallets) {
      try {
        const stats = await fetchWalletStats({ wallet: wallet.address });
        await delay(WALLET_SCORING_LOOP_PACING_MS);
        const score = {
          walletAddress: wallet.address,
          winRate: stats.winRate,
          // `realized_profit_pnl` είναι ratio, όχι multiplier — βλ. walletStats.ts.
          pnlMultiplier: stats.realizedPnlRatio,
          // token_num: ο παρονομαστής του winRate, ΟΧΙ buy+sell.
          tradeCount: stats.tokenCount,
        };
        scores.push(score);
        await updateWalletScore(wallet.address, score);

        const lifecycleAlert = await applyLifecycleTransition(wallet, score);
        if (lifecycleAlert !== null) {
          alerts.push(lifecycleAlert);
        } else {
          const alert = advisoryFor(wallet, score.winRate, score.tradeCount);
          if (alert !== null) alerts.push(alert);
        }
      } catch (error) {
        // Rate limit: ΟΧΙ "ένα wallet απέτυχε" — σταματά ολόκληρο τον κύκλο, αλλιώς τα
        // επόμενα wallets θα ξαναχτυπούσαν το API μέσα στο ban (rethrowIfRateLimited).
        rethrowIfRateLimited(error);
        failures += 1;
        await delay(WALLET_SCORING_LOOP_PACING_MS);
      }
    }
  } finally {
    // Πάντα γράφουμε ό,τι μαζεύτηκε μέχρι στιγμής — ακόμα και όταν το rethrow πιο πάνω
    // σταματήσει πρόωρα τον κύκλο, καλύτερο ένα partial history point παρά κανένα.
    await insertScores(scores);
  }

  return { walletsScored: scores.length, failures, alerts };
}

function passesThreshold(winRate: number | null, tradeCount: number | null): boolean {
  return (
    winRate !== null &&
    winRate >= ADVISORY_WIN_RATE_FLOOR &&
    tradeCount !== null &&
    tradeCount >= ADVISORY_TOKEN_COUNT_FLOOR
  );
}

export type LifecycleTransition = 'deactivate' | 'reactivate' | null;

/**
 * Καθαρή function, χωρίς DB — δύο συνεχόμενες αποτυχίες → deactivate· δύο συνεχόμενες
 * επιτυχίες ΜΕΤΑ από auto-deactivate → reactivate. Ποτέ δεν προτείνει reactivate για
 * `deactivatedReason='manual'` — το `/unwatch` παραμένει τελικό veto.
 */
export function decideLifecycleTransition(
  wallet: Pick<WatchlistWallet, 'active' | 'winRate' | 'tradeCount' | 'deactivatedReason'>,
  score: { winRate: number | null; tradeCount: number | null },
): LifecycleTransition {
  const wasPassing = passesThreshold(wallet.winRate, wallet.tradeCount);
  const isPassingNow = passesThreshold(score.winRate, score.tradeCount);

  if (wallet.active && !wasPassing && !isPassingNow) return 'deactivate';
  if (!wallet.active && wallet.deactivatedReason === 'below_threshold' && wasPassing && isPassingNow) {
    return 'reactivate';
  }
  return null;
}

async function applyLifecycleTransition(
  wallet: WatchlistWallet,
  score: { winRate: number | null; tradeCount: number | null },
): Promise<string | null> {
  const transition = decideLifecycleTransition(wallet, score);
  if (transition === 'deactivate') {
    await setWalletActive(wallet.address, false, 'below_threshold');
    return (
      `🔴 ${wallet.address}\n` +
      `Απενεργοποιήθηκε αυτόματα — win rate κάτω από ${(ADVISORY_WIN_RATE_FLOOR * 100).toFixed(0)}% ` +
      'σε 2 συνεχόμενες μετρήσεις. Θα επανενεργοποιηθεί μόνο του αν ξαναπεράσει το threshold.'
    );
  }
  if (transition === 'reactivate') {
    await setWalletActive(wallet.address, true);
    return (
      `🟢 ${wallet.address}\n` +
      'Επανενεργοποιήθηκε αυτόματα — win rate ξαναπέρασε το threshold σε 2 συνεχόμενες μετρήσεις.'
    );
  }
  return null;
}

/**
 * Alert μόνο στη **διάσχιση** του floor, όχι σε κάθε κύκλο όσο μένει κάτω — αλλιώς ένα
 * wallet με win rate 0.45 θα έστελνε μήνυμα κάθε λίγα δευτερόλεπτα και το κανάλι θα
 * γινόταν άχρηστο. Η προηγούμενη τιμή είναι αυτή που έχει το `watchlist_wallets`.
 */
function advisoryFor(
  wallet: WatchlistWallet,
  winRate: number | null,
  tokenCount: number | null,
): string | null {
  if (winRate === null) return null;
  const wasAbove = wallet.winRate === null || wallet.winRate >= ADVISORY_WIN_RATE_FLOOR;
  const isBelow = winRate < ADVISORY_WIN_RATE_FLOOR;
  if (!(wasAbove && isBelow)) return null;

  const sample =
    tokenCount !== null && tokenCount < ADVISORY_TOKEN_COUNT_FLOOR
      ? ` (μόνο ${tokenCount} θέσεις — μικρό δείγμα)`
      : '';
  return (
    `⚠️ ${wallet.address}\n` +
    `win rate έπεσε στο ${(winRate * 100).toFixed(1)}%, κάτω από το ${(ADVISORY_WIN_RATE_FLOOR * 100).toFixed(0)}%${sample}.\n` +
    'Άξιο review — δεν απενεργοποιήθηκε.'
  );
}

import { insertScores } from '../db/repositories/walletScoreHistory.js';
import {
  listActiveWallets,
  updateWalletScore,
  type WatchlistWallet,
} from '../db/repositories/watchlistWallets.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { fetchWalletStats } from '../gmgn/walletStats.js';
import { WALLET_LOOP_PACING_MS } from './intervals.js';
import {
  ADVISORY_TOKEN_COUNT_FLOOR,
  ADVISORY_WIN_RATE_FLOOR,
} from '../telegram/commands.js';
import { delay } from '../util/delay.js';

/**
 * Layer 2 — re-scoring. Σκοράρει ΟΛΑ τα active wallets σε κάθε κύκλο, ανεξαρτήτως
 * `source` — `wallet_score_history` πρέπει να δείχνει την τάση κάθε wallet που
 * παρακολουθούμε, όχι μόνο των manual. Καμία αλλαγή decision logic εδώ: το ποιο wallet
 * μπαίνει `active` (auto-discovery threshold ή χειροκίνητο override) αποφασίζεται
 * αλλού· εδώ απλά καταγράφουμε το τρέχον score του καθενός.
 *
 * Κόστος: weight 3 **ανά wallet** — το `portfolio stats` δε κάνει batch παρά το help text
 * (δοκιμασμένο). Ανεκτό όσο η watchlist είναι μικρή· αν μεγαλώσει σημαντικά, το interval
 * πρέπει να αραιώσει ή να χωριστεί σε ξεχωριστά loops ανά source.
 *
 * Τα αδύναμα wallets **δεν απενεργοποιούνται** αυτόματα — για τα manual αποφασίζει ο
 * χρήστης που τα πρόσθεσε ο ίδιος· για τα auto-discovered δεν υπάρχει ακόμα ξεχωριστή
 * πολιτική αυτόματης απενεργοποίησης, άρα το ίδιο advisory-only μονοπάτι ισχύει και εδώ.
 * Επιστρέφουμε τα alerts και τα στέλνει ο scheduler.
 */
export interface ScoringResult {
  walletsScored: number;
  failures: number;
  alerts: string[];
}

export async function runWalletScoringCycle(): Promise<ScoringResult> {
  const wallets = await listActiveWallets();
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
        await delay(WALLET_LOOP_PACING_MS);
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

        const alert = advisoryFor(wallet, score.winRate, score.tradeCount);
        if (alert !== null) alerts.push(alert);
      } catch (error) {
        // Rate limit: ΟΧΙ "ένα wallet απέτυχε" — σταματά ολόκληρο τον κύκλο, αλλιώς τα
        // επόμενα wallets θα ξαναχτυπούσαν το API μέσα στο ban (rethrowIfRateLimited).
        rethrowIfRateLimited(error);
        failures += 1;
        await delay(WALLET_LOOP_PACING_MS);
      }
    }
  } finally {
    // Πάντα γράφουμε ό,τι μαζεύτηκε μέχρι στιγμής — ακόμα και όταν το rethrow πιο πάνω
    // σταματήσει πρόωρα τον κύκλο, καλύτερο ένα partial history point παρά κανένα.
    await insertScores(scores);
  }

  return { walletsScored: scores.length, failures, alerts };
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

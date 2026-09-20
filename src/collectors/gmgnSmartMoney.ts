import { findPassedTokens } from '../db/repositories/decisionLog.js';
import { recordSignal } from '../db/repositories/entries.js';
import { countOpenTrades } from '../db/repositories/paperTrades.js';
import { WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE } from './intervals.js';
import { PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import { subscribeForNewTrade } from '../realtime/subscriptionManager.js';
import type { PumpPortalConnection } from '../realtime/pumpportalConnection.js';
import { applyEntrySlippage } from '../decision/pnl.js';
import {
  PAPER_ASSUMED_LATENCY_MS,
  PAPER_ASSUMED_SLIPPAGE_PCT,
  PAPER_BANKROLL_SOL,
  PAPER_POSITION_SIZE_PCT,
  conditionOrdersJson,
} from '../decision/paperTradingConfig.js';
import { fetchSmartMoneyTrades, type SmartMoneyTrade } from '../gmgn/trackSmartmoney.js';
import { toNumberOrNull } from '../gmgn/validate.js';
import {
  computeFloatShare,
  computeRiskWalletPct,
  fetchAllTokenHolders,
  isFloatDegenerate,
} from '../gmgn/holderRisk.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';

/**
 * Δεύτερο, ανεξάρτητο trigger-κανάλι πλάι στο layer 3 (walletActivity.ts /
 * realtimeEntryHandler.ts) — `track smartmoney`, GMGN's ΔΙΚΑ ΤΟΥ tagged smart-money/whale
 * wallets, ΟΧΙ η δική μας self-curated watchlist. CLAUDE.md το είχε ρητά σημειώσει ως
 * "παραμένει open/unimplemented" (layer 2 σχόλιο) — αυτό είναι η πρώτη υλοποίηση.
 *
 * Weight 1 ΣΥΝΟΛΙΚΑ ανά κύκλο (όχι ανά wallet, βλ. routes.ts) — πολύ φθηνότερο από το
 * layer 3 (weight 3/wallet/κύκλο), γι' αυτό μπορεί να τρέχει συχνά χωρίς να πιέζει το
 * shared 20/s bucket.
 *
 * ΣΚΟΠΙΜΑ mode='log_only' ΠΑΝΤΑ σε αυτό το πρώτο πέρασμα, ΠΟΤΕ live — ίδια φιλοσοφία με
 * το "Phased rollout" του CLAUDE.md: μια ολοκαίνουρια, ανεπικύρωτη πηγή σήματος
 * καταγράφεται πρώτα (δικό της trigger_type: 'gmgn_smartmoney', διαφορετικό από το δικό
 * μας 'smart_money_buy') ώστε να μετρηθεί ξεχωριστά το hit-rate της πριν εμπιστευτεί
 * πραγματικό κεφάλαιο ή ακόμα και paper trading. Καμία αλλαγή στο recordSignal/entries.ts
 * χρειάστηκε — το mode ήταν ήδη ρητή παράμετρος του caller, όχι κλειδωμένο.
 *
 * ΔΕΝ κάνει δικό του GMGN call για την τιμή εισόδου — χρησιμοποιεί το ήδη υπάρχον
 * `gate_snapshot_json.price` από το πέρασμα του gate (discovery.ts), ΑΚΡΙΒΩΣ το ίδιο
 * μοτίβο με το walletActivity.ts — καμία επιπλέον GMGN weight μόνο για ένα simulated
 * entry.
 *
 * ΠΡΩΤΟ ΠΡΑΓΜΑΤΙΚΟ ΔΕΙΓΜΑ (2026-09-20, 44 σήματα, ~36 κλειστά): 81% (29/36) έκλεισαν με
 * stop_loss, σχεδόν πάντα στο -99% — το gate μας ΔΕΝ φιλτράρει το βασικό ~98.6%
 * collapse-rate των pump.fun tokens σε αυτό το κανάλι καλύτερα απ' ό,τι στο layer 3. Οι
 * σπάνιες νίκες όμως είναι τεράστιες (+6525%, +3466%, +1476%, +212%, +201%, +50%) —
 * θετικός μέσος όρος (+253%) βασισμένος αποκλειστικά σε λίγα outliers, στατιστικά
 * εύθραυστο ακόμα. `is_open_or_close` (βλ. `triggerWalletSnapshot` παρακάτω, βλ. σχόλιο
 * `.claude/skills/gmgn-track/SKILL.md` "Full position events ... carry much stronger
 * conviction than partial adds") είναι υποψήφιο φίλτρο — καταγράφεται ΤΩΡΑ ρητά για να
 * ελεγχθεί αναδρομικά μόλις μαζευτεί αρκετό νέο δείγμα, ΔΕΝ χρησιμοποιείται ακόμα ως
 * φίλτρο εισόδου (πρώτα δεδομένα, μετά απόφαση — ρητό αίτημα χρήστη 2026-09-20).
 *
 * **Risk-wallet % (proposal #5, 2026-09-20)** — για κάθε φρέσκο σήμα που περνάει το gate,
 * καλούμε ΕΝΑ ΕΠΙΠΛΕΟΝ `token holders` (χωρίς `--tag`, βλ. `gmgn/holderRisk.ts`) πάνω στο
 * ίδιο token, υπολογίζουμε το ποσοστό του float που κρατούν bundler/rat_trader/sniper
 * wallets, και το αποθηκεύουμε στο `triggerWalletSnapshot` ως `holder_risk_pct`
 * (`null` όταν η ανάλυση είναι "unassessable" — βλ. `isFloatDegenerate`). ΡΗΤΗ επιλογή
 * χρήστη: καταγραφή πρώτα, ΟΧΙ φίλτρο ακόμα — ίδια φιλοσοφία με το `is_open_or_close`
 * πιο πάνω, ώστε να ελεγχθεί ποιο threshold (αν κάποιο) πράγματι διαχωρίζει winners/losers
 * πριν μπλοκάρουμε σήματα με βάση αυτό. Weight 5 ΑΝΑ σήμα — πολύ πιο ακριβό από το weight-1
 * -ανά-κύκλο του ίδιου του καναλιού, γι' αυτό ΔΕΝ μπλοκάρει ποτέ το `recordSignal`: μια
 * αποτυχία εδώ (rate limit, ή οποιοδήποτε άλλο σφάλμα) καταγράφεται ως `null` στο snapshot
 * και το σήμα προχωράει κανονικά — το holders-check είναι καθαρά προαιρετική εμπλουτισμένη
 * καταγραφή, όχι κρίσιμο μονοπάτι για το `recordSignal`. ΠΑΡΟΛΑ ΑΥΤΑ αυτό ΕΙΝΑΙ loop πάνω σε
 * πολλά (fresh) trades στον ίδιο κύκλο — αν το πρώτο holders call πάρει 429, το ίδιο
 * `SharedCooldown`/ban ισχύει και για τα επόμενα, οπότε ΔΕΝ ξαναδοκιμάζουμε holders calls
 * μέσα στον ίδιο κύκλο μετά το πρώτο rate-limit hit (`rateLimitedThisCycle` flag πιο κάτω)
 * — ίδιο πνεύμα με το `rethrowIfRateLimited` guard, προσαρμοσμένο ώστε να μη σταματάει
 * ολόκληρο τον κύκλο (το `recordSignal` για τα υπόλοιπα trades πρέπει να συνεχίσει).
 *
 * Δεν υπάρχει τεκμηριωμένη σελιδοποίηση/cursor σε αυτό το route (μόνο `--limit` πάνω σε
 * πρόσφατα trades, βλ. gmgn-track skill) — το dedup γίνεται εδώ, in-memory, μέσω
 * `transactionHash`. Σκόπιμη απλοποίηση για ένα πρώτο, log-only πέρασμα: σε restart,
 * ένα μικρό αριθμό ήδη-επεξεργασμένων trades μπορεί να ξαναδούμε, αλλά το recordTrigger
 * (decisionLog.ts) είναι ήδη idempotent σε αυτό (WHERE decision <> 'entered' AND
 * linked_trade_id IS NULL, plus το guard για ήδη ανοιχτό trade στο ίδιο ζευγάρι
 * token+wallet) — ίδια ασφάλεια με το ήδη υπάρχον polling fallback path. Αν αυτό το
 * κανάλι προαχθεί πέρα από πείραμα, ένα persisted cursor (migration) θα άξιζε τον κόπο.
 */
export interface GmgnSmartMoneyOptions {
  limit?: number;
  realtimeConnection?: PumpPortalConnection;
  /** Test-only override· production παίρνει πάντα φρέσκο module-level Set. */
  seenTxHashes?: Set<string>;
}

export interface GmgnSmartMoneyResult {
  version: string;
  tradesFetched: number;
  newTrades: number;
  signalsRecorded: number;
}

/** Module-level, επιζεί ανάμεσα σε κύκλους μέσα στο ίδιο process — βλ. σχόλιο πάνω από
 * το interface για γιατί δεν χρειάζεται persisted cursor σε αυτό το πρώτο πέρασμα.
 * Bounded ώστε να μη μεγαλώνει επ' αόριστον σε ένα μακρόχρονο process. */
const defaultSeenTxHashes = new Set<string>();
const MAX_SEEN_TX_HASHES = 5_000;

export async function runGmgnSmartMoneyCycle(
  options: GmgnSmartMoneyOptions = {},
): Promise<GmgnSmartMoneyResult> {
  const version = logicVersion(PHASE1_THRESHOLDS);
  const seen = options.seenTxHashes ?? defaultSeenTxHashes;

  const openTrades = await countOpenTrades();
  if (openTrades >= WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE) {
    return { version, tradesFetched: 0, newTrades: 0, signalsRecorded: 0 };
  }

  const trades = await fetchSmartMoneyTrades({ side: 'buy' });
  const fresh = filterNewSmartMoneyTrades(trades, seen);
  rememberSeen(seen, trades);

  if (fresh.length === 0) {
    return { version, tradesFetched: trades.length, newTrades: 0, signalsRecorded: 0 };
  }

  const gated = await findPassedTokens(
    fresh.map((trade) => trade.tokenAddress),
    version,
  );

  let signalsRecorded = 0;
  // Βλ. σχόλιο πάνω από τη function: μόλις ΕΝΑ holders call πάρει 429 μέσα σε αυτόν τον
  // κύκλο, σταματάμε τελείως να δοκιμάζουμε άλλα — το ίδιο shared cooldown/ban ισχύει για
  // όλα, οπότε ξαναδοκιμή σε trade #2, #3... θα το επέκτεινε κατά 5s το καθένα χωρίς λόγο.
  // Το `recordSignal` ΔΕΝ σταματάει γι' αυτό — μόνο το προαιρετικό holders-enrichment.
  let rateLimitedThisCycle = false;

  for (const trade of fresh) {
    const gateSnapshot = gated.get(trade.tokenAddress);
    if (gateSnapshot === undefined) continue; // δεν έχει (ακόμα) περάσει το gate

    const rawEntryPrice = toNumberOrNull(gateSnapshot['price'], 'gate_snapshot.price');
    const entryPrice = rawEntryPrice === null ? null : applyEntrySlippage(rawEntryPrice, PAPER_ASSUMED_SLIPPAGE_PCT);
    const simulatedEntryAmountSol = PAPER_BANKROLL_SOL * PAPER_POSITION_SIZE_PCT;

    let holderRisk: HolderRiskSnapshot = HOLDER_RISK_NOT_CHECKED;
    if (!rateLimitedThisCycle) {
      const result = await tryComputeHolderRisk(trade.tokenAddress);
      holderRisk = result.snapshot;
      if (result.rateLimited) rateLimitedThisCycle = true;
    }

    const recorded = await recordSignal(
      {
        tokenAddress: trade.tokenAddress,
        logicVersion: version,
        // Ξεχωριστό trigger_type από το δικό μας 'smart_money_buy' — επίτηδες, ώστε το
        // hit-rate αυτής της νέας, GMGN-wide πηγής να μετριέται ανεξάρτητα από τη δική
        // μας self-curated watchlist, όχι αναμεμιγμένο μαζί της.
        triggerType: 'gmgn_smartmoney',
        triggerWalletAddress: trade.makerAddress,
        triggerWalletSnapshot: {
          // Δεν έχουμε win_rate/pnl_multiplier/trade_count για ΑΥΤΟ το wallet — δεν
          // είναι στη δική μας watchlist, δεν έχει σκοραριστεί ποτέ μέσω portfolio
          // stats. Καταγράφουμε ό,τι πράγματι ξέρουμε από το ίδιο το trade αντί να
          // γεμίσουμε ψευδή μηδενικά.
          source: 'gmgn_smartmoney',
          maker_tags: trade.makerTags,
          buy_amount_usd: trade.amountUsd,
          buy_price_usd: trade.priceUsd,
          buy_tx_hash: trade.transactionHash,
          buy_timestamp: trade.timestamp,
          // 2026-09-20 — προστέθηκε για να μπορέσουμε ΑΡΓΟΤΕΡΑ να ελέγξουμε αν αυτό
          // διαχωρίζει winners/losers (βλ. gmgn-track skill: "A wallet opening a full
          // new position signals high confidence" vs partial add). ΔΕΝ χρησιμοποιείται
          // ακόμα ως φίλτρο — πρώτα μαζεύουμε δεδομένα, μετά αποφασίζουμε. Σημασιολογία
          // ΑΝΤΙΣΤΡΟΦΗ από το follow-wallet: εδώ (kol/smartmoney) 0 = άνοιγμα/προσθήκη
          // θέσης, 1 = κλείσιμο/μείωση — βλ. trackSmartmoney.ts.
          is_open_or_close: trade.isOpenOrClose,
          // 2026-09-20 (proposal #5) — βλ. σχόλιο πάνω από τη function. `null` σημαίνει
          // "δεν ελέγχθηκε ή δεν αξιολογήθηκε" (rate limit, σφάλμα, ή degenerate float),
          // ΟΧΙ "καθαρό 0%" — μη φιλτράρεις σαν να ήταν αριθμός χωρίς να ελέγξεις πρώτα
          // ότι δεν είναι null.
          holder_risk_pct: holderRisk.riskPct,
          holder_risk_wallet_count: holderRisk.riskWalletCount,
          holder_risk_checked: holderRisk.checked,
        },
        decision: 'signal_logged',
        decisionReasonText: `GMGN smartmoney wallet ${short(trade.makerAddress)} αγόρασε ${trade.tokenSymbol ?? short(trade.tokenAddress)} — gate είχε περάσει`,
      },
      {
        tokenAddress: trade.tokenAddress,
        // ΠΑΝΤΑ log_only σε αυτό το πρώτο πέρασμα — βλ. σχόλιο πάνω από τη function.
        mode: 'log_only',
        intendedSizePct: PAPER_POSITION_SIZE_PCT,
        bankrollAtEntry: PAPER_BANKROLL_SOL,
        simulatedEntryPrice: entryPrice ?? 0,
        simulatedEntryAmountSol,
        assumedSlippagePct: PAPER_ASSUMED_SLIPPAGE_PCT,
        assumedLatencyMs: PAPER_ASSUMED_LATENCY_MS,
        conditionOrders: conditionOrdersJson(),
        // Η πραγματική on-chain στιγμή του smartmoney trade, ΟΧΙ now() — ίδιο σκεπτικό
        // με walletActivity.ts (σωστό 24ωρο timeout ακόμα και σε catch-up batches).
        entryAt: new Date(trade.timestamp * 1000),
      },
    );
    if (recorded !== null) {
      signalsRecorded += 1;
      if (options.realtimeConnection) {
        subscribeForNewTrade(options.realtimeConnection, trade.tokenAddress, trade.makerAddress);
      }
    }
  }

  return { version, tradesFetched: trades.length, newTrades: fresh.length, signalsRecorded };
}

interface HolderRiskSnapshot {
  riskPct: number | null;
  riskWalletCount: number | null;
  /** `false` σημαίνει "δεν έγινε καν προσπάθεια" (π.χ. ήδη rate-limited αυτόν τον κύκλο) —
   * ξεχωριστό από `riskPct === null` που μπορεί να σημαίνει "ελέγχθηκε αλλά degenerate
   * float / unassessable". Χρήσιμο ΑΡΓΟΤΕΡΑ όταν αναλύσουμε πόσο συχνά ο έλεγχος καν
   * τρέχει, πριν αποφασίσουμε αν το κόστος (weight 5/σήμα) αξίζει τον κόπο. */
  checked: boolean;
}

const HOLDER_RISK_NOT_CHECKED: HolderRiskSnapshot = {
  riskPct: null,
  riskWalletCount: null,
  checked: false,
};

/**
 * Best-effort holders-risk enrichment για proposal #5 — βλ. το μεγάλο σχόλιο πάνω από
 * `runGmgnSmartMoneyCycle`. ΠΟΤΕ δεν κάνει throw: κάθε σφάλμα (rate limit, malformed
 * response, οτιδήποτε) καταλήγει σε `HOLDER_RISK_NOT_CHECKED`, ώστε το καλούν `for` loop
 * να συνεχίσει κανονικά στο `recordSignal`. Το `rateLimited: true` λέει στο caller να μη
 * ξαναδοκιμάσει holders calls για το υπόλοιπο του κύκλου.
 */
async function tryComputeHolderRisk(
  tokenAddress: string,
): Promise<{ snapshot: HolderRiskSnapshot; rateLimited: boolean }> {
  try {
    const holders = await fetchAllTokenHolders({ tokenAddress });
    const float = computeFloatShare(holders);
    const normalCount = holders.filter((h) => h.addrType === 0).length;
    if (isFloatDegenerate(float, normalCount)) {
      return { snapshot: { riskPct: null, riskWalletCount: null, checked: true }, rateLimited: false };
    }
    const risk = computeRiskWalletPct(holders, float);
    return {
      snapshot: { riskPct: risk.riskPct, riskWalletCount: risk.riskWalletCount, checked: true },
      rateLimited: false,
    };
  } catch (error) {
    let rateLimited = false;
    try {
      rethrowIfRateLimited(error);
    } catch {
      rateLimited = true;
    }
    return { snapshot: HOLDER_RISK_NOT_CHECKED, rateLimited };
  }
}

/** Χωριστά από το fetch ώστε να τεσταρίζεται χωρίς δίκτυο — ίδιο μοτίβο με
 * filterNewBuys στο activity.ts. */
export function filterNewSmartMoneyTrades(
  trades: readonly SmartMoneyTrade[],
  seen: ReadonlySet<string>,
): SmartMoneyTrade[] {
  const result: SmartMoneyTrade[] = [];
  const dedupedThisBatch = new Set<string>();
  for (const trade of trades) {
    if (seen.has(trade.transactionHash) || dedupedThisBatch.has(trade.transactionHash)) continue;
    dedupedThisBatch.add(trade.transactionHash);
    result.push(trade);
  }
  return result;
}

function rememberSeen(seen: Set<string>, trades: readonly SmartMoneyTrade[]): void {
  for (const trade of trades) seen.add(trade.transactionHash);
  // Bound απλό/άκομψο (όχι LRU) αλλά αρκετό: όταν ξεπεράσει το cap, αδειάζει τελείως
  // και ξαναχτίζεται από το επόμενο fetch — στη χειρότερη περίπτωση μερικά ήδη-δει
  // trades ξαναπερνούν από το recordTrigger idempotent guard (βλ. σχόλιο πιο πάνω),
  // ποτέ διπλό trade.
  if (seen.size > MAX_SEEN_TX_HASHES) seen.clear();
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

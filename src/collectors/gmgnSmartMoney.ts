import { findPassedTokens, recordTrigger } from '../db/repositories/decisionLog.js';
import {
  GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE,
  GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS,
} from './intervals.js';
import { delay } from '../util/delay.js';
import { PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import { fetchSmartMoneyTrades, type SmartMoneyTrade } from '../gmgn/trackSmartmoney.js';
import {
  HOLDER_RISK_NOT_CHECKED,
  isHighHolderRisk,
  tryComputeHolderRisk,
  type HolderRiskSnapshot,
} from '../decision/holderRiskCheck.js';

/**
 * ⛔ ΣΤΑΜΑΤΗΜΕΝΟ 2026-09-29 (ρητή απόφαση χρήστη): δεν είναι πια στον scheduler (main.ts).
 * Από 2026-09-27 δεν άνοιγε trades, άρα δεν παρήγαγε μετρήσιμο αποτέλεσμα, ενώ έτρωγε
 * GMGN budget (έως ~60 weight/30″). Η μόνη χρήσιμη λειτουργία του, το holder-risk φίλτρο,
 * μεταφέρθηκε στις realtime/live αγορές (decision/holderRiskCheck.ts). Ο κώδικας μένει ως
 * αναφορά.
 *
 * Δεύτερο, ανεξάρτητο trigger-κανάλι πλάι στο layer 3 (walletActivity.ts /
 * realtimeEntryHandler.ts) — `track smartmoney`, GMGN's ΔΙΚΑ ΤΟΥ tagged smart-money/whale
 * wallets, ΟΧΙ η δική μας self-curated watchlist. CLAUDE.md το είχε ρητά σημειώσει ως
 * "παραμένει open/unimplemented" (layer 2 σχόλιο) — αυτό είναι η πρώτη υλοποίηση.
 *
 * Weight 1 ΣΥΝΟΛΙΚΑ ανά κύκλο (όχι ανά wallet, βλ. routes.ts) — πολύ φθηνότερο από το
 * layer 3 (weight 3/wallet/κύκλο), γι' αυτό μπορεί να τρέχει συχνά χωρίς να πιέζει το
 * shared 20/s bucket. (Αυτό ίσχυε για το ΒΑΣΙΚΟ `track smartmoney` call — βλ. ΚΑΙ το
 * holder-risk enrichment πιο κάτω, που έχει ΔΙΚΟ ΤΟΥ, πολύ μεγαλύτερο weight budget.)
 *
 * ΜΟΝΟ decision_log, ΚΑΝΕΝΑ trade (αλλαγή 2026-09-27, ρητή απόφαση χρήστη — πριν άνοιγε
 * mode='log_only' paper trade ανά σήμα). Δικό του trigger_type: 'gmgn_smartmoney',
 * διαφορετικό από το δικό μας 'smart_money_buy', ώστε τα σήματα να μετριούνται ξεχωριστά.
 * Trades ανοίγει πλέον ΜΟΝΟ το realtime/live path (handleRealtimeEntryEvent), με paper
 * fallback όταν δεν γίνεται live.
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
 * -ανά-κύκλο του ίδιου του καναλιού, γι' αυτό ΔΕΝ μπλοκάρει ποτέ το `recordTrigger`: μια
 * αποτυχία εδώ (rate limit, ή οποιοδήποτε άλλο σφάλμα) καταγράφεται ως `null` στο snapshot
 * και το σήμα προχωράει κανονικά — το holders-check είναι καθαρά προαιρετική εμπλουτισμένη
 * καταγραφή, όχι κρίσιμο μονοπάτι για το `recordTrigger`. ΠΑΡΟΛΑ ΑΥΤΑ αυτό ΕΙΝΑΙ loop πάνω σε
 * πολλά (fresh) trades στον ίδιο κύκλο — αν το πρώτο holders call πάρει 429, το ίδιο
 * `SharedCooldown`/ban ισχύει και για τα επόμενα, οπότε ΔΕΝ ξαναδοκιμάζουμε holders calls
 * μέσα στον ίδιο κύκλο μετά το πρώτο rate-limit hit (`rateLimitedThisCycle` flag πιο κάτω)
 * — ίδιο πνεύμα με το `rethrowIfRateLimited` guard, προσαρμοσμένο ώστε να μη σταματάει
 * ολόκληρο τον κύκλο (το `recordTrigger` για τα υπόλοιπα trades πρέπει να συνεχίσει).
 *
 * **Cap ανά κύκλο (2026-09-23)** — βλ. `GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE` στο
 * intervals.ts για το πλήρες incident: pacing από μόνο του ΔΕΝ αρκούσε, γιατί δε μειώνει
 * το ΣΥΝΟΛΙΚΟ weight που ζητάει ένας κύκλος από τον shared, process-wide `TokenBucket` —
 * κύκλοι με 44-50 φρέσκα trades συνέχισαν να πυροδοτούν 429 σε ΠΟΛΛΑΠΛΑ, άσχετα routes
 * ακόμα και μετά το pacing fix. Μόνο τα πρώτα `GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE`
 * φρέσκα, gate-passed trades παίρνουν holder-risk enrichment· τα υπόλοιπα καταγράφονται
 * κανονικά με `holder_risk_checked: false` (`holderRiskChecksUsed` counter πιο κάτω).
 *
 * **Holder-risk ΦΙΛΤΡΟ εισόδου — ενεργοποιήθηκε 2026-09-22** (`HOLDER_RISK_MAX_PCT`):
 * μετά από 2 μέρες πραγματικής καταγραφής (1136 κλειστά σήματα), το `holder_risk_pct`
 * έδειξε καθαρή, μονότονη σχέση με το αποτέλεσμα: <10% risk → avg pnl +10.5% (35
 * δείγματα), 10-30% → -53.4% (110), 30-50% → -86.2% (272), **≥50% → -92.9% με μόλις
 * 1.7% win rate (460 δείγματα, το πιο συχνό bucket)**. Ρητή απόφαση χρήστη: αποκλεισμός
 * σημάτων με `riskPct >= 0.50`, ΠΡΙΝ το `recordTrigger` — δεν καταγράφονται καν στη βάση
 * (differs από το `is_open_or_close`, που παραμένει ΜΟΝΟ καταγραφή, καμία αλλαγή εκεί).
 * `null`/`not checked` (rate limit, σφάλμα, degenerate float, ~256/1136 = 23% του
 * δείγματος) ΔΕΝ αποκλείεται — απουσία στοιχείων δεν είναι απόδειξη κινδύνου, και το
 * φιλτράρισμα δεν πρέπει να εξαρτάται από το αν ένα rate-limit hit συνέβη νωρίτερα στον
 * κύκλο. Θα ξαναδούμε το threshold (π.χ. αυστηρότερο <30%) μετά από μία ακόμα μέρα με
 * το φίλτρο ενεργό, ίδιο μοτίβο συλλογής-πρώτα με τα υπόλοιπα σήματα αυτού του καναλιού.
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
// 2026-09-29: το holder-risk μετακόμισε στο decision/holderRiskCheck.ts (το χρησιμοποιούν
// πλέον οι realtime/live αγορές). Re-export για συμβατότητα.
export { HOLDER_RISK_MAX_PCT, isHighHolderRisk } from '../decision/holderRiskCheck.js';

export interface GmgnSmartMoneyOptions {
  limit?: number;
  /** Test-only override· production παίρνει πάντα φρέσκο module-level Set. */
  seenTxHashes?: Set<string>;
}

export interface GmgnSmartMoneyResult {
  version: string;
  tradesFetched: number;
  newTrades: number;
  signalsRecorded: number;
  /** Πόσα φρέσκα, gate-passed σήματα κόπηκαν λόγω `holder_risk_pct >= HOLDER_RISK_MAX_PCT`
   * σε αυτόν τον κύκλο — καθόλου καταγεγραμμένα στη βάση, μόνο εδώ για παρατηρησιμότητα. */
  skippedHighRisk: number;
  /** Πόσα πραγματικά holder-risk (`token holders`) calls έγιναν αυτόν τον κύκλο — βλ.
   * `GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE` στο intervals.ts. Αν αυτό φτάνει
   * σταθερά το cap ενώ `newTrades` είναι πολύ μεγαλύτερο, το cap ίσως χρειάζεται
   * αναπροσαρμογή — γι' αυτό εκτίθεται εδώ αντί να μείνει εσωτερικό counter. */
  holderRiskChecksUsed: number;
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

  const trades = await fetchSmartMoneyTrades({ side: 'buy' });
  const fresh = filterNewSmartMoneyTrades(trades, seen);
  rememberSeen(seen, trades);

  if (fresh.length === 0) {
    return {
      version,
      tradesFetched: trades.length,
      newTrades: 0,
      signalsRecorded: 0,
      skippedHighRisk: 0,
      holderRiskChecksUsed: 0,
    };
  }

  const gated = await findPassedTokens(
    fresh.map((trade) => trade.tokenAddress),
    version,
  );

  let signalsRecorded = 0;
  let skippedHighRisk = 0;
  // Βλ. σχόλιο πάνω από τη function: μόλις ΕΝΑ holders call πάρει 429 μέσα σε αυτόν τον
  // κύκλο, σταματάμε τελείως να δοκιμάζουμε άλλα — το ίδιο shared cooldown/ban ισχύει για
  // όλα, οπότε ξαναδοκιμή σε trade #2, #3... θα το επέκτεινε κατά 5s το καθένα χωρίς λόγο.
  // Το `recordTrigger` ΔΕΝ σταματάει γι' αυτό — μόνο το προαιρετικό holders-enrichment.
  let rateLimitedThisCycle = false;
  // ΝΕΟ 2026-09-23 — βλ. σχόλιο "Cap ανά κύκλο" πάνω από τη function. Bound στο ΣΥΝΟΛΙΚΟ
  // αριθμό πραγματικών holders calls, όχι μόνο στην παύση ανάμεσά τους.
  let holderRiskChecksUsed = 0;

  for (const trade of fresh) {
    const gateSnapshot = gated.get(trade.tokenAddress);
    if (gateSnapshot === undefined) continue; // δεν έχει (ακόμα) περάσει το gate

    let holderRisk: HolderRiskSnapshot = HOLDER_RISK_NOT_CHECKED;
    if (!rateLimitedThisCycle && holderRiskChecksUsed < GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE) {
      holderRiskChecksUsed += 1;
      const result = await tryComputeHolderRisk(trade.tokenAddress);
      holderRisk = result.snapshot;
      if (result.rateLimited) rateLimitedThisCycle = true;
      // ΝΕΟ 2026-09-23 (real incident, βλ. GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS στο
      // intervals.ts): παύση ΜΕΤΑ από κάθε πραγματική κλήση — όχι όταν ήδη
      // rateLimitedThisCycle (δε στέλνουμε τίποτα τότε, καμία ανάγκη καθυστέρησης) και
      // όχι πριν την ΠΡΩΤΗ κλήση. Ίδιο pattern με WALLET_SCORING_LOOP_PACING_MS/
      // WALLET_ACTIVITY_LOOP_PACING_MS — πολλά διαδοχικά weight-5 calls χωρίς παύση
      // (παρατηρήθηκαν κύκλοι με 45 φρέσκα trades) προκαλούσαν RATE_LIMIT_BANNED σε
      // πολλαπλά, άσχετα routes ταυτόχρονα.
      await delay(GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS);
    }

    if (isHighHolderRisk(holderRisk.riskPct)) {
      skippedHighRisk += 1;
      continue;
    }

    const recorded = await recordTrigger({
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
      });
    // ΑΛΛΑΓΗ 2026-09-27 (ρητή απόφαση χρήστη): ΜΟΝΟ decision_log, ΚΑΝΕΝΑ paper_trades row
    // (πριν: log_only trade + websocket subscribe ανά σήμα). Το row μένει με
    // linked_trade_id NULL, άρα αν το ίδιο token το αγοράσει wallet της δικής μας
    // watchlist, το realtime/live path (recordTrigger στο handleRealtimeEntryEvent) μπορεί
    // ακόμα να το κάνει claim — πριν, ένα log_only trade εδώ "έκλεβε" το token από το live.
    if (recorded !== null) signalsRecorded += 1;
  }

  return {
    version,
    tradesFetched: trades.length,
    newTrades: fresh.length,
    signalsRecorded,
    skippedHighRisk,
    holderRiskChecksUsed,
  };
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

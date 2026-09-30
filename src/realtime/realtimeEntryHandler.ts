import { findPassedTokens, recordTrigger, linkTrade } from '../db/repositories/decisionLog.js';
import {
  openTrade,
  countOpenLiveOrPaperTrades,
  countOpenTradesForToken,
  setNativeOrderState,
} from '../db/repositories/paperTrades.js';
import { getWallet, type WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import { insertRealtimeEntrySkip } from '../db/repositories/realtimeEntrySkips.js';
import { logicVersion, PHASE1_THRESHOLDS } from '../decision/gateConfig.js';
import { applyEntrySlippage } from '../decision/pnl.js';
import {
  PAPER_ASSUMED_LATENCY_MS,
  PAPER_ASSUMED_SLIPPAGE_PCT,
  PAPER_BANKROLL_SOL,
  PAPER_POSITION_SIZE_PCT,
  LIVE_BANKROLL_SOL,
  LIVE_POSITION_SIZE_PCT,
  LIVE_POSITION_SIZE_SOL,
  LIVE_ON_GRADUATED_TOKENS,
  LIVE_ON_DEMAND_GATE,
  HOLDER_RISK_ENTRY_MODE,
  conditionOrdersJson,
  liveExitConditionOrders,
} from '../decision/paperTradingConfig.js';
import { WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE } from '../collectors/intervals.js';
import {
  attemptLiveEntry,
  fallbackOutcomeFor,
  type LiveEntryOutcome,
  type LiveEntryTiming,
} from '../live/liveEntryExecution.js';
import {
  isGraduatedEvent,
  priceFromTradeEvent,
  REALTIME_SOURCE_CHANNEL,
  type PumpPortalTradeEvent,
} from './pumpportalEvents.js';
import { subscribeForNewTrade } from './subscriptionManager.js';
import { tryOnDemandGate } from './onDemandGateRunner.js';
import { attachNativeStrategy } from '../live/nativeStrategyAttach.js';
import { isHighHolderRisk, tryComputeHolderRisk, type HolderRiskSnapshot } from '../decision/holderRiskCheck.js';
import { ON_DEMAND_GATE_PRIORITY, type HolderRiskMode } from '../decision/paperTradingConfig.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';
import type { TradeMode } from '../db/types.js';

export interface RealtimeEntryResult {
  tokenAddress: string;
  walletAddress: string;
  walletName: string | null;
  entryPrice: number;
  /** ΔΙΟΡΘΩΣΗ 2026-09-18: true όταν αυτή η προσπάθεια μόλις ενεργοποίησε το live
   * kill-switch — βλ. LiveEntryOutcome.killSwitchJustTriggered. Ο caller (main.ts) το
   * χρησιμοποιεί για proactive Telegram alert, αντί ο χρήστης να το μαθαίνει μόνο από το
   * επόμενο daily digest. */
  killSwitchJustTriggered: boolean;
  /** 'live' ή 'paper' — για να φαίνεται αμέσως στο Telegram τι πραγματικά μπήκε. */
  mode: TradeMode;
  /** Graduated token (paper-only δοκιμή όσο LIVE_ON_GRADUATED_TOKENS=false). */
  graduated: boolean;
  /** Live χωρίς επιβεβαιωμένο native GMGN order = χωρίς server-side stop-loss/trailing. */
  nativeOrderVerified: boolean;
  /** Μπήκε μέσω on-demand gate (2026-09-28) — βλ. decision/onDemandGate.ts. */
  onDemandGate: boolean;
}

/** Από πού ήρθε το «πέρασε το gate» ενός σήματος. */
export type GateSource = 'discovery' | 'on_demand';

/** 2026-09-28 — χρόνοι της διαδρομής σήμα → trade (βλ. entry_timing_json, migration 0019). */
interface EntryTimeline {
  receivedAt: number;
  lookupMs: number;
  onDemandGateMs: number | null;
}

export type EntryWalletInput = Pick<
  WatchlistWallet,
  'address' | 'active' | 'winRate' | 'pnlMultiplier' | 'tradeCount' | 'source' | 'name'
> | null;

export type EntryDecision =
  | { type: 'skip' }
  | {
      type: 'enter';
      entryPrice: number;
      /** Το token έχει ήδη φύγει από τη bonding curve — τιμή από solAmount/tokenAmount,
       * και (όσο LIVE_ON_GRADUATED_TOKENS=false) μόνο paper. Βλ. handleRealtimeEntryEvent. */
      graduated: boolean;
    };

/**
 * Καθαρή απόφαση — τεσταρίζεται πλήρως χωρίς DB, ίδιο σκεπτικό με το decideForTick στο
 * realtimeExitHandler.ts. Η ΕΚΤΕΛΕΣΗ (fetches, recordSignal, subscribe) ζει στο
 * handleRealtimeEntryEvent παρακάτω.
 */
export function decideEntry(
  event: PumpPortalTradeEvent,
  wallet: EntryWalletInput,
  gateSnapshotExists: boolean,
  openTradesCount: number,
): EntryDecision {
  if (event.txType !== 'buy') return { type: 'skip' };
  // Άμυνα: το wallet θα μπορούσε να έχει απενεργοποιηθεί (auto-lifecycle) ΑΦΟΥ κάναμε
  // subscribe αλλά ΠΡΙΝ φτάσει αυτό το event — δεν το ξανααφαιρούμε ποτέ από τη
  // συνδρομή, άρα ο έλεγχος εδώ είναι απαραίτητος.
  if (wallet === null || !wallet.active) return { type: 'skip' };
  if (!gateSnapshotExists) return { type: 'skip' }; // δεν έχει (ακόμα) περάσει το gate
  if (openTradesCount >= WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE) return { type: 'skip' };

  const entryPrice = priceFromTradeEvent(event);
  // null: dust trade σε graduated token ή degenerate event — από 2026-09-27 τα graduated
  // tokens έχουν κανονικά τιμή (βλ. priceFromTradeEvent).
  if (entryPrice === null) return { type: 'skip' };

  return { type: 'enter', entryPrice, graduated: isGraduatedEvent(event) };
}

/**
 * Η websocket αντιστοιχία του wallet-activity.ts's core λογικής — "ένα (ενεργό) wallet
 * μόλις αγόρασε ένα ήδη-gated token" — αλλά ΧΩΡΙΣ κανένα GMGN call τη στιγμή του
 * γεγονότος. Το gate check είναι απλό DB lookup (το discovery loop, ΠΑΡΑΜΕΝΕΙ GMGN-based,
 * έχει ήδη γράψει το αποτέλεσμα στο decision_log).
 *
 * Η τιμή εισόδου είναι η ΠΡΑΓΜΑΤΙΚΗ, στιγμιαία τιμή από το ίδιο το event
 * (`priceFromTradeEvent`) — ΟΧΙ το gate_snapshot's τιμή (που θα μπορούσε να είναι
 * λεπτά/ώρες παλιά). Σκόπιμη βελτίωση σε σχέση με το wallet-activity.ts.
 *
 * ΠΡΩΤΗ ΠΡΑΓΜΑΤΙΚΗ ΣΥΝΔΕΣΗ σε live trading (2026-09-15). Η σειρά είναι σκόπιμη και
 * ΚΡΙΣΙΜΗ για ασφάλεια:
 *   1. `recordTrigger` ΠΡΩΤΑ — claim το decision_log row, γρήγορο, καμία εξωτερική κλήση.
 *   2. `attemptLiveEntry` ΜΕΤΑ — το πραγματικό swap (έως ~30s), ΕΚΤΟΣ οποιουδήποτε lock.
 *   3. `openTrade` + `linkTrade` — ανοίγει το trade με ό,τι πραγματικά συνέβη.
 * Ποτέ αντίστροφα: αν εκτελούσαμε το swap ΠΡΙΝ το claim, ένα επιτυχημένο live buy θα
 * μπορούσε να μείνει χωρίς κανένα trade row να το καταγράφει (race στο claim) — σιωπηλά
 * χαμένη, ξοδεμένη θέση.
 */
/**
 * Tokens με entry σε εξέλιξη ΤΩΡΑ (από το recordTrigger μέχρι το openTrade/linkTrade).
 *
 * ΠΡΑΓΜΑΤΙΚΟ INCIDENT 2026-09-28: 4 tokens αγοράστηκαν live 2-3 φορές μέσα σε δευτερόλεπτα
 * (π.χ. 6474/6475 με 150ms διαφορά, 6466/6467/6468 στο ίδιο token). Το decision_log row
 * συνδέεται με το trade μόνο ΜΕΤΑ το swap (δευτερόλεπτα)· στο μεταξύ ένα δεύτερο wallet
 * του watchlist που αγόραζε το ίδιο token έκανε claim το ΙΔΙΟ row (το recordTrigger
 * ελέγχει ανοιχτό trade ανά wallet, όχι ανά token) και άνοιγε δεύτερη πραγματική θέση.
 * Ένα Node process (βλ. CLAUDE.md "Process topology") → ένα in-memory Set αρκεί ως lock.
 */
const entriesInFlight = new Set<string>();

/** Test-only: πόσα entries θεωρούνται σε εξέλιξη (για επιβεβαίωση ότι το lock ελευθερώνεται). */
export function entriesInFlightCount(): number {
  return entriesInFlight.size;
}

/**
 * Τρέχει το `fn` μόνο αν δεν τρέχει ήδη entry για το ίδιο token· αλλιώς επιστρέφει
 * `IN_FLIGHT` χωρίς να το καλέσει. Το lock ελευθερώνεται ΠΑΝΤΑ (και σε exception).
 */
export const IN_FLIGHT = Symbol('entry_in_flight');
export async function withTokenEntryLock<T>(mint: string, fn: () => Promise<T>): Promise<T | typeof IN_FLIGHT> {
  if (entriesInFlight.has(mint)) return IN_FLIGHT;
  entriesInFlight.add(mint);
  try {
    return await fn();
  } finally {
    entriesInFlight.delete(mint);
  }
}

/**
 * 2026-09-30 (migration 0022): κάθε αγορά ΔΙΚΟΥ ΜΑΣ wallet που δεν έγινε trade γράφεται στη
 * βάση με τον λόγο (πριν: μόνο console, χανόταν σε κάθε deploy). Best-effort, ποτέ δεν
 * καθυστερεί/σπάει το entry path. Αγορές τρίτων (token subscriptions) δεν γράφονται.
 */
export function recordEntrySkip(
  event: PumpPortalTradeEvent,
  reason: string,
  detail: Record<string, unknown> | null = null,
  insert: typeof insertRealtimeEntrySkip = insertRealtimeEntrySkip,
): void {
  void insert({
    walletAddress: event.traderPublicKey,
    tokenAddress: event.mint,
    reason,
    pool: event.pool ?? null,
    hasCurveData: event.vTokensInBondingCurve !== undefined && event.vSolInBondingCurve !== undefined,
    solAmount: Number.isFinite(event.solAmount) ? event.solAmount : null,
    marketCapSol: event.marketCapSol ?? null,
    detail,
  }).catch((error: unknown) => {
    console.error(`[realtime-entry-skip] αποθήκευση απέτυχε: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function handleRealtimeEntryEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeEntryResult | null> {
  if (event.txType !== 'buy') return null; // γρήγορη έξοδος, αποφεύγει τα παρακάτω DB calls
  const receivedAt = Date.now();

  const wallet = await getWallet(event.traderPublicKey);
  // 2026-09-30 (ρητή απόφαση χρήστη): τα mirror wallets τα χειρίζεται ΜΟΝΟ το mirror route
  // (src/mirror/) — καμία κανονική θέση argus από τα σήματά τους, ούτε καταγραφή skip.
  if (wallet?.copyMode === 'mirror') return null;
  const version = logicVersion(PHASE1_THRESHOLDS);
  let gateSnapshotExists = (await findPassedTokens([event.mint], version)).has(event.mint);
  // ΜΟΝΟ live/paper — τα παλιά log_only δεν πρέπει να κόβουν live entries (βλ. countOpenLiveOrPaperTrades).
  const openTradesCount = await countOpenLiveOrPaperTrades();
  const timeline: EntryTimeline = { receivedAt, lookupMs: Date.now() - receivedAt, onDemandGateMs: null };

  // 2026-09-28 — on-demand gate: το token δεν έχει (ακόμα) περάσει το gate του discovery,
  // αλλά όλα τα άλλα κριτήρια ισχύουν → έλεγχος εκείνη τη στιγμή, αντί να χάσουμε τη
  // (συνήθως πρώτη και φτηνότερη) αγορά του wallet. ΜΟΝΟ σε bonding-curve tokens: τα
  // graduated είναι εξ ορισμού ήδη «αργά». Βλ. decision/onDemandGate.ts.
  let gateSource: GateSource = 'discovery';
  let onDemandOutcome: string = 'not_run';
  if (
    !gateSnapshotExists &&
    !isGraduatedEvent(event) &&
    decideEntry(event, wallet, true, openTradesCount).type === 'enter'
  ) {
    const onDemandStartedAt = Date.now();
    const outcome = await tryOnDemandGate(event.mint, version);
    onDemandOutcome = outcome;
    timeline.onDemandGateMs = Date.now() - onDemandStartedAt;
    if (outcome === 'passed') {
      gateSnapshotExists = true;
      gateSource = 'on_demand';
    }
  }

  const decision = decideEntry(event, wallet, gateSnapshotExists, openTradesCount);
  if (decision.type === 'skip') {
    // 2026-09-24 — διαγνωστικό: το decideEntry (σκόπιμα pure, βλ. tests) γυρνάει μόνο
    // {type:'skip'}, χωρίς λόγο — καμία από τις 5 περιπτώσεις του δεν άφηνε ίχνος στα
    // logs. Όταν το smart_money_buy trigger_type σταμάτησε τελείως (0 σε 20+ ώρες), δεν
    // μπορούσαμε να ξεχωρίσουμε "τα events δεν φτάνουν" από "φτάνουν αλλά σκοντάφτουν
    // εδώ" — π.χ. το πιο πιθανό ύποπτο, ένα token που ένα wallet μόλις αγόρασε αλλά το
    // δικό μας discovery δεν το έχει (ακόμα) περάσει από το gate. Καθαρά παρατηρησιακό,
    // ΔΕΝ αλλάζει τη decideEntry λογική/tests.
    const reason =
      wallet === null
        ? 'wallet_unknown'
        : !wallet.active
          ? 'wallet_inactive'
          : !gateSnapshotExists
            ? 'gate_not_passed'
            : openTradesCount >= WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE
              ? 'open_trades_cap'
              : 'no_realtime_price';
    console.log(
      `[realtime-entry-skip] reason=${reason} mint=${event.mint.slice(0, 8)} ` +
        `wallet=${event.traderPublicKey.slice(0, 8)}`,
    );
    if (wallet !== null) {
      recordEntrySkip(event, reason, { on_demand: onDemandOutcome, graduated_event: isGraduatedEvent(event) });
    }
    return null;
  }
  // TS δε στενεύει το `wallet` μέσω του decideEntry (ξεχωριστή function) — αλλά
  // decision.type==='enter' εγγυάται ήδη ότι wallet!==null (βλ. decideEntry).
  if (wallet === null) return null;

  // 2026-09-29 (ρητή απόφαση χρήστη): graduated tokens → τίποτα, ούτε paper.
  if (decision.graduated && !LIVE_ON_GRADUATED_TOKENS) {
    console.log(`[realtime-entry-skip] reason=graduated_off mint=${event.mint.slice(0, 8)} wallet=${event.traderPublicKey.slice(0, 8)}`);
    recordEntrySkip(event, 'graduated_off', { gate_source: gateSource });
    return null;
  }

  // 2026-09-28: ΕΝΑ trade ανά token — βλ. entriesInFlight. Πρώτα το in-memory lock (πιάνει
  // ταυτόχρονα events), μετά η βάση (πιάνει ένα νέο event όσο το trade είναι ακόμα ανοιχτό).
  const result = await withTokenEntryLock(event.mint, async () => {
    if ((await countOpenTradesForToken(event.mint)) > 0) {
      console.log(`[realtime-entry-skip] reason=token_already_open mint=${event.mint.slice(0, 8)} wallet=${event.traderPublicKey.slice(0, 8)}`);
      recordEntrySkip(event, 'token_already_open');
      return null;
    }
    return enterClaimedSignal(event, connection, wallet, decision, version, gateSource, timeline);
  });
  if (result === IN_FLIGHT) {
    console.log(`[realtime-entry-skip] reason=entry_in_flight mint=${event.mint.slice(0, 8)} wallet=${event.traderPublicKey.slice(0, 8)}`);
    recordEntrySkip(event, 'entry_in_flight');
    return null;
  }
  return result;
}

async function enterClaimedSignal(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
  wallet: WatchlistWallet,
  decision: Extract<EntryDecision, { type: 'enter' }>,
  version: string,
  gateSource: GateSource,
  timeline: EntryTimeline,
): Promise<RealtimeEntryResult | null> {
  // 2026-09-29 — holder risk (βλ. HOLDER_RISK_ENTRY_MODE). 'block': πριν από οτιδήποτε·
  // 'record': παράλληλα με την αγορά, το αποτέλεσμα γράφεται στο entry_timing_json.
  const holderRiskStartedAt = Date.now();
  const holderRiskPromise = tryComputeHolderRisk(event.mint, { priority: ON_DEMAND_GATE_PRIORITY }).then((r) => ({
    snapshot: r.snapshot,
    ms: Date.now() - holderRiskStartedAt,
  }));
  const holderRiskMode = HOLDER_RISK_ENTRY_MODE[gateSource];
  if (holderRiskMode === 'block') {
    const hr = await holderRiskPromise;
    if (isHighHolderRisk(hr.snapshot.riskPct)) {
      console.log(
        `[realtime-entry-skip] reason=holder_risk_high gate=${gateSource} risk=${(hr.snapshot.riskPct ?? 0).toFixed(2)} ` +
          `mint=${event.mint.slice(0, 8)} wallet=${event.traderPublicKey.slice(0, 8)}`,
      );
      recordEntrySkip(event, 'holder_risk_high', { gate_source: gateSource, risk_pct: hr.snapshot.riskPct });
      return null;
    }
  }

  const claimStartedAt = Date.now();
  const decisionLogId = await recordTrigger({
    tokenAddress: event.mint,
    logicVersion: version,
    triggerType: 'smart_money_buy',
    triggerWalletAddress: wallet.address,
    triggerWalletSnapshot: {
      win_rate: wallet.winRate,
      pnl_multiplier: wallet.pnlMultiplier,
      trade_count: wallet.tradeCount,
      source: wallet.source,
      // Το PumpPortal δίνει SOL-denominated ποσά, ΟΧΙ USD (σε αντίθεση με το GMGN) —
      // κρατάμε ό,τι πραγματικά έχουμε, χωρίς να το παρουσιάζουμε σαν USD.
      buy_cost_sol: event.solAmount,
      buy_tx_hash: event.signature,
      buy_timestamp: Math.floor(Date.now() / 1000),
      source_channel: REALTIME_SOURCE_CHANNEL,
      // 2026-09-27 — για το `npm run graduated-report`: ξεχωρίζει τα σήματα σε ήδη
      // αποφοιτημένα tokens (paper-only δοκιμή) από τα κανονικά bonding-curve σήματα.
      token_stage: decision.graduated ? 'graduated' : 'bonding_curve',
      entry_price_source: decision.graduated ? 'trade_sol_over_tokens' : 'bonding_curve_reserves',
      // 2026-09-28 — για το `npm run on-demand-gate-report`.
      gate_source: gateSource,
    },
    decision: 'signal_logged',
    decisionReasonText:
      `${wallet.source} wallet ${wallet.address} αγόρασε (realtime) — gate είχε περάσει` +
      (decision.graduated ? ' — graduated token' : ''),
  });
  if (decisionLogId === null) {
    // π.χ. race με ήδη υπάρχον ανοιχτό trade στο ίδιο ζευγάρι
    recordEntrySkip(event, 'claim_failed', { gate_source: gateSource });
    return null;
  }

  // 2026-09-27: σε graduated token, live ΜΟΝΟ αν LIVE_ON_GRADUATED_TOKENS — αλλιώς
  // κατευθείαν paper, χωρίς καν να αγγίξουμε κεφάλαιο/risk gate/swap.
  const claimMs = Date.now() - claimStartedAt;
  const liveStartedAt = Date.now();
  const live =
    decision.graduated && !LIVE_ON_GRADUATED_TOKENS
      ? fallbackOutcomeFor('graduated_paper_only')
      : gateSource === 'on_demand' && !LIVE_ON_DEMAND_GATE
        ? fallbackOutcomeFor('on_demand_gate_paper_only')
        : await attemptLiveEntry(event.mint);
  // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #3): το live.entryPrice είναι ΗΔΗ η πραγματική,
  // εκτελεσμένη τιμή — καμία προσομοίωση δε χρειάζεται ή πρέπει να εφαρμοστεί εκεί. Η
  // ωμή, παρατηρημένη τιμή του σήματος (decision.entryPrice) εφαρμόζεται ΜΟΝΟ όταν η
  // θέση είναι paper/log_only — βλ. applyEntrySlippage στο pnl.ts.
  const finalEntryPrice =
    live.entryPrice ?? applyEntrySlippage(decision.entryPrice, PAPER_ASSUMED_SLIPPAGE_PCT);
  const liveAttemptMs = Date.now() - liveStartedAt;
  const holderRisk = await holderRiskPromise;
  const entryTiming = {
    ...buildEntryTiming(event, decision, gateSource, timeline, claimMs, liveAttemptMs, live),
    holder_risk: holderRiskJson(holderRisk.snapshot, holderRisk.ms, holderRiskMode),
  };
  logEntryTiming(event.mint, entryTiming);

  const tradeId = await openTrade({
    decisionLogId,
    tokenAddress: event.mint,
    mode: live.mode,
    intendedSizePct: live.mode === 'live' ? LIVE_POSITION_SIZE_PCT : PAPER_POSITION_SIZE_PCT,
    bankrollAtEntry: live.mode === 'live' ? LIVE_BANKROLL_SOL : PAPER_BANKROLL_SOL,
    simulatedEntryPrice: finalEntryPrice,
    simulatedEntryAmountSol:
      live.mode === 'live' ? (live.actualEntryAmountSol ?? LIVE_POSITION_SIZE_SOL) : PAPER_BANKROLL_SOL * PAPER_POSITION_SIZE_PCT,
    actualEntryAmountSol: live.mode === 'live' ? (live.actualEntryAmountSol ?? undefined) : undefined,
    assumedSlippagePct: PAPER_ASSUMED_SLIPPAGE_PCT,
    assumedLatencyMs: PAPER_ASSUMED_LATENCY_MS,
    // live: ό,τι ΠΡΑΓΜΑΤΙΚΑ περάσαμε στο swap --condition-orders (βλ.
    // liveEntryExecution.ts) — καταγραφή του τι ζητήθηκε, ΟΧΙ αν επιβεβαιώθηκε υγιές
    // (αυτό ζει στο native_order_active). paper/log_only: το ίδιο theoretical plan όπως
    // πριν, άσχετο με τη σημερινή αλλαγή.
    conditionOrders: live.mode === 'live' ? liveExitConditionOrders() : conditionOrdersJson(),
    entryAt: new Date(), // πραγματικό realtime event — "τώρα" ΕΙΝΑΙ η πραγματική στιγμή
    entryTiming,
  });
  await linkTrade(decisionLogId, tradeId);
  // 2026-09-30 (ρητή απόφαση χρήστη): νέα trades ΔΕΝ ανοίγουν πια shadows. Το 4B βγήκε
  // χειρότερο (trailing-shadow-report) και το «χωρίς exit_signal» είναι πλέον η πραγματική
  // λογική (EXIT_ON_COPIED_WALLET_SELL=false). Όσα shadows είναι ήδη ανοιχτά τελειώνουν
  // κανονικά (≤ 24h) — τα reports μένουν για το ιστορικό.
  if (live.mode === 'live') {
    await setNativeOrderState(tradeId, {
      liveStrategyOrderId: live.liveStrategyOrderId,
      nativeOrderActive: live.nativeOrderVerified,
    });
    // 2026-09-29: το native strategy δημιουργείται ΜΕΤΑ το swap response — το βρίσκουμε στο
    // παρασκήνιο (βλ. live/nativeStrategyAttach.ts). Χωρίς αυτό ο reconciler δεν έβλεπε
    // ποτέ τις πωλήσεις του GMGN και τα trades έμεναν «ανοιχτά».
    if (!live.nativeOrderVerified && live.walletAddress !== null) {
      void attachNativeStrategy(tradeId, live.walletAddress, event.mint, liveStartedAt);
    }
  }

  subscribeForNewTrade(connection, event.mint, wallet.address);

  return {
    tokenAddress: event.mint,
    walletAddress: wallet.address,
    walletName: wallet.name,
    entryPrice: finalEntryPrice,
    killSwitchJustTriggered: live.killSwitchJustTriggered,
    mode: live.mode,
    graduated: decision.graduated,
    nativeOrderVerified: live.nativeOrderVerified,
    onDemandGate: gateSource === 'on_demand',
  };
}

/**
 * 2026-09-28 — το περιεχόμενο του paper_trades.entry_timing_json (migration 0019). Σταθερά
 * ονόματα: τα διαβάζει το scripts/entry-speed-report.ts.
 *  - signal.price: η τιμή της αγοράς του wallet μας (ωμή, χωρίς paper slippage).
 *  - executed_price / slippage_vs_signal: μόνο live — πόσο χειρότερα αγοράσαμε από αυτό.
 *  - ms.*: χρόνοι ανά βήμα· ms.event_to_insert = από τη λήψη του event ως το INSERT του trade.
 *  - live: ό,τι μέτρησε το attemptLiveEntry (ουρά/εκτέλεση wallet, swap submit/confirm,
 *    post-swap, report vs balance-diff, fees).
 */
export function buildEntryTiming(
  event: PumpPortalTradeEvent,
  decision: Extract<EntryDecision, { type: 'enter' }>,
  gateSource: GateSource,
  timeline: EntryTimeline,
  claimMs: number,
  liveAttemptMs: number,
  live: LiveEntryOutcome,
): Record<string, unknown> {
  const executed = live.mode === 'live' ? live.entryPrice : null;
  return {
    v: 1,
    event_received_at: new Date(timeline.receivedAt).toISOString(),
    gate_source: gateSource,
    graduated: decision.graduated,
    mode: live.mode,
    fallback_reason: live.fallbackReason,
    signal: {
      price: decision.entryPrice,
      mcap_sol: event.marketCapSol ?? null,
      sol_amount: event.solAmount,
      signature: event.signature,
    },
    executed_price: executed,
    slippage_vs_signal: executed !== null && decision.entryPrice > 0 ? executed / decision.entryPrice - 1 : null,
    ms: {
      lookup: timeline.lookupMs,
      on_demand_gate: timeline.onDemandGateMs,
      claim: claimMs,
      live_attempt: liveAttemptMs,
      event_to_insert: Date.now() - timeline.receivedAt,
    },
    live: live.timing,
  };
}

function logEntryTiming(mint: string, t: Record<string, unknown>): void {
  const ms = t['ms'] as Record<string, number | null>;
  const live = t['live'] as LiveEntryTiming | null;
  const slip = t['slippage_vs_signal'] as number | null;
  const parts = [
    `mint=${mint.slice(0, 8)}`,
    `mode=${String(t['mode'])}`,
    `gate=${String(t['gate_source'])}`,
    `total=${ms['event_to_insert']}ms`,
    `lookup=${ms['lookup']}`,
    ms['on_demand_gate'] !== null ? `on_demand=${ms['on_demand_gate']}` : null,
    `claim=${ms['claim']}`,
    live?.walletExecMs != null ? `wallet=${live.walletQueueMs}+${live.walletExecMs}` : null,
    live?.swap ? `swap=${live.swap.submitQueueMs}+${live.swap.submitExecMs} confirm=${live.swap.confirmMs}(${live.swap.initialStatus})` : null,
    live?.postSwapMs != null ? `post=${live.postSwapMs}` : null,
    slip !== null ? `slip=${(slip * 100).toFixed(1)}%` : null,
    t['fallback_reason'] ? `fallback=${String(t['fallback_reason'])}` : null,
  ];
  console.log(`[entry-timing] ${parts.filter((p) => p !== null).join(' ')}`);
}

/** entry_timing_json.holder_risk — σταθερά ονόματα, τα διαβάζει το scripts/holder-risk-report.ts. */
export function holderRiskJson(snapshot: HolderRiskSnapshot, ms: number, mode: HolderRiskMode): Record<string, unknown> {
  return {
    pct: snapshot.riskPct,
    wallet_count: snapshot.riskWalletCount,
    checked: snapshot.checked,
    mode,
    ms,
  };
}

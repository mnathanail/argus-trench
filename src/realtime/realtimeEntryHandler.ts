import { findPassedTokens, recordTrigger, linkTrade } from '../db/repositories/decisionLog.js';
import { openTrade, countOpenLiveOrPaperTrades, setNativeOrderState } from '../db/repositories/paperTrades.js';
import { getWallet, type WatchlistWallet } from '../db/repositories/watchlistWallets.js';
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
  conditionOrdersJson,
  liveExitConditionOrders,
} from '../decision/paperTradingConfig.js';
import { WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE } from '../collectors/intervals.js';
import { attemptLiveEntry, fallbackOutcomeFor } from '../live/liveEntryExecution.js';
import { isGraduatedEvent, priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { subscribeForNewTrade } from './subscriptionManager.js';
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
export async function handleRealtimeEntryEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeEntryResult | null> {
  if (event.txType !== 'buy') return null; // γρήγορη έξοδος, αποφεύγει τα παρακάτω DB calls

  const wallet = await getWallet(event.traderPublicKey);
  const version = logicVersion(PHASE1_THRESHOLDS);
  const gateSnapshotExists = (await findPassedTokens([event.mint], version)).has(event.mint);
  // ΜΟΝΟ live/paper — τα παλιά log_only δεν πρέπει να κόβουν live entries (βλ. countOpenLiveOrPaperTrades).
  const openTradesCount = await countOpenLiveOrPaperTrades();

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
    return null;
  }
  // TS δε στενεύει το `wallet` μέσω του decideEntry (ξεχωριστή function) — αλλά
  // decision.type==='enter' εγγυάται ήδη ότι wallet!==null (βλ. decideEntry).
  if (wallet === null) return null;

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
      source_channel: 'pumpportal_websocket',
      // 2026-09-27 — για το `npm run graduated-report`: ξεχωρίζει τα σήματα σε ήδη
      // αποφοιτημένα tokens (paper-only δοκιμή) από τα κανονικά bonding-curve σήματα.
      token_stage: decision.graduated ? 'graduated' : 'bonding_curve',
      entry_price_source: decision.graduated ? 'trade_sol_over_tokens' : 'bonding_curve_reserves',
    },
    decision: 'signal_logged',
    decisionReasonText:
      `${wallet.source} wallet ${wallet.address} αγόρασε (realtime) — gate είχε περάσει` +
      (decision.graduated ? ' — graduated token' : ''),
  });
  if (decisionLogId === null) return null; // π.χ. race με ήδη υπάρχον ανοιχτό trade στο ίδιο ζευγάρι

  // 2026-09-27: σε graduated token, live ΜΟΝΟ αν LIVE_ON_GRADUATED_TOKENS — αλλιώς
  // κατευθείαν paper, χωρίς καν να αγγίξουμε κεφάλαιο/risk gate/swap.
  const live =
    decision.graduated && !LIVE_ON_GRADUATED_TOKENS
      ? fallbackOutcomeFor('graduated_paper_only')
      : await attemptLiveEntry(event.mint);
  // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #3): το live.entryPrice είναι ΗΔΗ η πραγματική,
  // εκτελεσμένη τιμή — καμία προσομοίωση δε χρειάζεται ή πρέπει να εφαρμοστεί εκεί. Η
  // ωμή, παρατηρημένη τιμή του σήματος (decision.entryPrice) εφαρμόζεται ΜΟΝΟ όταν η
  // θέση είναι paper/log_only — βλ. applyEntrySlippage στο pnl.ts.
  const finalEntryPrice =
    live.entryPrice ?? applyEntrySlippage(decision.entryPrice, PAPER_ASSUMED_SLIPPAGE_PCT);

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
  });
  await linkTrade(decisionLogId, tradeId);
  if (live.mode === 'live') {
    await setNativeOrderState(tradeId, {
      liveStrategyOrderId: live.liveStrategyOrderId,
      nativeOrderActive: live.nativeOrderVerified,
    });
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
  };
}

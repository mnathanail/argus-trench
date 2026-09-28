import {
  closeShadow,
  getShadowTradeLocked,
  listShadowOpenTradeIdsForToken,
  updateShadowState,
  closeTrade,
  getOpenTradeForTickLocked,
  listOpenTradeIdsForToken,
  markExitAttemptStarted,
  markNeedsManualExit,
  updateTickState,
  type OpenTradeForTick,
} from '../db/repositories/paperTrades.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { withTransaction } from '../db/tx.js';
import type { Queryable } from '../db/tx.js';
import type { ExitReason } from '../db/types.js';
import { computePnl } from '../decision/pnl.js';
import { EXIT_TIMEOUT_MS, PAPER_ASSUMED_FEES_PCT } from '../decision/paperTradingConfig.js';
import { fetchLiveSolWallet, getLiveSolBalance } from '../gmgn/portfolio.js';
import { executeLiveSell, INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE, SwapFailedError } from '../gmgn/swap.js';
import { cancelStrategyOrderBestEffort, estimateExitAmountSol, getStrategyOrder, inferExitReason } from '../gmgn/strategyOrders.js';
import { checkTick } from './tickExit.js';
import { verifySellAfterError } from '../live/sellVerification.js';
import { decideShadowTick } from './shadowExit.js';
import { isDustGraduatedTrade, priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { unsubscribeIfNoLongerNeeded } from './subscriptionManager.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';

/**
 * Ένα «κανονικό» κλείσιμο (paper ΚΑΙ live) ή μια πραγματική πώληση που ΑΠΕΤΥΧΕ και
 * χρειάζεται χειροκίνητη προσοχή (ρητή απόφαση χρήστη 2026-09-15: "θα γίνεται
 * χειροκίνητη προσπάθεια"). Ο caller (main.ts) στέλνει διαφορετικό μήνυμα Telegram
 * ανάλογα με το `type` — ίδιο μοτίβο με πριν, όλη η μορφοποίηση μηνυμάτων μένει εκεί.
 */
export type RealtimeTradeOutcome =
  | { type: 'closed'; tokenAddress: string; exitReason: ExitReason; pnlPct: number }
  | { type: 'manual_exit_needed'; tokenAddress: string; tradeId: number; errorMessage: string };

export type TickDecision =
  | {
      type: 'close';
      exitReason: 'tp_tier_1' | 'trailing_stop' | 'stop_loss' | 'exit_signal';
      exitPrice: number;
      exitTriggerDetail: Record<string, unknown> | null;
    }
  | { type: 'update'; newPeakPriceSinceEntry: number; newTrailingActive: boolean }
  | { type: 'ignore' };

export type TickDecisionInput = Pick<
  OpenTradeForTick,
  | 'simulatedEntryPrice'
  | 'entryAt'
  | 'peakPriceSinceEntry'
  | 'trailingActive'
  | 'triggerWalletAddress'
  | 'nativeOrderActive'
>;

/** Πόσο πρόσφατο πρέπει να είναι ένα `exit_attempt_started_at` για να θεωρηθεί «ακόμα σε
 * εξέλιξη» — βλ. migration 0011. Αρκετά μεγάλο για το πλήρες confirmation polling του
 * GMGN swap (έως ~30s), με άνεση· πιο παλιό από αυτό σημαίνει πιθανό κολλημένη/κρασαρισμένη
 * προηγούμενη προσπάθεια, όχι ενεργή — επιτρέπουμε νέα. */
export const LIVE_EXIT_ATTEMPT_STALE_MS = 150_000;
// ΑΛΛΑΓΗ 2026-09-28: 60s → 150s. Μια live πώληση μπορεί πλέον να περιλαμβάνει, μετά από
// error, on-chain έλεγχο υπολοίπου (~12s) ΚΑΙ μία επανάληψη της πώλησης (έως ~30s + poll)
// — βλ. executeLiveCloseAndFinalize. Με 60s, ένα δεύτερο tick θα μπορούσε να ξεκινήσει
// ταυτόχρονη πώληση πάνω στην ίδια θέση όσο η πρώτη ακόμα επαληθεύεται.

/**
 * Καθαρή, τεσταρίσιμη απόφαση — «πρέπει αυτό το trade να αγνοηθεί εντελώς σε αυτό το
 * tick, πριν καν φτάσουμε στο decideForTick;». Δύο ξεχωριστοί λόγοι:
 *   1. `needsManualExit` — προηγούμενη πραγματική πώληση ήδη απέτυχε, περιμένει
 *      χειροκίνητη προσοχή. ΠΟΤΕ αυτόματο ξαναπροσπάθημα (ρητή απόφαση χρήστη).
 *   2. Άλλη απόπειρα live close ήδη σε εξέλιξη (πρόσφατο exit_attempt_started_at) —
 *      μην ξεκινήσεις δεύτερη, ταυτόχρονη πώληση στην ΙΔΙΑ θέση.
 */
export function shouldSkipLiveExitCheck(
  trade: Pick<OpenTradeForTick, 'needsManualExit' | 'mode' | 'exitAttemptStartedAt'>,
  now: Date,
): boolean {
  if (trade.needsManualExit) return true;
  if (trade.mode === 'live' && trade.exitAttemptStartedAt !== null) {
    const elapsedMs = now.getTime() - trade.exitAttemptStartedAt.getTime();
    if (elapsedMs < LIVE_EXIT_ATTEMPT_STALE_MS) return true;
  }
  return false;
}

/**
 * Καθαρή απόφαση — τι πρέπει να συμβεί για ΕΝΑ trade δεδομένου ΕΝΟΣ event, χωρίς καμία
 * επαφή με DB/socket. Ξεχωριστό από την εκτέλεση (handleOneTrade) ώστε να τεσταρίζεται
 * πλήρως χωρίς πραγματική βάση — ίδιο σκεπτικό με το resolveExit/checkTick.
 *
 * Δύο πραγματικά ευρήματα πλήρους ελέγχου 2026-09-09 ενσωματωμένα εδώ:
 * 1. ΠΟΤΕ μην αξιολογείς πέρα από το πραγματικό 24ωρο όριο — ίδιο σκεπτικό με το
 *    resolveExit boundary fix (2026-09-07), που είχε ξεχαστεί σε αυτό το νεότερο
 *    μονοπάτι. `now` περνάει ρητά (όχι Date.now() εσωτερικά) ακριβώς για να τεσταρίζεται.
 * 2. exit_signal έχει προτεραιότητα έναντι του price tick στο ΙΔΙΟ event — ίδιο
 *    σκεπτικό με το resolveExit's "wallet exit_signal takes priority over a tier hit
 *    in the same candle".
 *
 * 2026-09-17, μετά το incident #1193, ΚΑΙ αναθεωρημένο ΤΗΝ ΙΔΙΑ μέρα κατόπιν ρητής
 * απόφασης του χρήστη: ο δικός μας tracker (αυτό εδώ, `checkTick`) παραμένει το
 * ΠΡΩΤΕΥΟΝ exit decision engine για live trades — ΑΚΡΙΒΩΣ η ίδια λογική/thresholds με
 * το paper trading, χωρίς καμία εξαίρεση όταν `nativeOrderActive===true`. Ο λόγος:
 * το paper trading υπάρχει για να δοκιμάσει ΑΥΤΟΝ τον μηχανισμό — αν το live έτρεχε
 * διαφορετική λογική (native GMGN order ως πρωτεύον), η δοκιμή στο paper θα μετρούσε
 * ένα σύστημα που δεν είναι αυτό που τελικά παίρνει αποφάσεις με πραγματικά λεφτά.
 *
 * Το native GMGN strategy order (profit_stop_trace + loss_stop, βλ. migration 0013)
 * ΠΑΡΑΜΕΝΕΙ συνδεδεμένο σε κάθε live buy, αλλά ΜΟΝΟ ως ασφάλεια/dead-man's-switch: αν
 * το δικό μας process πέσει ή χάσει το PumpPortal feed, το GMGN order συνεχίζει να
 * τρέχει server-side, ανεξάρτητα. Όσο είμαστε online, ΔΕΝ αναμένουμε ποτέ το native
 * order να προλάβει — αλλά ΜΠΟΡΕΙ να συμβεί (π.χ. μια στιγμιαία καθυστέρηση στο δικό
 * μας tick). Αυτό το πιθανό race χειρίζεται το `executeLiveCloseAndFinalize` παρακάτω
 * με idempotent-guard: αν η δική μας πώληση αποτύχει με "insufficient token balance"
 * (η θέση έφυγε ήδη), διαβάζουμε το ΠΡΑΓΜΑΤΙΚΟ αποτέλεσμα από το ίδιο το GMGN strategy
 * order — ποτέ simulation. Ο live strategy reconciler (collectors/
 * liveStrategyReconciler.ts) παραμένει το watchdog που ενεργοποιεί πλήρες fallback
 * (`native_order_active=false`) αν το native order αποτύχει/σταματήσει.
 */
export function decideForTick(trade: TickDecisionInput, event: PumpPortalTradeEvent, now: Date): TickDecision {
  if (now.getTime() - trade.entryAt.getTime() >= EXIT_TIMEOUT_MS) return { type: 'ignore' };

  if (event.txType === 'sell' && event.traderPublicKey === trade.triggerWalletAddress) {
    const price = priceFromTradeEvent(event) ?? trade.simulatedEntryPrice;
    return {
      type: 'close',
      exitReason: 'exit_signal',
      exitPrice: price,
      exitTriggerDetail: { wallet: trade.triggerWalletAddress },
    };
  }

  const price = priceFromTradeEvent(event);
  // null: dust trade σε graduated token, ή degenerate/malformed event — από 2026-09-27 τα
  // graduated tokens έχουν κανονικά τιμή (solAmount/tokenAmount), βλ. priceFromTradeEvent.
  if (price === null) return { type: 'ignore' };

  const result = checkTick({
    entryPrice: trade.simulatedEntryPrice,
    peakPriceSinceEntry: trade.peakPriceSinceEntry,
    trailingActive: trade.trailingActive,
    currentPrice: price,
  });

  if (result.exit !== null) {
    return {
      type: 'close',
      exitReason: result.exit.exitReason,
      exitPrice: result.exit.exitPrice,
      exitTriggerDetail: null,
    };
  }

  if (
    result.newPeakPriceSinceEntry !== trade.peakPriceSinceEntry ||
    result.newTrailingActive !== trade.trailingActive
  ) {
    return {
      type: 'update',
      newPeakPriceSinceEntry: result.newPeakPriceSinceEntry,
      newTrailingActive: result.newTrailingActive,
    };
  }

  return { type: 'ignore' };
}

interface PendingLiveClose {
  tradeId: number;
  exitReason: 'tp_tier_1' | 'trailing_stop' | 'stop_loss' | 'exit_signal' | 'timeout';
  exitPrice: number;
  exitTriggerDetail: Record<string, unknown> | null;
  actualEntryAmountSol: number | null;
  /** Μη-null ΜΟΝΟ όταν trade.nativeOrderActive ήταν true τη στιγμή της απόφασης — το
   * native GMGN order ακυρώνεται ΠΡΙΝ από τη δική μας πώληση (Phase 2, εκτός lock), ώστε
   * να μην παλέψουν δύο ταυτόχρονες πωλήσεις πάνω στην ίδια θέση (π.χ. exit_signal ή
   * timeout ενώ το native trailing είναι ακόμα ενεργό). */
  liveStrategyOrderId: string | null;
}

type TradeHandlingResult =
  | { kind: 'none' }
  | { kind: 'closed'; outcome: RealtimeTradeOutcome }
  | { kind: 'pending_live_close'; pending: PendingLiveClose };

/**
 * Καλείται σε ΚΑΘΕ εισερχόμενο trade event. ΚΛΕΙΔΩΜΕΝΗ ανάγνωση ανά trade (transaction +
 * `FOR UPDATE`) — ένα δραστήριο token μπορεί να δώσει πολλά ticks μέσα σε δευτερόλεπτα·
 * χωρίς lock, δύο ταυτόχρονα ticks θα διάβαζαν το ίδιο μπαγιάτικο peak/trailing state,
 * και το δεύτερο write θα "έσβηνε" σιωπηλά το πρώτο (lost update). Πραγματικό εύρημα
 * πλήρους ελέγχου 2026-09-09.
 *
 * ΔΥΟ ΦΑΣΕΙΣ από 2026-09-15 (πρώτη πραγματική σύνδεση live trading): ένα live close ΔΕΝ
 * εκτελεί το πραγματικό swap μέσα στο lock/transaction — θα κρατούσε ανοιχτό ένα DB
 * connection + row lock για όλη τη διάρκεια του swap (έως ~30s, confirmation polling
 * στο gmgn/swap.ts), μπλοκάροντας ένα δεύτερο, γρήγορο tick στο ίδιο ενεργό token.
 * Αντ' αυτού: Φάση 1 (μέσα στο lock) αποφασίζει ΚΑΙ σημαδεύει (`markExitAttemptStarted`),
 * commit, lock ελεύθερο· Φάση 2 (ΕΚΤΟΣ lock) εκτελεί το πραγματικό swap και μετά
 * κλείνει/σημαδεύει σε ΝΕΟ, σύντομο statement.
 */
export async function handleRealtimeTradeEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeTradeOutcome[]> {
  // 2026-09-28: shadow δοκιμή 4B — ΠΡΙΝ και ΑΝΕΞΑΡΤΗΤΑ από την πραγματική λογική, και
  // ποτέ δεν πετάει (ένα σφάλμα στο shadow δεν πρέπει να αγγίξει πραγματική έξοδο).
  await processShadowTicks(event, connection);

  const candidateIds = await listOpenTradeIdsForToken(event.mint);
  if (candidateIds.length === 0) return [];

  const outcomes: RealtimeTradeOutcome[] = [];
  const pendingLiveCloses: PendingLiveClose[] = [];

  for (const id of candidateIds) {
    const result = await withTransaction(async (client) => {
      const trade = await getOpenTradeForTickLocked(id, client);
      // null: έκλεισε ήδη (periodic exit-resolver, ή προηγούμενο tick στο ίδιο batch)
      // ανάμεσα στο listOpenTradeIdsForToken() και εδώ — εντάξει, τίποτα να κάνουμε.
      if (trade === null) return { kind: 'none' } as const;
      return handleOneTrade(trade, event, connection, client);
    });
    if (result.kind === 'closed') outcomes.push(result.outcome);
    else if (result.kind === 'pending_live_close') pendingLiveCloses.push(result.pending);
  }

  // Φάση 2 — ΕΚΤΟΣ οποιουδήποτε lock, μία-μία (σπάνιο να έχει πάνω από μία ταυτόχρονα).
  for (const pending of pendingLiveCloses) {
    outcomes.push(await executeLiveCloseAndFinalize(pending, event.mint, connection));
  }

  return outcomes;
}

/**
 * Shadow "4B" trailing (βλ. realtime/shadowExit.ts, migration 0017): για κάθε trade με
 * ανοιχτό shadow σε αυτό το token — πραγματικό trade ανοιχτό ή όχι — ενημερώνει/κλείνει
 * ΜΟΝΟ τις shadow_* στήλες. Ποτέ δεν πετάει.
 */
async function processShadowTicks(event: PumpPortalTradeEvent, connection: PumpPortalConnection): Promise<void> {
  let ids: number[];
  try {
    ids = await listShadowOpenTradeIdsForToken(event.mint);
  } catch (error) {
    console.error(`[shadow] listShadowOpenTradeIdsForToken απέτυχε: ${errorText(error)}`);
    return;
  }
  for (const id of ids) {
    try {
      await withTransaction(async (client) => {
        const trade = await getShadowTradeLocked(id, client);
        if (trade === null) return;
        const decision = decideShadowTick(
          {
            entryPrice: trade.entryPrice,
            entryAt: trade.entryAt,
            triggerWalletAddress: trade.triggerWalletAddress,
            state: { peak: trade.peak, trailingActive: trade.trailingActive, breachSince: trade.breachSince },
          },
          event,
          new Date(),
        );
        if (decision.type === 'update') {
          await updateShadowState(id, decision.state, client);
        } else if (decision.type === 'exit') {
          const closed = await closeShadow(id, decision.reason, decision.price, client);
          // Αν το πραγματικό trade έχει ήδη κλείσει, αυτό ήταν ίσως το τελευταίο που χρειαζόταν ticks.
          if (closed && trade.status !== 'open') await unsubscribeIfNoLongerNeeded(connection, event.mint, client);
        }
      });
    } catch (error) {
      console.error(`[shadow] σφάλμα στο trade ${id}: ${errorText(error)}`);
    }
  }
}

/** Το `decideForTick` σκόπιμα αγνοεί trades πέρα από το EXIT_TIMEOUT_MS — ΠΑΝΤΑ
 * βασιζόταν στο periodic resolver γι' αυτό. Μετά το σημερινό fix (selectOpenTradesForCheck
 * πλέον αγνοεί mode='live'), κάτι ΠΡΕΠΕΙ να κλείνει τα live trades λόγω timeout — αυτό
 * είναι το «κάτι». */
export function isPastLiveTimeout(entryAt: Date, now: Date): boolean {
  return now.getTime() - entryAt.getTime() >= EXIT_TIMEOUT_MS;
}

/** Δεν μπορούμε να βγάλουμε τιμή από αυτό το event ΚΑΙ δεν είναι απλό dust trade.
 *
 * ΑΛΛΑΓΗ 2026-09-27: πριν, ΚΑΘΕ event σε graduated token ήταν «μη τιμολογήσιμο» και
 * πάγωνε live trades σε needs_manual_exit χωρίς αυτόματη προστασία. Τώρα τα graduated
 * tokens έχουν τιμή από το ίδιο το trade (βλ. priceFromTradeEvent), οπότε το stop-loss/
 * trailing συνεχίζει κανονικά. Εδώ μένουν μόνο τα πραγματικά μη τιμολογήσιμα (degenerate
 * reserves, tokenAmount<=0). Ένα dust graduated trade ΔΕΝ παγώνει τίποτα — απλά
 * αγνοείται (decideForTick → ignore). Ένα exit_signal (wallet sell) δεν χρειάζεται τιμή,
 * ελέγχεται ΗΔΗ πρώτο μέσα στο decideForTick. */
export function isUnpriceableNonSellEvent(event: PumpPortalTradeEvent): boolean {
  return event.txType !== 'sell' && priceFromTradeEvent(event) === null && !isDustGraduatedTrade(event);
}

async function handleOneTrade(
  trade: OpenTradeForTick,
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
  conn: Queryable,
): Promise<TradeHandlingResult> {
  // Ήδη αποτυχημένη πραγματική πώληση (needs_manual_exit), ή άλλη απόπειρα live close
  // ήδη σε εξέλιξη — βλ. shouldSkipLiveExitCheck.
  if (shouldSkipLiveExitCheck(trade, new Date())) return { kind: 'none' };

  const now = new Date();

  if (trade.mode === 'live') {
    // ΔΙΟΡΘΩΣΗ 2026-09-17, πραγματικό incident (#1193): το `decideForTick` σκόπιμα
    // αγνοεί trades πέρα από το 24ωρο timeout — βασιζόταν ΠΑΝΤΑ στο periodic resolver
    // για να τα κλείσει. Το periodic resolver πλέον ΔΕΝ αγγίζει καθόλου live trades
    // (σημερινό, ξεχωριστό fix — βλ. selectOpenTradesForCheck). Χωρίς αυτόν εδώ τον
    // ρητό έλεγχο, ένα live trade που ποτέ δεν πυροδοτεί tier/trailing/stop_loss θα
    // έμενε ανοιχτό ΓΙΑ ΠΑΝΤΑ, χωρίς κανέναν μηχανισμό να το κλείσει ποτέ.
    if (isPastLiveTimeout(trade.entryAt, now)) {
      await markExitAttemptStarted(trade.id, conn);
      return {
        kind: 'pending_live_close',
        pending: {
          tradeId: trade.id,
          exitReason: 'timeout',
          exitPrice: priceFromTradeEvent(event) ?? trade.simulatedEntryPrice,
          exitTriggerDetail: null,
          actualEntryAmountSol: trade.actualEntryAmountSol,
          liveStrategyOrderId: trade.nativeOrderActive ? trade.liveStrategyOrderId : null,
        },
      };
    }

    // ΔΙΟΡΘΩΣΗ 2026-09-17, η ίδια πραγματική αιτία του incident #1193: το
    // priceFromTradeEvent επιστρέφει null όταν το token «αποφοίτησε» από το pump.fun
    // bonding curve (pool !== 'pump') — το real-time μας σύστημα δεν έχει φόρμουλα να
    // υπολογίσει τιμή σε πραγματικό DEX/AMM. Πριν αυτή τη διόρθωση, ένα τέτοιο tick
    // απλά αγνοούνταν σιωπηλά — παγώνοντας το peak/trailing state ΓΙΑ ΠΑΝΤΑ, χωρίς
    // stop-loss, χωρίς trailing, χωρίς καμία ειδοποίηση. Ένα exit_signal (wallet sell)
    // δεν χρειάζεται τιμή για να αναγνωριστεί — ελέγχεται ήδη ΠΡΩΤΟ μέσα στο
    // decideForTick, άρα δεν το αγγίζουμε εδώ.
    //
    // ΑΛΛΑΓΗ 2026-09-27: τα graduated tokens έχουν πλέον τιμή από το ίδιο το trade
    // (solAmount/tokenAmount, βλ. priceFromTradeEvent), οπότε ΔΕΝ φτάνουν πια εδώ — το
    // stop-loss/trailing συνεχίζει κανονικά. Αυτό το μονοπάτι μένει μόνο για πραγματικά
    // μη τιμολογήσιμα events (βλ. isUnpriceableNonSellEvent).
    //
    // ΕΞΑΙΡΕΣΗ 2026-09-17 (native order): αν trade.nativeOrderActive===true, ΔΕΝ
    // παγώνουμε σε needs_manual_exit — το native GMGN strategy order δεν εξαρτάται από
    // το δικό μας PumpPortal feed, πολύ πιθανό να συνεχίζει κανονικά πάνω στο
    // νέο venue. Ο live strategy reconciler (περιοδικό, βλ. collectors/
    // liveStrategyReconciler.ts) είναι αυτός που θα μάθει αν πράγματι απέτυχε — μόνο
    // τότε ενεργοποιείται το fallback. Απλά αγνοούμε το tick εδώ.
    if (isUnpriceableNonSellEvent(event) && !trade.needsManualExit && !trade.nativeOrderActive) {
      await markNeedsManualExit(trade.id, conn);
      await recordExecutionError({
        paperTradeId: trade.id,
        tokenAddress: event.mint,
        action: 'sell',
        amountSol: trade.actualEntryAmountSol,
        errorMessage: `Δεν υπολογίζεται τιμή από το PumpPortal event (pool=${event.pool ?? 'άγνωστο'}, solAmount=${event.solAmount}, tokenAmount=${event.tokenAmount}) — καμία αυτόματη προστασία (stop-loss/trailing) δεν ισχύει πλέον για αυτό το trade.`,
      });
      return {
        kind: 'closed',
        outcome: {
          type: 'manual_exit_needed',
          tokenAddress: event.mint,
          tradeId: trade.id,
          errorMessage: `Το token «αποφοίτησε» (pool=${event.pool ?? 'άγνωστο, πεδία bonding-curve απόντα'}) — χρειάζεται χειροκίνητος έλεγχος, καμία αυτόματη προστασία δεν ισχύει πλέον.`,
        },
      };
    }
  }

  const decision = decideForTick(trade, event, now);

  switch (decision.type) {
    case 'ignore':
      return { kind: 'none' };
    case 'update':
      await updateTickState(trade.id, decision.newPeakPriceSinceEntry, decision.newTrailingActive, conn);
      return { kind: 'none' };
    case 'close': {
      if (trade.mode === 'live') {
        await markExitAttemptStarted(trade.id, conn);
        return {
          kind: 'pending_live_close',
          pending: {
            tradeId: trade.id,
            exitReason: decision.exitReason,
            exitPrice: decision.exitPrice,
            exitTriggerDetail: decision.exitTriggerDetail,
            actualEntryAmountSol: trade.actualEntryAmountSol,
            // Ο δικός μας tracker είναι πρωτεύων — ΟΠΟΙΟΣΔΗΠΟΤΕ exitReason μπορεί να
            // φτάσει εδώ ακόμα και με nativeOrderActive===true (tp_tier_1/trailing_stop/
            // stop_loss/exit_signal). Cancel-first στο Phase 2, ίδιο σκεπτικό με το
            // timeout path — αποτρέπει το native order να πυροδοτήσει ταυτόχρονα πάνω
            // στην ίδια θέση όσο η δική μας πώληση εκτελείται.
            liveStrategyOrderId: trade.nativeOrderActive ? trade.liveStrategyOrderId : null,
          },
        };
      }
      // paper/log_only — αμετάβλητο μονοπάτι, καμία πραγματική συναλλαγή.
      const pnl = computePnl(
        trade.simulatedEntryPrice,
        decision.exitPrice,
        trade.bankrollAtEntry,
        trade.intendedSizePct,
      );
      const closed = await closeTrade(
        trade.id,
        {
          exitReason: decision.exitReason,
          exitTriggerDetail: decision.exitTriggerDetail,
          simulatedExitPrice: decision.exitPrice,
          pnlSol: pnl.pnlSol,
          pnlPct: pnl.pnlPct,
          assumedFeesPct: PAPER_ASSUMED_FEES_PCT,
          pnlNetPct: pnl.pnlNetPct,
        },
        conn,
      );
      if (!closed) return { kind: 'none' };
      await unsubscribeIfNoLongerNeeded(connection, event.mint, conn);
      return {
        kind: 'closed',
        outcome: { type: 'closed', tokenAddress: event.mint, exitReason: decision.exitReason, pnlPct: pnl.pnlPct },
      };
    }
  }
}

/**
 * Η ΠΡΑΓΜΑΤΙΚΗ πώληση — ΕΚΤΟΣ οποιουδήποτε DB lock/transaction (βλ. σχόλιο στο
 * handleRealtimeTradeEvent). Το πραγματικό pnl υπολογίζεται απευθείας από τη διαφορά
 * πραγματικού υπολοίπου πριν/μετά — ΚΑΜΙΑ ποσοστιαία παραδοχή (assumed_fees_pct=0 εδώ
 * σκόπιμα, όχι λάθος): έχουμε ήδη τα πραγματικά νούμερα, δεν χρειάζεται να τα
 * υπολογίσουμε.
 */
async function executeLiveCloseAndFinalize(
  pending: PendingLiveClose,
  tokenAddress: string,
  connection: PumpPortalConnection,
): Promise<RealtimeTradeOutcome> {
  // Ακύρωσε ΠΡΩΤΑ το native order, αν ήταν ακόμα ενεργό — best-effort, ΔΕΝ μπλοκάρει τη
  // δική μας πώληση αν αποτύχει (π.χ. το strategy έκλεισε ήδη μόνο του ανάμεσα στο
  // decideForTick και εδώ). Χωρίς αυτό, ένα exit_signal ή timeout θα μπορούσε να
  // παλέψει με ένα ταυτόχρονο native trailing-stop fill πάνω στην ΙΔΙΑ θέση.
  if (pending.liveStrategyOrderId !== null) {
    await cancelStrategyOrderBestEffort(pending.liveStrategyOrderId);
  }

  let wallet;
  try {
    wallet = await fetchLiveSolWallet();
  } catch (error) {
    return failLiveClose(pending, tokenAddress, error);
  }
  const balanceBefore = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;

  let firstError: unknown;
  try {
    const result = await executeLiveSell(wallet.address, tokenAddress);
    const balanceAfter = await getLiveSolBalance();
    return finalizeLiveClose(pending, tokenAddress, connection, balanceAfter - balanceBefore, result.executedPrice);
  } catch (error) {
    firstError = error;
  }

  const reconciled = await tryReconcileAlreadyClosedByNativeOrder(pending, tokenAddress, wallet.address, connection, firstError);
  if (reconciled !== null) return reconciled;

  // ΝΕΟ 2026-09-28 — βλ. live/sellVerification.ts: το error του CLI ΔΕΝ αποδεικνύει ότι
  // η πώληση απέτυχε (trade 6442: "αποτυχία" που στην πραγματικότητα εκτελέστηκε, +104%).
  // Το on-chain υπόλοιπο αποφασίζει.
  const verdict = await verifySellAfterError(wallet.address, tokenAddress, balanceBefore);
  if (verdict.kind === 'sold') {
    await recordExecutionError({
      paperTradeId: pending.tradeId,
      tokenAddress,
      action: 'sell',
      amountSol: pending.actualEntryAmountSol,
      errorMessage: `Το gmgn-cli επέστρεψε error, αλλά η πώληση ΕΠΙΒΕΒΑΙΩΘΗΚΕ on-chain (token balance 0, +${verdict.proceedsSol.toFixed(6)} SOL) — το trade κλείνει κανονικά. Αρχικό error: ${errorText(firstError)}`,
      errorDetail: firstError,
    });
    return finalizeLiveClose(pending, tokenAddress, connection, verdict.proceedsSol, null);
  }

  if (verdict.kind === 'still_held') {
    // Τα tokens είναι ακόμα εκεί — η πώληση πράγματι δεν έγινε. ΜΙΑ επανάληψη (π.χ. το GMGN
    // δεν είχε ακόμα "δει" τα tokens αμέσως μετά το buy — trade 6442 πούλησε 19″ μετά).
    try {
      const retryBalanceBefore = await getLiveSolBalance();
      const result = await executeLiveSell(wallet.address, tokenAddress);
      const balanceAfter = await getLiveSolBalance();
      await recordExecutionError({
        paperTradeId: pending.tradeId,
        tokenAddress,
        action: 'sell',
        amountSol: pending.actualEntryAmountSol,
        errorMessage: `Η 1η πώληση απέτυχε με τα tokens ακόμα στο wallet — η επανάληψη ΠΕΤΥΧΕ. Αρχικό error: ${errorText(firstError)}`,
        errorDetail: firstError,
      });
      return finalizeLiveClose(pending, tokenAddress, connection, balanceAfter - retryBalanceBefore, result.executedPrice);
    } catch (retryError) {
      await recordExecutionError({
        paperTradeId: pending.tradeId,
        tokenAddress,
        action: 'sell',
        amountSol: pending.actualEntryAmountSol,
        errorMessage: `1η πώληση (tokens ακόμα στο wallet): ${errorText(firstError)}`,
        errorDetail: firstError,
      });
      return failLiveClose(pending, tokenAddress, retryError, 'και η επανάληψη απέτυχε, τα tokens είναι ακόμα στο wallet');
    }
  }

  const context =
    verdict.kind === 'gone_elsewhere'
      ? 'το token δεν είναι πια στο wallet αλλά δεν μπήκε SOL — πιθανόν πουλήθηκε αλλού, έλεγξε στο GMGN'
      : 'ο on-chain έλεγχος υπολοίπου απέτυχε — άγνωστη κατάσταση, έλεγξε στο GMGN';
  return failLiveClose(pending, tokenAddress, firstError, context);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Κοινό κλείσιμο live trade με ΠΡΑΓΜΑΤΙΚΑ νούμερα (έσοδα SOL από διαφορά υπολοίπου). */
async function finalizeLiveClose(
  pending: PendingLiveClose,
  tokenAddress: string,
  connection: PumpPortalConnection,
  actualExitAmountSol: number,
  executedPrice: number | null,
): Promise<RealtimeTradeOutcome> {
  const actualEntryAmountSol = pending.actualEntryAmountSol ?? 0;
  const pnlSol = actualExitAmountSol - actualEntryAmountSol;
  const pnlPct = actualEntryAmountSol > 0 ? pnlSol / actualEntryAmountSol : null;

  const closed = await closeTrade(pending.tradeId, {
    exitReason: pending.exitReason,
    exitTriggerDetail: pending.exitTriggerDetail,
    simulatedExitPrice: executedPrice ?? pending.exitPrice,
    pnlSol,
    pnlPct,
    assumedFeesPct: 0,
    pnlNetPct: pnlPct,
    actualExitAmountSol,
  });
  if (closed) await unsubscribeIfNoLongerNeeded(connection, tokenAddress);
  return { type: 'closed', tokenAddress, exitReason: pending.exitReason, pnlPct: pnlPct ?? 0 };
}

/**
 * Idempotent-guard για το race που παραμένει δυνατό στο σχέδιο «tracker primary, native
 * order μόνο ασφάλεια» (ρητή απόφαση χρήστη 2026-09-17): ο δικός μας tracker τρέχει
 * ΠΑΝΤΑ πλήρη tier1/trailing/stop_loss λογική, ακόμα κι όσο ένα native GMGN order είναι
 * ακόμα συνδεδεμένο — το cancel λίγο πιο πάνω είναι best-effort, άρα ΠΑΡΑΜΕΝΕΙ ένα
 * (σπάνιο, π.χ. μια στιγμιαία καθυστέρηση στο δικό μας tick) παράθυρο όπου το native
 * order προλαβαίνει να εκτελέσει ΔΙΚΗ ΤΟΥ πώληση λίγο πριν από τη δική μας. Σε αυτή την
 * περίπτωση η δική μας `executeLiveSell` αποτυγχάνει με GMGN
 * `error_code=40003701` ("insufficient token balance") — δεν έχει μείνει τίποτα να
 * πουλήσουμε.
 *
 * ΔΕΝ το αντιμετωπίζουμε σαν πραγματική αποτυχία (needs_manual_exit): διαβάζουμε το
 * ΠΡΑΓΜΑΤΙΚΟ αποτέλεσμα απευθείας από το GMGN strategy order (`getStrategyOrder`) —
 * ίδια πηγή/λογική με τον live strategy reconciler
 * (collectors/liveStrategyReconciler.ts) — και κλείνουμε το trade με αυτά τα ΠΡΑΓΜΑΤΙΚΑ
 * νούμερα, ποτέ simulation/kline. Αν το strategy order δεν επιβεβαιώνει close (ακόμα
 * open/running, δε βρέθηκε, ή το lookup απέτυχε), δεν ξέρουμε τι πραγματικά συνέβη —
 * επιστρέφουμε null και ο caller πέφτει στο κανονικό needs_manual_exit fallback.
 */
async function tryReconcileAlreadyClosedByNativeOrder(
  pending: PendingLiveClose,
  tokenAddress: string,
  walletAddress: string,
  connection: PumpPortalConnection,
  error: unknown,
): Promise<RealtimeTradeOutcome | null> {
  if (pending.liveStrategyOrderId === null) return null;
  const isInsufficientBalance =
    error instanceof SwapFailedError && error.errorCode === INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE;
  if (!isInsufficientBalance) return null;

  let strategy;
  try {
    strategy = await getStrategyOrder(walletAddress, tokenAddress, pending.liveStrategyOrderId);
  } catch {
    return null; // δεν μπορούμε να επιβεβαιώσουμε τίποτα εδώ — fallback σε needs_manual_exit
  }
  if (strategy === null || strategy.status !== 'closed') return null;

  const actualEntryAmountSol = pending.actualEntryAmountSol;
  const actualExitAmountSol = estimateExitAmountSol(actualEntryAmountSol, strategy.openPrice, strategy.closePrice);
  const pnlSol =
    actualExitAmountSol !== null && actualEntryAmountSol !== null ? actualExitAmountSol - actualEntryAmountSol : null;
  const pnlPct =
    pnlSol !== null && actualEntryAmountSol !== null && actualEntryAmountSol > 0 ? pnlSol / actualEntryAmountSol : null;
  const exitReason = inferExitReason(strategy.reasonCode);

  const closed = await closeTrade(pending.tradeId, {
    exitReason,
    exitTriggerDetail: pending.exitTriggerDetail,
    simulatedExitPrice: strategy.closePrice ?? strategy.openPrice ?? pending.exitPrice,
    pnlSol,
    pnlPct,
    assumedFeesPct: 0, // πραγματική εκτελεσμένη τιμή GMGN, όχι παραδοχή
    pnlNetPct: pnlPct,
    actualExitAmountSol: actualExitAmountSol ?? undefined,
  });
  if (closed) await unsubscribeIfNoLongerNeeded(connection, tokenAddress);
  return { type: 'closed', tokenAddress, exitReason, pnlPct: pnlPct ?? 0 };
}

async function failLiveClose(
  pending: PendingLiveClose,
  tokenAddress: string,
  error: unknown,
  context?: string,
): Promise<RealtimeTradeOutcome> {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const errorMessage = context === undefined ? baseMessage : `${baseMessage} — ${context}`;
  await recordExecutionError({
    paperTradeId: pending.tradeId,
    tokenAddress,
    action: 'sell',
    amountSol: pending.actualEntryAmountSol,
    errorMessage,
    errorDetail: error,
  });
  await markNeedsManualExit(pending.tradeId);
  return { type: 'manual_exit_needed', tokenAddress, tradeId: pending.tradeId, errorMessage };
}

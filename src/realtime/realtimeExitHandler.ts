import {
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
import { priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
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
export const LIVE_EXIT_ATTEMPT_STALE_MS = 60_000;

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
  if (price === null) return { type: 'ignore' }; // π.χ. το token μετακόμισε εκτός bonding curve

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

/** Το `decideForTick` σκόπιμα αγνοεί trades πέρα από το EXIT_TIMEOUT_MS — ΠΑΝΤΑ
 * βασιζόταν στο periodic resolver γι' αυτό. Μετά το σημερινό fix (selectOpenTradesForCheck
 * πλέον αγνοεί mode='live'), κάτι ΠΡΕΠΕΙ να κλείνει τα live trades λόγω timeout — αυτό
 * είναι το «κάτι». */
export function isPastLiveTimeout(entryAt: Date, now: Date): boolean {
  return now.getTime() - entryAt.getTime() >= EXIT_TIMEOUT_MS;
}

/** Το token «αποφοίτησε» από το pump.fun bonding curve (priceFromTradeEvent()===null,
 * βλ. εκεί) — δεν έχουμε πια φόρμουλα να υπολογίσουμε τιμή από αυτό το feed. Ένα
 * exit_signal (wallet sell) δεν χρειάζεται τιμή για να αναγνωριστεί — ελέγχεται ΗΔΗ
 * πρώτο μέσα στο decideForTick, άρα ΔΕΝ το θεωρούμε «migration» εδώ. */
export function isUnpriceableNonSellEvent(event: PumpPortalTradeEvent): boolean {
  return event.txType !== 'sell' && priceFromTradeEvent(event) === null;
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
        errorMessage: `Το token φαίνεται να «αποφοίτησε» από το pump.fun bonding curve (pool=${event.pool}) — το realtime σύστημα δεν μπορεί πλέον να υπολογίσει τιμή αυτόματα, καμία αυτόματη προστασία (stop-loss/trailing) δεν ισχύει πλέον.`,
      });
      return {
        kind: 'closed',
        outcome: {
          type: 'manual_exit_needed',
          tokenAddress: event.mint,
          tradeId: trade.id,
          errorMessage: `Το token «αποφοίτησε» (pool=${event.pool}) — χρειάζεται χειροκίνητος έλεγχος, καμία αυτόματη προστασία δεν ισχύει πλέον.`,
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

  try {
    const result = await executeLiveSell(wallet.address, tokenAddress);
    const balanceAfter = await getLiveSolBalance();
    const actualExitAmountSol = balanceAfter - balanceBefore;
    const actualEntryAmountSol = pending.actualEntryAmountSol ?? 0;
    const pnlSol = actualExitAmountSol - actualEntryAmountSol;
    const pnlPct = actualEntryAmountSol > 0 ? pnlSol / actualEntryAmountSol : null;

    const closed = await closeTrade(pending.tradeId, {
      exitReason: pending.exitReason,
      exitTriggerDetail: pending.exitTriggerDetail,
      simulatedExitPrice: result.executedPrice ?? pending.exitPrice,
      pnlSol,
      pnlPct,
      assumedFeesPct: 0,
      pnlNetPct: pnlPct,
      actualExitAmountSol,
    });
    if (closed) await unsubscribeIfNoLongerNeeded(connection, tokenAddress);
    return { type: 'closed', tokenAddress, exitReason: pending.exitReason, pnlPct: pnlPct ?? 0 };
  } catch (error) {
    const reconciled = await tryReconcileAlreadyClosedByNativeOrder(pending, tokenAddress, wallet.address, connection, error);
    if (reconciled !== null) return reconciled;
    return failLiveClose(pending, tokenAddress, error);
  }
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
): Promise<RealtimeTradeOutcome> {
  const errorMessage = error instanceof Error ? error.message : String(error);
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

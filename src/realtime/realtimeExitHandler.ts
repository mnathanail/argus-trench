import {
  closeTrade,
  getOpenTradeForTickLocked,
  listOpenTradeIdsForToken,
  updateTickState,
  type OpenTradeForTick,
} from '../db/repositories/paperTrades.js';
import { withTransaction } from '../db/tx.js';
import type { Queryable } from '../db/tx.js';
import { computePnl } from '../decision/pnl.js';
import { EXIT_TIMEOUT_MS, PAPER_ASSUMED_FEES_PCT } from '../decision/paperTradingConfig.js';
import { checkTick } from './tickExit.js';
import { priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { unsubscribeIfNoLongerNeeded } from './subscriptionManager.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';

export interface RealtimeCloseResult {
  tokenAddress: string;
  exitReason: 'tp_tier_1' | 'trailing_stop' | 'exit_signal';
  pnlPct: number;
}

export type TickDecision =
  | {
      type: 'close';
      exitReason: 'tp_tier_1' | 'trailing_stop' | 'exit_signal';
      exitPrice: number;
      exitTriggerDetail: Record<string, unknown> | null;
    }
  | { type: 'update'; newPeakPriceSinceEntry: number; newTrailingActive: boolean }
  | { type: 'ignore' };

export type TickDecisionInput = Pick<
  OpenTradeForTick,
  'simulatedEntryPrice' | 'entryAt' | 'peakPriceSinceEntry' | 'trailingActive' | 'triggerWalletAddress'
>;

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

/**
 * Καλείται σε ΚΑΘΕ εισερχόμενο trade event. ΚΛΕΙΔΩΜΕΝΗ ανάγνωση ανά trade (transaction +
 * `FOR UPDATE`) — ένα δραστήριο token μπορεί να δώσει πολλά ticks μέσα σε δευτερόλεπτα·
 * χωρίς lock, δύο ταυτόχρονα ticks θα διάβαζαν το ίδιο μπαγιάτικο peak/trailing state,
 * και το δεύτερο write θα "έσβηνε" σιωπηλά το πρώτο (lost update). Πραγματικό εύρημα
 * πλήρους ελέγχου 2026-09-09.
 */
export async function handleRealtimeTradeEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeCloseResult[]> {
  const candidateIds = await listOpenTradeIdsForToken(event.mint);
  if (candidateIds.length === 0) return [];

  const closed: RealtimeCloseResult[] = [];
  for (const id of candidateIds) {
    const result = await withTransaction(async (client) => {
      const trade = await getOpenTradeForTickLocked(id, client);
      // null: έκλεισε ήδη (periodic exit-resolver, ή προηγούμενο tick στο ίδιο batch)
      // ανάμεσα στο listOpenTradeIdsForToken() και εδώ — εντάξει, τίποτα να κάνουμε.
      if (trade === null) return null;
      return handleOneTrade(trade, event, connection, client);
    });
    if (result !== null) closed.push(result);
  }
  return closed;
}

async function handleOneTrade(
  trade: OpenTradeForTick,
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
  conn: Queryable,
): Promise<RealtimeCloseResult | null> {
  const decision = decideForTick(trade, event, new Date());

  switch (decision.type) {
    case 'ignore':
      return null;
    case 'update':
      await updateTickState(trade.id, decision.newPeakPriceSinceEntry, decision.newTrailingActive, conn);
      return null;
    case 'close': {
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
      if (!closed) return null;
      await unsubscribeIfNoLongerNeeded(connection, event.mint, conn);
      return { tokenAddress: event.mint, exitReason: decision.exitReason, pnlPct: pnl.pnlPct };
    }
  }
}

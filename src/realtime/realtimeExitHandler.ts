import {
  closeTrade,
  listOpenTradesForToken,
  updateTickState,
  type OpenTradeForTick,
} from '../db/repositories/paperTrades.js';
import { computePnl } from '../decision/pnl.js';
import { PAPER_ASSUMED_FEES_PCT } from '../decision/paperTradingConfig.js';
import { checkTick } from './tickExit.js';
import { priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { unsubscribeIfNoLongerNeeded } from './subscriptionManager.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';

export interface RealtimeCloseResult {
  tokenAddress: string;
  exitReason: 'tp_tier_1' | 'trailing_stop' | 'exit_signal';
  pnlPct: number;
}

/**
 * Καλείται σε ΚΑΘΕ εισερχόμενο trade event (και τα δύο subscription types καταλήγουν
 * εδώ, ίδιο σχήμα event — βλ. pumpportalEvents.ts). Κοιτάει ΜΟΝΟ ανοιχτά trades πάνω
 * στο ΙΔΙΟ token με το event (`event.mint`) — αυτό καλύπτει και τα δύο σενάρια:
 *   1. Το event είναι μια πώληση ΤΟΥ trigger wallet πάνω στο δικό μας token → exit_signal,
 *      ανεξάρτητα τιμής.
 *   2. Οτιδήποτε άλλο πάνω στο ίδιο token → tick τιμής, έλεγχος tier1/trailing.
 *
 * ΔΕΝ κλείνει ποτέ trades λόγω 24ωρου timeout — αυτό παραμένει δουλειά του periodic
 * exit-resolver (τίποτα δεν "συμβαίνει" σε συγκεκριμένο tick όταν απλά περνάει ο χρόνος).
 *
 * Επιστρέφει ό,τι έκλεισε πραγματικά σε αυτό το event — ο caller (main.ts) αποφασίζει
 * τι να κάνει με αυτή την πληροφορία (π.χ. Telegram notify), ίδιο σκεπτικό με το
 * runExitResolverCycle's `closed` count. Χωρίς αυτό, τα realtime closes γίνονταν
 * σιωπηλά — πραγματικό κενό, εντοπίστηκε 2026-09-09 όταν ρωτήθηκε ρητά.
 */
export async function handleRealtimeTradeEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeCloseResult[]> {
  const openTrades = await listOpenTradesForToken(event.mint);
  if (openTrades.length === 0) return [];

  const closed: RealtimeCloseResult[] = [];
  for (const trade of openTrades) {
    const result = await handleOneTrade(trade, event, connection);
    if (result !== null) closed.push(result);
  }
  return closed;
}

async function handleOneTrade(
  trade: OpenTradeForTick,
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeCloseResult | null> {
  // Σενάριο 1: το trigger wallet μόλις πούλησε αυτό ακριβώς το token — exit_signal,
  // ανεξάρτητα από την τιμή.
  if (event.txType === 'sell' && event.traderPublicKey === trade.triggerWalletAddress) {
    const price = priceFromTradeEvent(event) ?? trade.simulatedEntryPrice;
    return closeAndUnsubscribe(
      trade,
      event.mint,
      'exit_signal',
      price,
      { wallet: trade.triggerWalletAddress },
      connection,
    );
  }

  // Σενάριο 2: tick τιμής — μόνο αν έχουμε πραγματική τιμή (π.χ. όχι αν το token
  // μετακόμισε εκτός bonding curve, βλ. priceFromTradeEvent).
  const price = priceFromTradeEvent(event);
  if (price === null) return null;

  const result = checkTick({
    entryPrice: trade.simulatedEntryPrice,
    peakPriceSinceEntry: trade.peakPriceSinceEntry,
    trailingActive: trade.trailingActive,
    currentPrice: price,
  });

  if (result.exit !== null) {
    return closeAndUnsubscribe(trade, event.mint, result.exit.exitReason, result.exit.exitPrice, null, connection);
  }

  // Τίποτα δεν έκλεισε — γράψε το ενημερωμένο state για το επόμενο tick.
  if (
    result.newPeakPriceSinceEntry !== trade.peakPriceSinceEntry ||
    result.newTrailingActive !== trade.trailingActive
  ) {
    await updateTickState(trade.id, result.newPeakPriceSinceEntry, result.newTrailingActive);
  }
  return null;
}

async function closeAndUnsubscribe(
  trade: OpenTradeForTick,
  tokenAddress: string,
  exitReason: 'tp_tier_1' | 'trailing_stop' | 'exit_signal',
  exitPrice: number,
  exitTriggerDetail: Record<string, unknown> | null,
  connection: PumpPortalConnection,
): Promise<RealtimeCloseResult | null> {
  const pnl = computePnl(trade.simulatedEntryPrice, exitPrice, trade.bankrollAtEntry, trade.intendedSizePct);
  const closed = await closeTrade(trade.id, {
    exitReason,
    exitTriggerDetail,
    simulatedExitPrice: exitPrice,
    pnlSol: pnl.pnlSol,
    pnlPct: pnl.pnlPct,
    assumedFeesPct: PAPER_ASSUMED_FEES_PCT,
    pnlNetPct: pnl.pnlNetPct,
  });
  // closeTrade έχει `WHERE status='open'` guard — αν το periodic exit-resolver το είχε
  // ήδη κλείσει ανάμεσα στο listOpenTradesForToken() και εδώ (σπάνιο race, αλλά πιθανό),
  // closed θα είναι false. Δεν είναι σφάλμα — απλά κάποιος άλλος πρόλαβε πρώτος, άρα
  // ΔΕΝ επιστρέφουμε αποτέλεσμα (δεν πρέπει να ειδοποιήσουμε δύο φορές).
  if (!closed) return null;
  await unsubscribeIfNoLongerNeeded(connection, tokenAddress);
  return { tokenAddress, exitReason, pnlPct: pnl.pnlPct };
}

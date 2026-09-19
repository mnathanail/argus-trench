import {
  closeTrade,
  deactivateNativeOrder,
  listOpenLiveTradesWithNativeOrder,
  markNeedsManualExit,
  type LiveTradeWithNativeOrder,
} from '../db/repositories/paperTrades.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { estimateExitAmountSol, getStrategyOrder, inferExitReason } from '../gmgn/strategyOrders.js';
import { fetchLiveSolWallet } from '../gmgn/portfolio.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { LIVE_STRATEGY_RECONCILER_LOOP_PACING_MS } from './intervals.js';
import { delay } from '../util/delay.js';
import { unsubscribeIfNoLongerNeeded } from '../realtime/subscriptionManager.js';
import type { PumpPortalConnection } from '../realtime/pumpportalConnection.js';
import { short } from '../telegram/commands.js';

/**
 * Watchdog πάνω στα native GMGN condition-orders (2026-09-17, incident #1193 — βλ.
 * migration 0013). Το native order είναι το ΠΡΩΤΕΥΟΝ exit mechanism για live trades με
 * `native_order_active=true` (εκτελείται server-side στο GMGN, ανεξάρτητο από το δικό
 * μας process/websocket) — αυτό εδώ απλά:
 *   1. Μαθαίνει ότι μια θέση έκλεισε ΠΡΑΓΜΑΤΙΚΑ (strategy.status==='closed'), και
 *      καταγράφει το ΠΡΑΓΜΑΤΙΚΟ αποτέλεσμα — καμία προσομοίωση, macro/kline ή αλλιώς
 *      (αυτό ήταν ακριβώς το #1193 bug). Χρησιμοποιεί τις πραγματικές, on-chain
 *      open/close τιμές που το ίδιο το GMGN κατέγραψε στο strategy order.
 *   2. Μαθαίνει ότι το strategy απέτυχε/σταμάτησε ΧΩΡΙΣ να κλείσει τη θέση
 *      (`strategy_status!=='running'` ή κάποιο condition sub-order `status==='failed'`)
 *      — ενεργοποιεί το δικό μας realtime fallback (`native_order_active=false`), το
 *      decideForTick αναλαμβάνει πλήρως από το επόμενο tick.
 * ΠΟΤΕ δεν εκτελεί το ίδιο κάποιο swap — μόνο διαβάζει πραγματική κατάσταση.
 */
export interface LiveStrategyReconcilerResult {
  checked: number;
  closed: number;
  fallbackActivated: number;
  failures: number;
  alerts: string[];
}

// estimateExitAmountSol / inferExitReason: μετακομίσαν στο gmgn/strategyOrders.ts
// 2026-09-17, ώστε να τα μοιράζεται και το idempotent-guard του exit handler
// (realtimeExitHandler.ts's executeLiveCloseAndFinalize) — ίδιο σκεπτικό, δύο αφορμές.

async function reconcileOneTrade(
  trade: LiveTradeWithNativeOrder,
  walletAddress: string,
  realtimeConnection: PumpPortalConnection | undefined,
): Promise<{ outcome: 'none' | 'closed' | 'fallback'; alert: string | null }> {
  const strategy = await getStrategyOrder(walletAddress, trade.tokenAddress, trade.liveStrategyOrderId);

  if (strategy === null) {
    // Δε βρέθηκε πουθενά (ούτε open ούτε history) — δεν το εμπιστευόμαστε πια.
    await deactivateNativeOrder(trade.id);
    return {
      outcome: 'fallback',
      alert:
        `⚠️ native order δε βρέθηκε για trade #${trade.id} (${short(trade.tokenAddress)}) — ` +
        `ανέλαβε το δικό μας realtime tracking`,
    };
  }

  if (strategy.status === 'closed') {
    // ΔΙΟΡΘΩΣΗ 2026-09-19 (incident, trade #1225): το `closePrice` μπορεί να είναι null
    // ακόμα κι όταν status==='closed' — το top-level `close_price` λείπει σε ορισμένα
    // πραγματικά GMGN responses (βλ. σχόλιο στο strategyOrders.ts). Μια προηγούμενη
    // εκδοχή αυτού του κώδικα δοκίμασε να μαντέψει την τιμή από άλλα πεδία (check_price
    // του sub-order, usdt_profit) — ΚΑΙ ΤΑ ΔΥΟ αποδείχθηκαν λάθος όταν συγκρίθηκαν με το
    // πραγματικό on-chain sell amount (Solscan): το ένα έδωσε +100% αντί για το
    // πραγματικό +438.75%, το άλλο +186%. Άρα ΔΕΝ μαντεύουμε άλλο pnl από ασαφή GMGN
    // πεδία — ξέρουμε ΜΕ ΒΕΒΑΙΟΤΗΤΑ ότι η θέση έκλεισε (status==='closed'), αλλά ΟΧΙ σε
    // τι τιμή. Αυτό είναι διαφορετικό από "δεν ξέρουμε αν έκλεισε" — σημαδεύουμε
    // needs_manual_exit ώστε ο χρήστης να το επιβεβαιώσει με το πραγματικό on-chain
    // ποσό (π.χ. Solscan), ΠΟΤΕ closeTrade με μαντεμένο ή null pnl.
    if (strategy.closePrice === null) {
      await recordExecutionError({
        paperTradeId: trade.id,
        tokenAddress: trade.tokenAddress,
        action: 'sell',
        amountSol: trade.actualEntryAmountSol,
        errorMessage:
          'Live strategy reconciler: το native GMGN order έκλεισε (status=closed) αλλά ' +
          'χωρίς top-level close_price στο response — ΔΕΝ μαντεύουμε pnl από άλλα πεδία ' +
          '(επιβεβαιωμένα αναξιόπιστα, βλ. incident trade #1225). Χρειάζεται χειροκίνητη ' +
          'επιβεβαίωση του πραγματικού exit amount (π.χ. από Solscan) και reconcile.',
      });
      await markNeedsManualExit(trade.id);
      return {
        outcome: 'fallback',
        alert:
          `🕵️ native order έκλεισε για trade #${trade.id} (${short(trade.tokenAddress)}) αλλά ` +
          `χωρίς αξιόπιστη τιμή εξόδου — σημαδεύτηκε needs_manual_exit, δες /trades`,
      };
    }

    const actualExitAmountSol = estimateExitAmountSol(trade.actualEntryAmountSol, strategy.openPrice, strategy.closePrice);
    const pnlSol =
      actualExitAmountSol !== null && trade.actualEntryAmountSol !== null
        ? actualExitAmountSol - trade.actualEntryAmountSol
        : null;
    const pnlPct =
      pnlSol !== null && trade.actualEntryAmountSol !== null && trade.actualEntryAmountSol > 0
        ? pnlSol / trade.actualEntryAmountSol
        : null;
    const exitPrice = strategy.closePrice;

    const closed = await closeTrade(trade.id, {
      exitReason: inferExitReason(strategy.reasonCode),
      simulatedExitPrice: exitPrice,
      pnlSol,
      pnlPct,
      assumedFeesPct: 0, // πραγματική εκτελεσμένη τιμή GMGN, όχι παραδοχή
      pnlNetPct: pnlPct,
      actualExitAmountSol: actualExitAmountSol ?? undefined,
    });
    if (!closed) return { outcome: 'none', alert: null };
    if (realtimeConnection) await unsubscribeIfNoLongerNeeded(realtimeConnection, trade.tokenAddress);
    const emoji = (pnlPct ?? 0) > 0 ? '🟢' : '🔴';
    return {
      outcome: 'closed',
      alert:
        `⚡ ${emoji} native order έκλεισε — ${short(trade.tokenAddress)} ` +
        `pnl ${pnlPct !== null ? `${(pnlPct * 100).toFixed(1)}%` : '?'} — δες /trades`,
    };
  }

  const unhealthy = strategy.strategyStatus !== 'running' || strategy.conditionOrders.some((sub) => sub.status === 'failed');
  if (unhealthy) {
    await deactivateNativeOrder(trade.id);
    return {
      outcome: 'fallback',
      alert:
        `⚠️ native order σταμάτησε χωρίς να κλείσει τη θέση — trade #${trade.id} (${short(trade.tokenAddress)}) — ` +
        `ανέλαβε το δικό μας realtime tracking`,
    };
  }

  return { outcome: 'none', alert: null }; // υγιές, τρέχει κανονικά — τίποτα να κάνουμε
}

export async function runLiveStrategyReconcilerCycle(
  realtimeConnection?: PumpPortalConnection,
): Promise<LiveStrategyReconcilerResult> {
  const trades = await listOpenLiveTradesWithNativeOrder();
  const result: LiveStrategyReconcilerResult = { checked: 0, closed: 0, fallbackActivated: 0, failures: 0, alerts: [] };
  if (trades.length === 0) return result;

  let walletAddress: string;
  try {
    walletAddress = (await fetchLiveSolWallet()).address;
  } catch (error) {
    rethrowIfRateLimited(error);
    result.failures = trades.length;
    return result;
  }

  for (const trade of trades) {
    result.checked += 1;
    try {
      const { outcome, alert } = await reconcileOneTrade(trade, walletAddress, realtimeConnection);
      if (outcome === 'closed') result.closed += 1;
      else if (outcome === 'fallback') result.fallbackActivated += 1;
      if (alert !== null) result.alerts.push(alert);
    } catch (error) {
      rethrowIfRateLimited(error);
      result.failures += 1;
    }
    await delay(LIVE_STRATEGY_RECONCILER_LOOP_PACING_MS);
  }

  return result;
}

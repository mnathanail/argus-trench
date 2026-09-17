import { runCli, type RunOptions } from './exec.js';

/**
 * Client για `order strategy list` / `order strategy cancel` — το native, server-side
 * condition-order mechanism (profit_stop/loss_stop/profit_stop_trace/loss_stop_trace) που
 * το GMGN εκτελεί στη ΔΙΚΗ ΤΟΥ υποδομή. Εισήχθη 2026-09-17 ως πρωτεύον exit mechanism για
 * live trades — βλ. migration 0013 και comment στο src/live/liveEntryExecution.ts για το
 * γιατί (incident #1193: το δικό μας websocket-based tracking εξαρτάται εξ ολοκλήρου από
 * το δικό μας process/feed, που απέτυχαν ταυτόχρονα).
 */

export type StrategyOrderStatus = 'open' | 'closed';
export type StrategyRunningStatus = 'running' | 'stopped';
export type ConditionSubOrderStatus = 'cancel' | 'success' | 'failed';

export interface ConditionSubOrderStatusInfo {
  cid: string;
  orderType: string;
  status: ConditionSubOrderStatus;
}

export interface StrategyOrderInfo {
  orderId: string;
  status: StrategyOrderStatus;
  strategyStatus: StrategyRunningStatus;
  conditionOrders: readonly ConditionSubOrderStatusInfo[];
  openPrice: number | null;
  closePrice: number | null;
  /** ms epoch, null όταν ακόμα open. */
  closeTime: number | null;
  /** Ποιος/τι πυροδότησε το close — άδειο string όταν ακόμα open. */
  reasonBy: string;
  reasonCode: string;
  /** "Highest recorded price since open" — απευθείας από το GMGN, καμία δική μας
   * παρακολούθηση χρειάζεται για visibility όσο το native order είναι ενεργό. */
  recordHighPrice: number | null;
}

function toNumOrNull(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseConditionSubOrder(raw: unknown): ConditionSubOrderStatusInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const cid = typeof obj['cid'] === 'string' ? obj['cid'] : null;
  const orderType = typeof obj['order_type'] === 'string' ? obj['order_type'] : null;
  const status = typeof obj['status'] === 'string' ? obj['status'] : null;
  if (cid === null || orderType === null || status === null) return null;
  return { cid, orderType, status: status as ConditionSubOrderStatus };
}

function parseStrategyOrder(raw: unknown): StrategyOrderInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const orderId = typeof obj['order_id'] === 'string' ? obj['order_id'] : null;
  const status = typeof obj['status'] === 'string' ? obj['status'] : null;
  const strategyStatus = typeof obj['strategy_status'] === 'string' ? obj['strategy_status'] : null;
  if (orderId === null || status === null || strategyStatus === null) return null;

  const rawConditionOrders = Array.isArray(obj['condition_orders']) ? obj['condition_orders'] : [];
  const conditionOrders = rawConditionOrders
    .map(parseConditionSubOrder)
    .filter((o): o is ConditionSubOrderStatusInfo => o !== null);

  const closeTimeRaw = obj['close_time'];
  const closeTime = typeof closeTimeRaw === 'number' && closeTimeRaw > 0 ? closeTimeRaw : null;

  return {
    orderId,
    status: status as StrategyOrderStatus,
    strategyStatus: strategyStatus as StrategyRunningStatus,
    conditionOrders,
    openPrice: toNumOrNull(obj['open_price']),
    closePrice: toNumOrNull(obj['close_price']),
    closeTime,
    reasonBy: typeof obj['reason_by'] === 'string' ? obj['reason_by'] : '',
    reasonCode: typeof obj['reason_code'] === 'string' ? obj['reason_code'] : '',
    recordHighPrice: toNumOrNull(obj['record_high_price']),
  };
}

/**
 * Βρίσκει ΕΝΑ strategy order by id, ψάχνοντας ΚΑΙ open ΚΑΙ history (ένα ήδη-κλεισμένο
 * strategy δεν εμφανίζεται πια στο `--type open`). Δύο calls στη χειρότερη περίπτωση —
 * αποδεκτό κόστος (weight 1 έκαστο), το reconciler το καλεί αραιά (βλ. intervals.ts).
 */
export async function getStrategyOrder(
  walletAddress: string,
  tokenAddress: string,
  orderId: string,
  options: RunOptions = {},
): Promise<StrategyOrderInfo | null> {
  const openMatch = await findInStrategyList(walletAddress, tokenAddress, orderId, 'open', options);
  if (openMatch !== null) return openMatch;
  return findInStrategyList(walletAddress, tokenAddress, orderId, 'history', options);
}

async function findInStrategyList(
  walletAddress: string,
  tokenAddress: string,
  orderId: string,
  type: 'open' | 'history',
  options: RunOptions,
): Promise<StrategyOrderInfo | null> {
  const raw = await runCli(
    'order strategy list',
    [
      'order', 'strategy', 'list',
      '--chain', 'sol',
      '--group-tag', 'STMix',
      '--from', walletAddress,
      '--base-token', tokenAddress,
      '--type', type,
    ],
    options,
  );
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj['list']) ? obj['list'] : [];
  for (const item of list) {
    const parsed = parseStrategyOrder(item);
    if (parsed !== null && parsed.orderId === orderId) return parsed;
  }
  return null;
}

/** Ακυρώνει ένα ενεργό strategy order — καλείται πριν από κάθε δική μας πώληση σε trade
 * που έχει native_order_active=true (exit_signal, graduation-freeze, timeout), ώστε να
 * μην παλέψουν δύο ταυτόχρονες πωλήσεις πάνω στην ίδια θέση. Best-effort: αγνοούμε
 * σφάλμα εδώ (π.χ. το strategy έκλεισε ήδη μόνο του ανάμεσα σε ένα reconcile και τώρα)
 * — ο caller προχωράει στη δική του πώληση ούτως ή άλλως, το GMGN engine απλά δε θα
 * βρει τίποτα να εκτελέσει αν έχει ήδη κλείσει η θέση. */
export async function cancelStrategyOrderBestEffort(orderId: string, options: RunOptions = {}): Promise<boolean> {
  try {
    await runCli('order strategy cancel', ['order', 'strategy', 'cancel', '--chain', 'sol', '--order-id', orderId], options);
    return true;
  } catch {
    return false;
  }
}

import { runCli, type RunOptions } from './exec.js';

/**
 * Client για `order strategy list` / `order strategy cancel` — το native, server-side
 * condition-order mechanism (profit_stop/loss_stop/profit_stop_trace/loss_stop_trace) που
 * το GMGN εκτελεί στη ΔΙΚΗ ΤΟΥ υποδομή. Εισήχθη 2026-09-17 (incident #1193 — βλ. migration
 * 0013) ως ΑΣΦΑΛΕΙΑ/dead-man's-switch πάνω σε live trades: ο δικός μας websocket-based
 * tracker (realtimeExitHandler.ts) παραμένει ο ΠΡΩΤΕΥΩΝ exit decision engine (ρητή
 * απόφαση χρήστη, ίδια μέρα — βλ. σχόλιο στο decideForTick εκεί), αλλά αν το δικό μας
 * process/feed πέσει, αυτό εδώ συνεχίζει να τρέχει server-side, ανεξάρτητα.
 */

export type StrategyOrderStatus = 'open' | 'closed';
export type StrategyRunningStatus = 'running' | 'stopped';
export type ConditionSubOrderStatus = 'cancel' | 'success' | 'failed';

export interface ConditionSubOrderStatusInfo {
  cid: string;
  orderType: string;
  status: ConditionSubOrderStatus;
  /** Η τιμή που πυροδότησε ΑΥΤΟ ΤΟ sub-order (π.χ. το trailing-stop trigger price) —
   * null όταν απόν/μη-αριθμητικό. Προστέθηκε 2026-09-19 (ίδιο incident με το
   * `normalizeStrategyStatus` πιο κάτω, trade #1225): το top-level `close_price` του
   * strategy record μπορεί να λείπει εντελώς ακόμα κι όταν το strategy πράγματι έκλεισε
   * με επιτυχία — το `check_price` του επιτυχημένου sub-order είναι το μόνο αξιόπιστο
   * σημείο αλήθειας για την πραγματική τιμή εξόδου σε αυτή την περίπτωση. */
  checkPrice: number | null;
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
  return { cid, orderType, status: status as ConditionSubOrderStatus, checkPrice: toNumOrNull(obj['check_price']) };
}

/** Το επίσημο SKILL.md δηλώνει `status` ως αυστηρά binary: `open` / `closed` (βλ.
 * gmgn-swap/SKILL.md). ΨΕΥΔΕΣ — πραγματικό production response (incident 2026-09-19,
 * trade #1225) έδωσε `"canceled"` για ένα strategy που είχε ήδη ολοκληρώσει το exit
 * (`reason_by: "trade_finish"`, το δεύτερο sub-order ακυρώθηκε επειδή το πρώτο already
 * έκλεισε τη θέση). Πριν αυτή τη διόρθωση, το `status: status as StrategyOrderStatus`
 * περνούσε το `"canceled"` σιωπηλά μέσα από ένα ανασφαλές `as` cast χωρίς κανένα
 * runtime έλεγχο — το strategy ΕΙΧΕ πραγματικά κλείσει τη θέση με +439% κέρδος
 * (profit_stop_trace, drawdown_rate=40, status=success), αλλά το δικό μας κώδικας το
 * αντιμετώπιζε σαν να ήταν ακόμα κάτι άλλο εκτός 'closed' — ο `liveStrategyReconciler`
 * (status==='closed' check) ποτέ δεν το αναγνώρισε ως ολοκληρωμένο, ο `verifyNativeOrder`
 * στο entry path (strategyStatus!=='running' check, ξεχωριστό πεδίο) γι' αυτό δεν
 * επηρεάζεται άμεσα εδώ, αλλά ΟΠΟΙΟΣΔΗΠΟΤΕ μελλοντικός καταναλωτής του `status` θα έπεφτε
 * στην ίδια παγίδα. Άρα: ΚΑΘΕ τιμή εκτός του ρητά τεκμηριωμένου 'open' αντιμετωπίζεται
 * ως 'closed' — ένα strategy order που δεν είναι ρητά ακόμα ανοιχτό ΔΕΝ τρέχει πια,
 * ανεξάρτητα από το πώς ονομάζει το GMGN την ακριβή αιτία (canceled/closed/κάτι άλλο
 * που δεν έχουμε δει ακόμα) — ασφαλές, συντηρητικό fallback: προτιμάμε να πυροδοτήσουμε
 * περιττή reconciliation παρά να χάσουμε ξανά ένα πραγματικό κλείσιμο σιωπηλά.
 */
function normalizeStrategyStatus(raw: string): StrategyOrderStatus {
  return raw === 'open' ? 'open' : 'closed';
}

/** Exported μόνο για tests — ο πραγματικός caller είναι πάντα το `getStrategyOrder`
 * παρακάτω, ποτέ απευθείας. */
export function parseStrategyOrder(raw: unknown): StrategyOrderInfo | null {
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

  // ΔΙΟΡΘΩΣΗ 2026-09-19, ΑΝΑΘΕΩΡΗΜΕΝΗ ΤΗΝ ΙΔΙΑ ΜΕΡΑ (trade #1225): η πρώτη εκδοχή αυτού
  // του fix έκανε fallback του closePrice στο `check_price` του επιτυχημένου sub-order
  // όταν έλειπε το top-level `close_price`. ΛΑΘΟΣ — επιβεβαιώθηκε με το πραγματικό
  // on-chain sell tx στο Solscan (0.2809 SOL έναντι 0.05213 SOL entry, +438.75%): το
  // `check_price` (0.0000607) έδινε μόνο +100%, ΚΑΙ ένα δεύτερο μαντεμένο πεδίο
  // (`usdt_profit`/`buy_quote_price`) έδωσε +186% — κανένα από τα δύο δεν ταίριαζε με
  // την πραγματική τιμή. Κανένα διαθέσιμο πεδίο στο `order strategy list` response δεν
  // αποδείχθηκε αξιόπιστο για το πραγματικό εκτελεσμένο exit amount σε αυτό το σχήμα
  // response (πιθανό: το `check_price` είναι η τιμή-trigger του κανόνα, όχι η τελική
  // τιμή εκτέλεσης μετά από slippage/κίνηση της αγοράς την ώρα του swap).
  //
  // Άρα: ΔΕΝ μαντεύουμε άλλο. `closePrice` μένει αυστηρά το ρητό top-level `close_price`
  // (όταν υπάρχει) — τίποτα άλλο. Ο caller (liveStrategyReconciler.ts) ΠΡΕΠΕΙ να χειριστεί
  // `closePrice === null` σε ένα strategy που είναι `status==='closed'` σαν "ξέρουμε ΟΤΙ
  // έκλεισε αλλά ΟΧΙ σε τι τιμή" — needs_manual_exit, ΠΟΤΕ closeTrade με μαντεμένο/null pnl.
  const closePrice = toNumOrNull(obj['close_price']);

  return {
    orderId,
    status: normalizeStrategyStatus(status),
    strategyStatus: strategyStatus as StrategyRunningStatus,
    conditionOrders,
    openPrice: toNumOrNull(obj['open_price']),
    closePrice,
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

/** Τιμή price-ratio από το ίδιο το GMGN strategy record (open_price/close_price —
 * πραγματικές on-chain εκτελεσμένες τιμές, ΟΧΙ kline/simulation) εφαρμοσμένη πάνω στο
 * ήδη γνωστό, πραγματικό `actualEntryAmountSol` — προσέγγιση του πραγματικού SOL που
 * εισπράχθηκε (το condition-order response δίνει token price/decimals, όχι απευθείας
 * SOL settlement amount, και με πολλαπλά ταυτόχρονα ανοιχτά live trades ένα απλό
 * wallet-balance-diff δε θα μπορούσε να απομονώσει ΠΟΙΟ trade έκλεισε). Κοινό μεταξύ
 * του reconciler (collectors/liveStrategyReconciler.ts) ΚΑΙ του exit handler's
 * idempotent-guard (realtimeExitHandler.ts) — και τα δύο μονοπάτια μαθαίνουν για ένα
 * ήδη-κλεισμένο native order, μόνο από διαφορετική αφορμή. */
export function estimateExitAmountSol(
  actualEntryAmountSol: number | null,
  openPrice: number | null,
  closePrice: number | null,
): number | null {
  if (actualEntryAmountSol === null || openPrice === null || openPrice <= 0 || closePrice === null) return null;
  return actualEntryAmountSol * (closePrice / openPrice);
}

/** Το GMGN `reason_code`/`order_type` του πυροδοτημένου sub-order δε χαρτογραφείται 1:1
 * στο δικό μας ExitReason enum — δεν έχουμε ρητή τεκμηρίωση του πλήρους συνόλου τιμών.
 * `trailing_stop` είναι η σωστή προεπιλογή: αυτό είναι το ΜΟΝΟ sub-order type που βάζουμε
 * πλέον σε live trades (`liveExitConditionOrders()`) εκτός από `loss_stop`. */
export function inferExitReason(strategyReasonCode: string): 'trailing_stop' | 'stop_loss' {
  return /loss/i.test(strategyReasonCode) ? 'stop_loss' : 'trailing_stop';
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

import { runCli, type RunOptions } from './exec.js';
import { GmgnResponseError } from './errors.js';
import { config } from '../config.js';
import { delay } from '../util/delay.js';

/**
 * `So11111111111111111111111111111111111111112` — ΟΧΙ το `...111` που επιστρέφει το
 * `portfolio info` σαν δείκτης "αυτό είναι native SOL" στο balance display. Το επίσημο
 * SKILL.md το λέει ρητά: "A wrong address... will cause silent failures or
 * 'jupiter has no route' errors with no clear indication of what went wrong."
 * Επιβεβαιωμένο από ΔΥΟ ανεξάρτητες πηγές: το GMGN's δικό τους reference demo
 * (aitrader/app.py) ΚΑΙ το επίσημο SKILL.md — 2026-09-11.
 */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Πόσες φορές να κάνουμε poll το order status πριν το αναφέρουμε ως "άγνωστο, ακόμα σε
 * εξέλιξη" (ΟΧΙ αποτυχία) — 3×5s, ίδιο με τη σύσταση του επίσημου SKILL.md. */
const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5_000;

/** Πραγματικές συναλλαγές έχουν προτεραιότητα έναντι ΟΛΩΝ των υπόλοιπων routine
 * collectors (wallet-scoring/discovery/exit-resolver) στην ΚΟΙΝΗ ουρά του rate limiter —
 * υψηλότερη ακόμα κι από το exit-resolver's δικό του 100-200 (βλ. collectors/exitResolver.ts).
 * Δεν λύνει το αν το bucket είναι ήδη μπλοκαρισμένο (429 recovery window, βλ.
 * rateLimiter.ts) — μόνο εξασφαλίζει ότι, μόλις υπάρξει διαθέσιμος χώρος, το trade
 * εξυπηρετείται ΠΡΩΤΟ, όχι πίσω από μια ουρά αναμονής routine κλήσεων.
 */
const TRADE_PRIORITY = 1000;

const FILLED_STATUSES = new Set(['confirmed', 'processed', 'successful']);
const FAILED_STATUSES = new Set(['failed', 'expired']);

export interface SwapExecutionResult {
  /** true ΜΟΝΟ όταν το status έφτασε σε γνωστά-επιτυχή τιμή — ΠΟΤΕ "submit = success". */
  filled: boolean;
  status: string;
  orderId: string | null;
  txHash: string | null;
  /** report.price — πραγματική εκτελεσμένη τιμή, ΜΟΝΟ όταν filled. null αλλιώς. */
  executedPrice: number | null;
  /** `strategy_order_id` — μόνο όταν περάσαμε `--condition-orders` ΚΑΙ η δημιουργία του
   * strategy πέτυχε (best-effort, βλ. SKILL.md: "if the swap succeeds but strategy
   * creation fails, the swap result is still returned"). null σε κάθε άλλη περίπτωση —
   * ο caller ΠΡΕΠΕΙ να το αντιμετωπίσει σαν "χωρίς προστασία", ΟΧΙ σαν σφάλμα. */
  strategyOrderId: string | null;
}

/** Ένα condition sub-order για `--condition-orders` (βλ. gmgn-swap SKILL.md). Δεν
 * τυποποιούμε πλήρες το σχήμα εδώ (πολλά προαιρετικά fields ανά order_type) — απλά
 * περνάμε ό,τι μας δώσει ο caller (βλ. `liveExitConditionOrders()` στο
 * paperTradingConfig.ts) ως-έχει στο CLI. */
export type ConditionOrder = Record<string, unknown>;

/** Πετάει όταν το swap ρητά ΑΠΕΤΥΧΕ (error_code/status='failed'/'expired') — ο caller
 * ΔΕΝ πρέπει να καταγράψει θέση σε αυτή την περίπτωση. Ξεχωριστό από ένα ασαφές
 * "ακόμα σε εξέλιξη" (filled:false, ΧΩΡΙΣ exception) μετά το τέλος του polling.
 *
 * `errorCode` — το ρητό GMGN `error_code`, null όταν το failure ήταν status-based
 * (`failed`/`expired`, χωρίς δομημένο error_code). Προστέθηκε 2026-09-17 ώστε ο caller
 * να μπορεί να αναγνωρίσει συγκεκριμένα business errors (π.χ. `40003701` = "insufficient
 * token balance", βλ. gmgn-swap SKILL.md) χωρίς να κάνει regex πάνω στο μήνυμα. */
export class SwapFailedError extends Error {
  constructor(
    message: string,
    readonly status: string,
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = 'SwapFailedError';
  }
}

/** `40003701` — τεκμηριωμένο GMGN business error code, "insufficient token balance"
 * (βλ. gmgn-swap SKILL.md, γραμμή για το error-count limiter). Χρησιμοποιείται ως
 * σήμα ότι μια θέση πιθανόν έχει ήδη κλείσει αλλού (π.χ. native GMGN condition-order,
 * βλ. migration 0013) ΠΡΙΝ προλάβει η δική μας πώληση — βλ.
 * realtimeExitHandler.ts's executeLiveCloseAndFinalize. */
export const INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE = '40003701';

/** Πετάει αν κληθεί χωρίς GMGN_ALLOW_AUTOMATED_TRADES=1 — δεν προσπαθεί καν να καλέσει
 * το CLI (που ούτως ή άλλως θα κρεμούσε περιμένοντας interactive επιβεβαίωση από
 * τερματικό που δεν υπάρχει σε αυτό το process). Ίδιο, διπλό guard με το ίδιο το CLI. */
export class AutomatedTradesDisabledError extends Error {
  constructor() {
    super('GMGN_ALLOW_AUTOMATED_TRADES δεν είναι 1 — αρνούμαι να επιχειρήσω πραγματικό swap.');
    this.name = 'AutomatedTradesDisabledError';
  }
}

function solToLamports(sol: number): string {
  return String(Math.round(sol * LAMPORTS_PER_SOL));
}

export function parseSwapResponse(raw: unknown): SwapExecutionResult {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const errorCode = obj['error_code'];
  const errorStatus = obj['error_status'];
  if (typeof errorCode === 'string' && errorCode !== '') {
    throw new SwapFailedError(`swap error_code=${errorCode} ${String(errorStatus ?? '')}`.trim(), 'error', errorCode);
  }
  const status = typeof obj['status'] === 'string' ? obj['status'] : 'pending';
  const orderId = typeof obj['order_id'] === 'string' ? obj['order_id'] : null;
  const txHash = typeof obj['hash'] === 'string' ? obj['hash'] : null;
  const report = typeof obj['report'] === 'object' && obj['report'] !== null ? (obj['report'] as Record<string, unknown>) : null;
  const executedPrice = report !== null && typeof report['price'] === 'string' ? Number(report['price']) : null;
  const strategyOrderId = typeof obj['strategy_order_id'] === 'string' && obj['strategy_order_id'] !== ''
    ? obj['strategy_order_id']
    : null;
  return { filled: FILLED_STATUSES.has(status), status, orderId, txHash, executedPrice, strategyOrderId };
}

/** Poll `order get` μέχρι τελικό status ή εξάντληση προσπαθειών — ΠΟΤΕ δεν αναφέρει
 * επιτυχία μόνο επειδή το submit πέτυχε (βλ. SKILL.md + GMGN's δικό τους demo, και τα
 * δύο ρητά προειδοποιούν ακριβώς για αυτό). */
async function pollUntilTerminal(orderId: string, initial: SwapExecutionResult, options: RunOptions): Promise<SwapExecutionResult> {
  let current = initial;
  // `order get` δεν επιστρέφει ξανά `strategy_order_id` (μόνο το αρχικό `swap` response
  // το έχει) — κρατάμε το αρχικό ρητά, αλλιώς θα χανόταν σιωπηλά στο πρώτο poll.
  const strategyOrderId = initial.strategyOrderId;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (FILLED_STATUSES.has(current.status) || FAILED_STATUSES.has(current.status)) break;
    await delay(POLL_INTERVAL_MS);
    try {
      const raw = await runCli('order get', ['order', 'get', '--chain', 'sol', '--order-id', orderId], options);
      current = { ...parseSwapResponse(raw), strategyOrderId };
    } catch (error) {
      if (error instanceof SwapFailedError) throw error;
      break; // δικτυακό/παροδικό σφάλμα στο ίδιο το poll — σταμάτα, ανέφερε ό,τι ξέραμε
    }
  }
  if (FAILED_STATUSES.has(current.status)) {
    throw new SwapFailedError(`swap status=${current.status}` + (current.txHash ? ` (${current.txHash})` : ''), current.status);
  }
  return current;
}

/** Ελάχιστα, ασφαλή defaults — το SKILL.md απαιτεί και τα δύο flags όποτε περνάμε
 * `--condition-orders` σε sol. Τιμές πολύ πάνω από τα ρητά ελάχιστα (0.00001) του
 * SKILL.md, ώστε να μην κολλήσει η strategy creation σε peak congestion. */
const CONDITION_ORDER_PRIORITY_FEE_SOL = '0.00002';
const CONDITION_ORDER_TIP_FEE_SOL = '0.00002';

/**
 * Αγορά — input=SOL (currency, άρα ΠΑΝΤΑ --amount, ΠΟΤΕ --percent, βλ. SKILL.md).
 * Πετάει `AutomatedTradesDisabledError` αν λείπει το flag, `SwapFailedError` αν το ίδιο
 * το swap απέτυχε ρητά — ο caller ΔΕΝ πρέπει να καταγράψει θέση σε καμία από τις δύο.
 * Δεν καταγράφει τίποτα σε βάση — αυτό είναι δουλειά του caller.
 *
 * `conditionOrders`, αν δοθεί, περνάει `--condition-orders` (μαζί με τα υποχρεωτικά
 * `--priority-fee`/`--tip-fee` σε sol) — δημιουργεί ΤΗΝ ΙΔΙΑ ΣΤΙΓΜΗ ένα native, server-side
 * GMGN strategy order (trailing-stop/stop-loss) πάνω στη θέση, ανεξάρτητο από το αν το
 * δικό μας process/websocket είναι ζωντανό αργότερα (βλ. migration 0013). Η δημιουργία
 * είναι best-effort — το `result.strategyOrderId` μπορεί να είναι null ακόμα κι όταν το
 * ίδιο το swap πέτυχε πλήρως· ο caller ΠΡΕΠΕΙ να το επιβεβαιώσει ξεχωριστά (βλ.
 * `getLiveExitStrategy` στο strategyOrders.ts) πριν το εμπιστευτεί.
 */
export async function executeLiveBuy(
  walletAddress: string,
  outputToken: string,
  amountSol: number,
  options: RunOptions = {},
  conditionOrders?: readonly ConditionOrder[],
): Promise<SwapExecutionResult> {
  if (!config.automatedTradesAllowed()) throw new AutomatedTradesDisabledError();
  const tradeOptions: RunOptions = { priority: TRADE_PRIORITY, ...options };

  const conditionOrderArgs =
    conditionOrders !== undefined && conditionOrders.length > 0
      ? [
          '--condition-orders', JSON.stringify(conditionOrders),
          '--priority-fee', CONDITION_ORDER_PRIORITY_FEE_SOL,
          '--tip-fee', CONDITION_ORDER_TIP_FEE_SOL,
        ]
      : [];

  const raw = await runCli(
    'swap',
    [
      'swap',
      '--chain', 'sol',
      '--from', walletAddress,
      '--input-token', WSOL_MINT,
      '--output-token', outputToken,
      '--amount', solToLamports(amountSol),
      '--auto-slippage', // συνιστάται ρητά για ασταθή tokens (memecoins) στο SKILL.md
      '--anti-mev',
      ...conditionOrderArgs,
      '--yes',
    ],
    tradeOptions,
  );
  const result = parseSwapResponse(raw);
  if (FAILED_STATUSES.has(result.status)) {
    throw new SwapFailedError(`swap status=${result.status}`, result.status);
  }
  if (result.orderId === null) return result; // ασυνήθιστο, αλλά τίποτα άλλο να κάνουμε
  return pollUntilTerminal(result.orderId, result, tradeOptions);
}

/**
 * Πώληση — ΟΛΟΚΛΗΡΗ η θέση (`--percent 100`), input=το ίδιο το token (ΟΧΙ currency,
 * άρα επιτρέπεται --percent, βλ. SKILL.md) — αποφεύγει να χρειαστεί να υπολογίσουμε
 * ακριβές ποσό/decimals του token που κρατάμε.
 */
export async function executeLiveSell(
  walletAddress: string,
  inputToken: string,
  options: RunOptions = {},
): Promise<SwapExecutionResult> {
  if (!config.automatedTradesAllowed()) throw new AutomatedTradesDisabledError();
  const tradeOptions: RunOptions = { priority: TRADE_PRIORITY, ...options };

  const raw = await runCli(
    'swap',
    [
      'swap',
      '--chain', 'sol',
      '--from', walletAddress,
      '--input-token', inputToken,
      '--output-token', WSOL_MINT,
      '--percent', '100',
      '--auto-slippage',
      '--anti-mev',
      '--yes',
    ],
    tradeOptions,
  );
  const result = parseSwapResponse(raw);
  if (FAILED_STATUSES.has(result.status)) {
    throw new SwapFailedError(`swap status=${result.status}`, result.status);
  }
  if (result.orderId === null) return result;
  return pollUntilTerminal(result.orderId, result, tradeOptions);
}

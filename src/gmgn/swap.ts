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
}

/** Πετάει όταν το swap ρητά ΑΠΕΤΥΧΕ (error_code/status='failed'/'expired') — ο caller
 * ΔΕΝ πρέπει να καταγράψει θέση σε αυτή την περίπτωση. Ξεχωριστό από ένα ασαφές
 * "ακόμα σε εξέλιξη" (filled:false, ΧΩΡΙΣ exception) μετά το τέλος του polling. */
export class SwapFailedError extends Error {
  constructor(
    message: string,
    readonly status: string,
  ) {
    super(message);
    this.name = 'SwapFailedError';
  }
}

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
    throw new SwapFailedError(`swap error_code=${errorCode} ${String(errorStatus ?? '')}`.trim(), 'error');
  }
  const status = typeof obj['status'] === 'string' ? obj['status'] : 'pending';
  const orderId = typeof obj['order_id'] === 'string' ? obj['order_id'] : null;
  const txHash = typeof obj['hash'] === 'string' ? obj['hash'] : null;
  const report = typeof obj['report'] === 'object' && obj['report'] !== null ? (obj['report'] as Record<string, unknown>) : null;
  const executedPrice = report !== null && typeof report['price'] === 'string' ? Number(report['price']) : null;
  return { filled: FILLED_STATUSES.has(status), status, orderId, txHash, executedPrice };
}

/** Poll `order get` μέχρι τελικό status ή εξάντληση προσπαθειών — ΠΟΤΕ δεν αναφέρει
 * επιτυχία μόνο επειδή το submit πέτυχε (βλ. SKILL.md + GMGN's δικό τους demo, και τα
 * δύο ρητά προειδοποιούν ακριβώς για αυτό). */
async function pollUntilTerminal(orderId: string, initial: SwapExecutionResult, options: RunOptions): Promise<SwapExecutionResult> {
  let current = initial;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (FILLED_STATUSES.has(current.status) || FAILED_STATUSES.has(current.status)) break;
    await delay(POLL_INTERVAL_MS);
    try {
      const raw = await runCli('order get', ['order', 'get', '--chain', 'sol', '--order-id', orderId], options);
      current = parseSwapResponse(raw);
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

/**
 * Αγορά — input=SOL (currency, άρα ΠΑΝΤΑ --amount, ΠΟΤΕ --percent, βλ. SKILL.md).
 * Πετάει `AutomatedTradesDisabledError` αν λείπει το flag, `SwapFailedError` αν το ίδιο
 * το swap απέτυχε ρητά — ο caller ΔΕΝ πρέπει να καταγράψει θέση σε καμία από τις δύο.
 * Δεν καταγράφει τίποτα σε βάση — αυτό είναι δουλειά του caller.
 */
export async function executeLiveBuy(
  walletAddress: string,
  outputToken: string,
  amountSol: number,
  options: RunOptions = {},
): Promise<SwapExecutionResult> {
  if (!config.automatedTradesAllowed()) throw new AutomatedTradesDisabledError();

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
      '--yes',
    ],
    options,
  );
  const result = parseSwapResponse(raw);
  if (FAILED_STATUSES.has(result.status)) {
    throw new SwapFailedError(`swap status=${result.status}`, result.status);
  }
  if (result.orderId === null) return result; // ασυνήθιστο, αλλά τίποτα άλλο να κάνουμε
  return pollUntilTerminal(result.orderId, result, options);
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
    options,
  );
  const result = parseSwapResponse(raw);
  if (FAILED_STATUSES.has(result.status)) {
    throw new SwapFailedError(`swap status=${result.status}`, result.status);
  }
  if (result.orderId === null) return result;
  return pollUntilTerminal(result.orderId, result, options);
}

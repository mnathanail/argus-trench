import { db, type Queryable } from '../tx.js';

export interface NewTradeExecutionError {
  /** null όταν η αποτυχία ήταν στο entry, πριν καν υπάρξει paper_trades row. */
  paperTradeId: number | null;
  tokenAddress: string;
  action: 'buy' | 'sell';
  amountSol: number | null;
  errorMessage: string;
  /** Το πλήρες, ωμό σφάλμα (π.χ. SwapFailedError.output) — ό,τι έχουμε, χωρίς επιμέλεια.
   * `unknown` γιατί το ίδιο το error object δεν είναι πάντα JSON-serializable απευθείας
   * (π.χ. Error instances) — το γράφουμε defensively. */
  errorDetail?: unknown;
}

/**
 * ΔΙΟΡΘΩΣΗ 2026-09-28 (πραγματικό incident, trade 6490): για Error κρατούσαμε μόνο
 * name/message/stack — ΟΧΙ τα δικά του πεδία. Το `GmgnCliError.output` (ολόκληρο το
 * stdout+stderr του gmgn-cli, δηλαδή ο πραγματικός λόγος αποτυχίας) χανόταν έτσι
 * εντελώς, και μια λάθος σύνοψη στο error_message δεν είχε καμία εφεδρεία στη βάση.
 * Τώρα αποθηκεύονται και όλα τα own enumerable πεδία (output, exitCode, command,
 * errorCode, status, ...), και το `cause` αναδρομικά.
 */
export function serializeErrorDetail(detail: unknown): string | null {
  if (detail === undefined) return null;
  if (detail instanceof Error) {
    return JSON.stringify(errorToPlain(detail));
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return JSON.stringify({ raw: String(detail) });
  }
}

function errorToPlain(error: Error, depth = 0): Record<string, unknown> {
  const plain: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack };
  for (const [key, value] of Object.entries(error)) {
    if (key in plain) continue;
    plain[key] = value;
  }
  if (error.cause !== undefined && depth < 3) {
    plain['cause'] = error.cause instanceof Error ? errorToPlain(error.cause, depth + 1) : error.cause;
  }
  return plain;
}

/**
 * Καταγράφει ΚΑΘΕ αποτυχημένη πραγματική προσπάθεια swap — τα πάντα, χωρίς επιμέλεια
 * (ρητό αίτημα χρήστη 2026-09-15): πότε, τι μήνυμα, ποιο token, τι ποσό. Ξεχωριστός
 * πίνακας από το paper_trades — μπορεί να υπάρξουν πολλαπλές αποτυχημένες προσπάθειες
 * για το ΙΔΙΟ trade πριν την επιτυχή, χειροκίνητη.
 */
export async function recordExecutionError(input: NewTradeExecutionError, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `INSERT INTO trade_execution_errors
       (paper_trade_id, token_address, action, amount_sol, error_message, error_detail_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.paperTradeId,
      input.tokenAddress,
      input.action,
      input.amountSol,
      input.errorMessage,
      serializeErrorDetail(input.errorDetail),
    ],
  );
}

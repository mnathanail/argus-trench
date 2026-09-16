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

function serializeErrorDetail(detail: unknown): string | null {
  if (detail === undefined) return null;
  if (detail instanceof Error) {
    return JSON.stringify({ name: detail.name, message: detail.message, stack: detail.stack });
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return JSON.stringify({ raw: String(detail) });
  }
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

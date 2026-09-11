import { db, type Queryable } from '../tx.js';

export interface LiveTradingHaltState {
  haltedAt: Date | null;
  haltedReason: string | null;
}

/** Τρέχον halt state — single-row πίνακας, βλ. migration 0010. */
export async function getLiveHaltState(conn?: Queryable): Promise<LiveTradingHaltState> {
  const { rows } = await db(conn).query<{ halted_at: Date | null; halted_reason: string | null }>(
    `SELECT halted_at, halted_reason FROM live_trading_state WHERE id = 1`,
  );
  const row = rows[0];
  return { haltedAt: row?.halted_at ?? null, haltedReason: row?.halted_reason ?? null };
}

/** Ενεργοποιεί το kill-switch — ΜΕΝΕΙ έτσι μέχρι ρητό `clearLiveHalt()` (χειροκίνητο,
 * ΠΟΤΕ αυτόματο — ρητή απόφαση χρήστη 2026-09-11). Idempotent: αν είναι ήδη halted, δεν
 * αντικαθιστά το αρχικό `halted_at`/`halted_reason` — κρατάμε πότε ΠΡΩΤΟΠΡΩΤΑ σκάλωσε. */
export async function setLiveHalted(reason: string, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `UPDATE live_trading_state SET halted_at = COALESCE(halted_at, now()), halted_reason = COALESCE(halted_reason, $1) WHERE id = 1`,
    [reason],
  );
}

/** Χειροκίνητο reset — καλείται ΜΟΝΟ από ρητή ενέργεια χρήστη (π.χ. Telegram εντολή). */
export async function clearLiveHalt(conn?: Queryable): Promise<void> {
  await db(conn).query(`UPDATE live_trading_state SET halted_at = NULL, halted_reason = NULL WHERE id = 1`);
}

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

/**
 * Ατομική «κράτηση» πραγματικού κεφαλαίου — αποτρέπει δύο σχεδόν-ταυτόχρονα σήματα (σε
 * ΔΙΑΦΟΡΕΤΙΚΑ tokens) να δουν το ΙΔΙΟ, ακόμα-αναλλοίωτο on-chain balance και να
 * προχωρήσουν και τα δύο σε live buy, δεσμεύοντας μαζί παραπάνω κεφάλαιο απ' όσο
 * πραγματικά υπάρχει (πραγματικό ρίσκο εντοπίστηκε 2026-09-15, βλ. migration 0012).
 *
 * Ο caller περνάει το ΤΕΛΕΥΤΑΙΟ γνωστό, πραγματικό balance — fetched ΕΚΤΟΣ αυτής της
 * κλήσης (εδώ μέσα ΚΑΝΕΝΑ external network call, μόνο ένα γρήγορο, ατομικό UPDATE). Ένα
 * μονό UPDATE statement με WHERE πάνω στο ίδιο πεδίο που ενημερώνει (`reserved_sol`)
 * σειριοποιείται σωστά από το ίδιο το Postgres — δύο ταυτόχρονες κλήσεις στην ΙΔΙΑ
 * γραμμή δεν μπορούν να δουν και οι δύο την ΙΔΙΑ, μπαγιάτικη τιμή του reserved_sol.
 *
 * Επιστρέφει true αν κρατήθηκε επιτυχώς (προχώρα σε πραγματικό swap), false αν όχι
 * (πέσε σε log_only — κάποιος άλλος μόλις δέσμευσε ό,τι έμενε). ΠΑΝΤΑ κάλεσε
 * releaseLiveCapital μετά από μια επιτυχή κράτηση, ό,τι κι αν συνέβη στο ίδιο το swap.
 */
export async function reserveLiveCapital(
  realBalanceSol: number,
  amountSol: number,
  conn?: Queryable,
): Promise<boolean> {
  const result = await db(conn).query(
    `UPDATE live_trading_state SET reserved_sol = reserved_sol + $2
      WHERE id = 1 AND ($1 - reserved_sol) >= $2`,
    [realBalanceSol, amountSol],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Απελευθερώνει μια κράτηση — καλείται ΠΑΝΤΑ μετά από reserveLiveCapital που πέτυχε,
 * ανεξάρτητα αν το ίδιο το swap πέτυχε ή απέτυχε. `GREATEST(0, ...)` σαν άμυνα κατά
 * τυχόν ασυμφωνίας λογιστικής (π.χ. διπλό release) — ποτέ αρνητικό reserved_sol. */
export async function releaseLiveCapital(amountSol: number, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `UPDATE live_trading_state SET reserved_sol = GREATEST(0, reserved_sol - $1) WHERE id = 1`,
    [amountSol],
  );
}

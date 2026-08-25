/**
 * Row-mapping helpers.
 *
 * Το node-postgres επιστρέφει `NUMERIC` και `BIGINT` ως **strings** (επιβεβαιωμένο στο
 * dev Postgres: `1::bigint` → `"1"`, `0.62::numeric(5,4)` → `"0.6200"`), επειδή δε χωρούν
 * πάντα σε IEEE double. Το ύπουλο είναι ότι οι συγκρίσεις *φαίνεται* να δουλεύουν λόγω
 * coercion — `"0.6200" > 0.5` είναι `true` — άρα ένα `win_rate` σαν string περνά απαρατή-
 * ρητο μέχρι να γίνει αριθμητική: `"1.5" + "2.5"` δίνει `"1.52.5"`, όχι `4`.
 *
 * Γι' αυτό κάθε numeric/bigint περνά ρητά από εδώ. Τα `INTEGER`, `BOOLEAN`, `JSONB` και
 * `TIMESTAMPTZ` έρχονται σωστά τυποποιημένα (number / boolean / object / Date) και δε
 * χρειάζονται μετατροπή.
 *
 * Δεν βάζουμε global `pg.types.setTypeParser` επίτηδες: θα άλλαζε σιωπηλά τη συμπεριφορά
 * κάθε query στο process, συμπεριλαμβανομένων μελλοντικών όπου το precision μετράει.
 */

/** Τα BIGSERIAL ids μας μένουν άνετα κάτω από το `Number.MAX_SAFE_INTEGER`. */
export function toNum(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function toNumOrNull(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : toNum(value);
}

export function requireRow<T>(rows: readonly T[], context: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${context}: expected at least one row, got none`);
  }
  return row;
}

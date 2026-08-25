import { GmgnResponseError } from './errors.js';

/**
 * Ελάχιστο runtime validation, χωρίς schema library.
 *
 * Ο σκοπός δεν είναι πλήρης επικύρωση — είναι να **σκάσει δυνατά και με context** όταν το
 * response αλλάξει σχήμα, αντί να παράγει `undefined` που ταξιδεύει μέχρι τη βάση. Έχει
 * ήδη συμβεί: το documentation έλεγε `data.pump` και `type`/`transaction_hash`, η
 * πραγματικότητα είναι `near_completion` και `event_type`/`tx_hash`.
 */

export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GmgnResponseError(`expected an object, got ${describe(value)}`, path);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GmgnResponseError(`expected an array, got ${describe(value)}`, path);
  }
  return value;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new GmgnResponseError(`expected a string, got ${describe(value)}`, path);
  }
  return value;
}

/**
 * Δέχεται ΚΑΙ number ΚΑΙ numeric string επίτηδες: το `market trenches` επιστρέφει
 * `rug_ratio` ως number, ενώ το `portfolio activity` επιστρέφει `cost_usd` ως string
 * (επιβεβαιωμένο με πραγματικά calls). Μία helper αντί για δύο κώδικες, ώστε ο adapter
 * να μη σπάσει αν κάποιο endpoint αλλάξει πλευρά.
 */
export function toNumber(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new GmgnResponseError(`expected a number, got ${describe(value)}`, path);
}

/** Για optional πεδία: null/undefined/'' περνούν ως null αντί να σκάσουν. */
export function toNumberOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  return toNumber(value, path);
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

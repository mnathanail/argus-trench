export class GmgnError extends Error {}

/** Το CLI γύρισε non-zero. Τα μηνύματά του είναι κείμενο με prefix `[gmgn-cli]`, όχι JSON. */
export class GmgnCliError extends GmgnError {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly output: string,
    readonly command: readonly string[],
  ) {
    super(message);
    this.name = 'GmgnCliError';
  }
}

/**
 * 429. ΔΕΝ κάνουμε αυτόματο retry: κάθε request μέσα στο cooldown επεκτείνει το ban κατά
 * 5s, έως 5 λεπτά. Ο caller (scheduler) πρέπει να σεβαστεί το `retryAt` και να σταματήσει
 * τον κύκλο — όχι να ξαναπροσπαθήσει.
 */
export class GmgnRateLimitError extends GmgnError {
  constructor(
    message: string,
    readonly retryAt: Date | null,
    readonly output: string,
  ) {
    super(message);
    this.name = 'GmgnRateLimitError';
  }
}

/**
 * Το response δεν είχε το σχήμα που περιμέναμε. Χωριστός τύπος επίτηδες: σημαίνει ότι το
 * CLI/API άλλαξε από κάτω μας, που είναι εντελώς άλλο πρόβλημα από ένα network error και
 * θέλει άνθρωπο, όχι retry. Βλ. CLAUDE.md "Verified CLI contract" — έχει συμβεί ήδη ότι
 * το documentation διαφωνεί με την πραγματικότητα.
 */
export class GmgnResponseError extends GmgnError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = 'GmgnResponseError';
  }
}

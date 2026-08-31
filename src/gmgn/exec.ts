import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GmgnCliError, GmgnRateLimitError, GmgnResponseError } from './errors.js';
import { LIMITER_CAPACITY, LIMITER_REFILL_PER_SECOND, ROUTE_WEIGHTS, type RouteKey } from './routes.js';
import { TokenBucket } from './rateLimiter.js';

const execFileAsync = promisify(execFile);

// src/gmgn/ -> project root -> node_modules/.bin/  (ίδιο βάθος για dist/gmgn/, βλ. migrate.ts)
// Exported ώστε ένα test να επιβεβαιώνει ότι το binary υπάρχει ΠΑΝΤΑ μετά από `npm install` —
// αν κάποιος αφαιρέσει κατά λάθος το `gmgn-cli` από τα package.json dependencies, να σκάσει
// εδώ, όχι σιωπηλά σε ένα Railway deploy.
export const LOCAL_CLI_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/.bin/gmgn-cli',
);

/**
 * `gmgn-cli` είναι project dependency (`package.json`), όχι global install — έτσι
 * δουλεύει το ίδιο τοπικά και στο Railway build, χωρίς κανένα χειροκίνητο `npm install -g`
 * βήμα στο production image.
 *
 * Δε βασιζόμαστε στο PATH: αν το process ξεκινήσει χωρίς να περάσει από `npm run`/`npm
 * start` (π.χ. απευθείας `node dist/main.js`), το `node_modules/.bin` δεν είναι
 * εγγυημένο εκεί. Αντ' αυτού λύνουμε το path module-relative — ίδιο pattern με το
 * `migrations/` στο `db/migrate.ts` — και πέφτουμε πίσω σε bare `gmgn-cli` μόνο αν το
 * τοπικό binary δε βρεθεί (π.χ. ασυνήθιστο install layout).
 *
 * `GMGN_CLI_BIN` παραμένει override για tests ή ρητά διαφορετικό path. Διαβάζεται σε
 * κάθε κλήση, όχι σε module load, ώστε να μη παγώνει πριν στηθεί το environment.
 */
function cliBin(): string {
  if (process.env.GMGN_CLI_BIN) return process.env.GMGN_CLI_BIN;
  return existsSync(LOCAL_CLI_BIN) ? LOCAL_CLI_BIN : 'gmgn-cli';
}

/**
 * Ένας limiter για όλο το process. Ταιριάζει με την απόφαση "ένα Node process" — αν
 * σπάσουμε σε πολλά services, το budget θα πρέπει να συντονιστεί αλλιώς (κοινός limiter
 * σε Redis ή διαμοιρασμός του rate), γιατί ο περιορισμός είναι server-side ανά API key.
 */
const limiter = new TokenBucket(LIMITER_CAPACITY, LIMITER_REFILL_PER_SECOND);

export function limiterAvailable(): number {
  return limiter.available;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Higher values are served first when requests wait in the shared limiter queue. */
  priority?: number;
  /** Το `--raw` μπαίνει αυτόματα· δώσε false μόνο αν θέλεις το human-readable output. */
  raw?: boolean;
}

/**
 * Εκτελεί ένα read-only `gmgn-cli` command και επιστρέφει το parsed JSON.
 *
 * Χρησιμοποιεί `execFile` με argv array, ΟΧΙ shell — τα token/wallet addresses έρχονται
 * από εξωτερικό API και δε πρέπει ποτέ να περάσουν από shell interpolation.
 */
export async function runCli(
  route: RouteKey,
  args: readonly string[],
  options: RunOptions = {},
): Promise<unknown> {
  const weight = ROUTE_WEIGHTS[route];
  await limiter.acquire(weight, options.priority);

  const argv = options.raw === false ? [...args] : [...args, '--raw'];

  let stdout: string;
  try {
    const result = await execFileAsync(cliBin(), argv, {
      timeout: options.timeoutMs ?? 30_000,
      // Ένα `trenches` response είναι ~250KB και το `--limit` αγνοείται, άρα το default
      // 1MB maxBuffer είναι πολύ κοντά. Δίνουμε χώρο για τις 3 κατηγορίες μαζί.
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (error) {
    const gmgnError = toGmgnError(error, argv);
    if (gmgnError instanceof GmgnRateLimitError) {
      // Also pause requests already waiting inside the limiter queue.
      limiter.block(gmgnError.retryAt);
    }
    throw gmgnError;
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new GmgnResponseError(
      `could not parse CLI output as JSON: ${stdout.slice(0, 200)}`,
      argv.join(' '),
    );
  }
}

interface ExecError {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string | null;
  message?: string;
}

function toGmgnError(error: unknown, argv: readonly string[]): Error {
  const err = (error ?? {}) as ExecError;
  const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'unknown error');

  const rateLimited = /\b429\b|RATE_LIMIT/i.test(output);
  if (rateLimited) {
    return new GmgnRateLimitError(`GMGN rate limit hit: ${firstLine(output)}`, parseResetAt(output), output);
  }

  const exitCode = typeof err.code === 'number' ? err.code : null;
  const timedOut = err.killed === true && err.signal === 'SIGTERM';
  const prefix = timedOut ? 'gmgn-cli timed out' : 'gmgn-cli failed';
  return new GmgnCliError(`${prefix}: ${firstLine(output)}`, exitCode, output, argv);
}

/**
 * Το body ενός 429 περιέχει `reset_at` σε unix seconds — ο χρόνος που λήγει το ban
 * (τυπικά 5 λεπτά). Ο scheduler πρέπει να σταματήσει μέχρι τότε, όχι να retry-άρει.
 */
function parseResetAt(output: string): Date | null {
  const jsonMatch = /"?reset_at"?\s*[:=]\s*"?(\d{10,13})"?/.exec(output);
  if (jsonMatch?.[1]) {
    const value = Number(jsonMatch[1]);
    const millis = value > 1e12 ? value : value * 1000;
    return Number.isFinite(millis) ? new Date(millis) : null;
  }

  const textMatch = /Rate limit resets at\s+([^\n\r)]+?)(?:\s*\([^)]*remaining\)|\s*$)/i.exec(output);
  if (textMatch?.[1]) {
    const raw = textMatch[1].trim();
    const isoLike = raw.replace(/\s+GMT([+-]\d{2}:?\d{2})$/, 'GMT$1');
    const ts = Date.parse(isoLike);
    return Number.isNaN(ts) ? null : new Date(ts);
  }

  return null;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

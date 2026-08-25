import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GmgnCliError, GmgnRateLimitError, GmgnResponseError } from './errors.js';
import { LIMITER_CAPACITY, LIMITER_REFILL_PER_SECOND, ROUTE_WEIGHTS, type RouteKey } from './routes.js';
import { TokenBucket } from './rateLimiter.js';

const execFileAsync = promisify(execFile);

/**
 * Το binary είναι global npm install· override μέσω `GMGN_CLI_BIN` (tests, ή διαφορετικό
 * path στο Railway image). Διαβάζεται σε κάθε κλήση και όχι σε module load, ώστε να μη
 * παγώνει η τιμή πριν στηθεί το environment.
 */
function cliBin(): string {
  return process.env.GMGN_CLI_BIN ?? 'gmgn-cli';
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
  await limiter.acquire(weight);

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
    throw toGmgnError(error, argv);
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
  const match = /"?reset_at"?\s*[:=]\s*"?(\d{10,13})"?/.exec(output);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  const millis = value > 1e12 ? value : value * 1000;
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

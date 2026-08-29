import { GmgnRateLimitError } from './gmgn/errors.js';

/**
 * Scheduler για τα background loops. Ένα process για όλα (απόφαση 2026-08-25).
 *
 * Το κρίσιμο σημείο: ο rate limiter της GMGN είναι **κοινός ανά API key**, όχι ανά route.
 * Άρα ένα 429 σε οποιοδήποτε loop σημαίνει ότι ΟΛΑ πρέπει να παγώσουν μέχρι το `retryAt` —
 * αν συνέχιζαν τα υπόλοιπα, κάθε request τους θα επέκτεινε το ban κατά 5s, έως 5 λεπτά.
 * Γι' αυτό το cooldown είναι μοιραζόμενη κατάσταση, όχι per-loop.
 */

export interface SchedulerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Μοιραζόμενο cooldown: ό,τι μάθει το ένα loop, το σέβονται όλα. */
export class SharedCooldown {
  #until = 0;

  constructor(private readonly clock: SchedulerClock = realClock) {}

  get activeUntil(): number {
    return this.#until;
  }

  remainingMs(): number {
    return Math.max(0, this.#until - this.clock.now());
  }

  /** Κρατά το πιο μακρινό cooldown — ποτέ δε το κονταίνει. */
  engage(until: Date | null, fallbackMs = 60_000): void {
    const target = until === null ? this.clock.now() + fallbackMs : until.getTime();
    this.#until = Math.max(this.#until, target);
  }
}

export interface LoopDefinition {
  name: string;
  intervalMs: number;
  /** Delay before the first run, used to avoid a startup request burst. */
  initialDelayMs?: number;
  /** Runs alone after all currently active regular loops have finished. */
  exclusive?: boolean;
  /**
   * Retry delay μετά από αποτυχία, βάσει συνεχόμενων αποτυχιών (1-indexed: το πρώτο
   * στοιχείο ισχύει μετά την 1η αποτυχία στη σειρά, το τελευταίο επαναλαμβάνεται για
   * κάθε επόμενη). Χωρίς αυτό, μια αποτυχία περιμένει απλά το κανονικό `intervalMs`,
   * όπως πριν — flat retry, χωρίς backoff.
   */
  retryBackoffMs?: readonly number[];
  run(): Promise<void>;
}

export interface SchedulerOptions {
  loops: readonly LoopDefinition[];
  cooldown: SharedCooldown;
  coordinator?: ExclusiveCoordinator;
  signal?: AbortSignal;
  clock?: SchedulerClock;
  log?: (message: string) => void;
}

interface CoordinatorWaiter {
  exclusive: boolean;
  resolve: (release: () => void) => void;
}

/** Coordinates normal loop runs with an exclusive maintenance window. */
export class ExclusiveCoordinator {
  #activeRegular = 0;
  #exclusiveActive = false;
  #exclusivePending = false;
  #waiters: CoordinatorWaiter[] = [];

  acquire(exclusive = false): Promise<() => void> {
    if (exclusive) this.#exclusivePending = true;
    return new Promise((resolve) => {
      this.#waiters.push({ exclusive, resolve });
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#exclusiveActive) return;

    if (this.#exclusivePending && this.#activeRegular === 0) {
      const index = this.#waiters.findIndex((waiter) => waiter.exclusive);
      const waiter = index >= 0 ? this.#waiters.splice(index, 1)[0] : undefined;
      if (waiter) {
        this.#exclusivePending = false;
        this.#exclusiveActive = true;
        waiter.resolve(() => {
          this.#exclusiveActive = false;
          this.#drain();
        });
        return;
      }
    }

    if (this.#exclusivePending || this.#activeRegular > 0) return;

    const index = this.#waiters.findIndex((waiter) => !waiter.exclusive);
    const waiter = index >= 0 ? this.#waiters.splice(index, 1)[0] : undefined;
    if (!waiter) return;

    this.#activeRegular += 1;
    waiter.resolve(() => {
      this.#activeRegular -= 1;
      this.#drain();
    });
  }
}

/**
 * Κάθε loop τρέχει ανεξάρτητα στο δικό του interval, αλλά όλα σέβονται το κοινό cooldown.
 * Ένα loop που πετάει σφάλμα δεν σταματά — καταγράφει και ξαναδοκιμάζει στο επόμενο tick.
 */
export async function runScheduler(options: SchedulerOptions): Promise<void> {
  const clock = options.clock ?? realClock;
  const log = options.log ?? ((message: string) => console.log(message));
  const coordinator = options.coordinator ?? new ExclusiveCoordinator();
  await Promise.all(options.loops.map((loop) => runLoop(loop, options, coordinator, clock, log)));
}

async function runLoop(
  loop: LoopDefinition,
  options: SchedulerOptions,
  coordinator: ExclusiveCoordinator,
  clock: SchedulerClock,
  log: (message: string) => void,
): Promise<void> {
  const aborted = (): boolean => options.signal?.aborted === true;
  // Per-loop state — κάθε loop έχει το δικό του closure μέσω runScheduler's .map(), άρα
  // αυτό δε μοιράζεται ποτέ κατά λάθος μεταξύ loops.
  let consecutiveFailures = 0;

  const initialDelayMs = loop.initialDelayMs ?? 0;
  if (initialDelayMs > 0) {
    await clock.sleep(initialDelayMs, options.signal);
    if (aborted()) return;
  }

  while (!aborted()) {
    const cooling = options.cooldown.remainingMs();
    if (cooling > 0) {
      log(`[${loop.name}] cooling down ${Math.ceil(cooling / 1000)}s (shared GMGN limit)`);
      await clock.sleep(cooling, options.signal);
      continue;
    }

    const release = await coordinator.acquire(loop.exclusive);
    const startedAt = clock.now();
    let failed = false;
    try {
      try {
        await loop.run();
        consecutiveFailures = 0;
      } catch (error) {
        failed = true;
        consecutiveFailures += 1;
        if (error instanceof GmgnRateLimitError) {
          options.cooldown.engage(error.retryAt);
          log(
            `[${loop.name}] rate limited — pausing every loop for ` +
              `${Math.ceil(options.cooldown.remainingMs() / 1000)}s — ${error.message}`,
          );
        } else {
          log(`[${loop.name}] failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      release();
    }

    if (aborted()) return;
    // Το interval μετριέται από την ΑΡΧΗ του κύκλου, ώστε ένας αργός κύκλος να μη
    // προσθέτει καθυστέρηση πάνω στην καθυστέρηση.
    const elapsed = clock.now() - startedAt;
    const intervalMs = failed ? retryDelayMs(loop, consecutiveFailures) : loop.intervalMs;
    if (failed) {
      log(
        `[${loop.name}] retry in ${Math.ceil(intervalMs / 1000)}s ` +
          `(consecutive failures: ${consecutiveFailures})`,
      );
    }
    await clock.sleep(Math.max(0, intervalMs - elapsed), options.signal);
  }
}

/**
 * Το backoff array είναι 1-indexed κατά συνεχόμενες αποτυχίες· το τελευταίο στοιχείο
 * επαναλαμβάνεται για κάθε αποτυχία πέρα από το μήκος του (cap). Χωρίς array, ίδια
 * συμπεριφορά με πριν: πάντα `intervalMs`.
 */
export function retryDelayMs(loop: LoopDefinition, consecutiveFailures: number): number {
  const backoff = loop.retryBackoffMs;
  if (!backoff || backoff.length === 0) return loop.intervalMs;
  const index = Math.min(consecutiveFailures - 1, backoff.length - 1);
  return backoff[index] ?? loop.intervalMs;
}

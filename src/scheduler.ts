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
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
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
  run(): Promise<void>;
}

export interface SchedulerOptions {
  loops: readonly LoopDefinition[];
  cooldown: SharedCooldown;
  signal?: AbortSignal;
  clock?: SchedulerClock;
  log?: (message: string) => void;
}

/**
 * Κάθε loop τρέχει ανεξάρτητα στο δικό του interval, αλλά όλα σέβονται το κοινό cooldown.
 * Ένα loop που πετάει σφάλμα δεν σταματά — καταγράφει και ξαναδοκιμάζει στο επόμενο tick.
 */
export async function runScheduler(options: SchedulerOptions): Promise<void> {
  const clock = options.clock ?? realClock;
  const log = options.log ?? ((message: string) => console.log(message));
  await Promise.all(options.loops.map((loop) => runLoop(loop, options, clock, log)));
}

async function runLoop(
  loop: LoopDefinition,
  options: SchedulerOptions,
  clock: SchedulerClock,
  log: (message: string) => void,
): Promise<void> {
  const aborted = (): boolean => options.signal?.aborted === true;

  while (!aborted()) {
    const cooling = options.cooldown.remainingMs();
    if (cooling > 0) {
      log(`[${loop.name}] cooling down ${Math.ceil(cooling / 1000)}s (shared GMGN limit)`);
      await clock.sleep(cooling, options.signal);
      continue;
    }

    const startedAt = clock.now();
    try {
      await loop.run();
    } catch (error) {
      if (error instanceof GmgnRateLimitError) {
        options.cooldown.engage(error.retryAt);
        log(
          `[${loop.name}] rate limited — pausing every loop for ` +
            `${Math.ceil(options.cooldown.remainingMs() / 1000)}s`,
        );
      } else {
        log(`[${loop.name}] failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (aborted()) return;
    // Το interval μετριέται από την ΑΡΧΗ του κύκλου, ώστε ένας αργός κύκλος να μη
    // προσθέτει καθυστέρηση πάνω στην καθυστέρηση.
    const elapsed = clock.now() - startedAt;
    await clock.sleep(Math.max(0, loop.intervalMs - elapsed), options.signal);
  }
}

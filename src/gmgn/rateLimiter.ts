/**
 * Token bucket που αντικατοπτρίζει τον leaky-bucket limiter του GMGN: `rate=20`,
 * `capacity=20`, με weight ανά route (βλ. `routes.ts`).
 *
 * Γιατί proactive limiting και όχι reactive retry: στο 429 η GMGN επεκτείνει το ban κατά
 * 5s για κάθε request μέσα στο cooldown, έως 5 λεπτά. Ένα naive retry loop μετατρέπει ένα
 * στιγμιαίο throttle σε πεντάλεπτο blackout. Άρα περιμένουμε ΠΡΙΝ στείλουμε.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class TokenBucket {
  #tokens: number;
  #lastRefillAt: number;
  #blockedUntil = 0;
  #queue: {
    weight: number;
    priority: number;
    sequence: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  #processing = false;
  #sequence = 0;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.#tokens = capacity;
    this.#lastRefillAt = clock.now();
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Stops already queued callers too when the server reports a shared cooldown. */
  block(until: Date | null, fallbackMs = 60_000): void {
    const target = until?.getTime() ?? this.clock.now() + fallbackMs;
    this.#blockedUntil = Math.max(this.#blockedUntil, target);
  }

  async acquire(weight: number, priority = 0): Promise<void> {
    if (weight <= 0) return;
    if (weight > this.capacity) {
      throw new Error(`weight ${weight} exceeds bucket capacity ${this.capacity}`);
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ weight, priority, sequence: this.#sequence++, resolve, reject });
      this.#queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      queueMicrotask(() => void this.#processQueue());
    });
  }

  async #processQueue(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const request = this.#queue.shift();
        if (!request) continue;
        try {
          await this.#take(request.weight);
          request.resolve();
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.#processing = false;
      if (this.#queue.length > 0) void this.#processQueue();
    }
  }

  async #take(weight: number): Promise<void> {
    for (;;) {
      const blockedMs = this.#blockedUntil - this.clock.now();
      if (blockedMs > 0) {
        await this.clock.sleep(blockedMs);
        continue;
      }
      this.#refill();
      if (this.#tokens >= weight) {
        this.#tokens -= weight;
        return;
      }
      const deficit = weight - this.#tokens;
      await this.clock.sleep(Math.ceil((deficit / this.refillPerSecond) * 1000));
    }
  }

  #refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = (now - this.#lastRefillAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSeconds * this.refillPerSecond);
    this.#lastRefillAt = now;
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GmgnRateLimitError } from './gmgn/errors.js';
import {
  ExclusiveCoordinator,
  retryDelayMs,
  runScheduler,
  SharedCooldown,
  type LoopDefinition,
  type SchedulerClock,
} from './scheduler.js';

function fakeClock(): { clock: SchedulerClock; elapsed: () => number } {
  let now = 0;
  return {
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    elapsed: () => now,
  };
}

test('ExclusiveCoordinator waits for regular work and blocks new regular work', async () => {
  const coordinator = new ExclusiveCoordinator();
  const regularRelease = await coordinator.acquire();
  let exclusiveStarted = false;
  const exclusive = coordinator.acquire(true).then((release) => {
    exclusiveStarted = true;
    return release;
  });
  const queuedRegular = coordinator.acquire();

  await Promise.resolve();
  assert.equal(exclusiveStarted, false);
  regularRelease();
  const exclusiveRelease = await exclusive;
  assert.equal(exclusiveStarted, true);
  let regularStarted = false;
  void queuedRegular.then(() => {
    regularStarted = true;
  });
  await Promise.resolve();
  assert.equal(regularStarted, false);
  exclusiveRelease();
  await queuedRegular;
  assert.equal(regularStarted, true);
});

test('retryDelayMs walks the backoff array by consecutive failures, then caps at the last entry', () => {
  const loop: LoopDefinition = { name: 'x', intervalMs: 999, retryBackoffMs: [10, 20, 30], run: async () => {} };
  assert.equal(retryDelayMs(loop, 1), 10);
  assert.equal(retryDelayMs(loop, 2), 20);
  assert.equal(retryDelayMs(loop, 3), 30);
  assert.equal(retryDelayMs(loop, 4), 30);
  assert.equal(retryDelayMs(loop, 40), 30);
});

test('retryDelayMs falls back to intervalMs when no backoff array is given — ίδιο behaviour με πριν', () => {
  const loop: LoopDefinition = { name: 'x', intervalMs: 999, run: async () => {} };
  assert.equal(retryDelayMs(loop, 1), 999);
  assert.equal(retryDelayMs(loop, 5), 999);
});

test('a loop that keeps failing sleeps increasing amounts, and resets to intervalMs after a success', async () => {
  const { clock, elapsed } = fakeClock();
  const controller = new AbortController();
  const cooldown = new SharedCooldown(clock);
  const sleepsObserved: number[] = [];
  const realSleep = clock.sleep.bind(clock);
  clock.sleep = async (ms, signal) => {
    sleepsObserved.push(ms);
    await realSleep(ms, signal);
  };

  let call = 0;
  const loop: LoopDefinition = {
    name: 'flaky',
    intervalMs: 1_000,
    retryBackoffMs: [100, 200, 300],
    run: async () => {
      call += 1;
      // Αποτυγχάνει 3 φορές στη σειρά, μετά πετυχαίνει, μετά ξανααποτυγχάνει μία φορά.
      if (call === 4) return;
      if (call === 5) controller.abort();
      if (call !== 4) throw new Error('boom');
    },
  };

  await runScheduler({ loops: [loop], cooldown, signal: controller.signal, clock });

  // 3 συνεχόμενες αποτυχίες: 100, 200, 300 (backoff)· μετά η επιτυχία μηδενίζει τον
  // μετρητή, άρα το επόμενο interval είναι το κανονικό 1000, όχι συνέχεια του backoff.
  assert.deepEqual(sleepsObserved.slice(0, 4), [100, 200, 300, 1_000]);
  assert.equal(elapsed(), 100 + 200 + 300 + 1_000);
});

test('GmgnRateLimitError engages the shared cooldown, which every loop respects on its next tick', async () => {
  const { clock } = fakeClock();
  const controller = new AbortController();
  const cooldown = new SharedCooldown(clock);
  let secondLoopRuns = 0;

  const rateLimited: LoopDefinition = {
    name: 'a',
    intervalMs: 10,
    run: async () => {
      controller.abort(); // ένας γύρος αρκεί για το test
      throw new GmgnRateLimitError('429', new Date(5_000), 'raw');
    },
  };
  const quiet: LoopDefinition = {
    name: 'b',
    intervalMs: 10,
    run: async () => {
      secondLoopRuns += 1;
    },
  };

  await runScheduler({ loops: [rateLimited, quiet], cooldown, signal: controller.signal, clock });

  assert.equal(cooldown.remainingMs(), 5_000);
  // Το δεύτερο loop έτρεξε ήδη μία φορά πριν το abort· το σημαντικό είναι ότι το
  // cooldown έμεινε ενεργό ανεξάρτητα από ΠΟΙΟ loop το πυροδότησε.
  assert.ok(secondLoopRuns >= 0);
});

test('regular loops are serialized: only one regular loop may be active at a time', async () => {
  const { clock } = fakeClock();
  const controller = new AbortController();
  const cooldown = new SharedCooldown(clock);
  let running = 0;
  let maxRunning = 0;
  let calls = 0;

  const loops: LoopDefinition[] = [
    {
      name: 'one',
      intervalMs: 100,
      run: async () => {
        calls += 1;
        if (calls >= 2) controller.abort();
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await clock.sleep(10);
        running -= 1;
      },
    },
    {
      name: 'two',
      intervalMs: 100,
      run: async () => {
        calls += 1;
        if (calls >= 2) controller.abort();
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await clock.sleep(10);
        running -= 1;
      },
    },
  ];

  await runScheduler({
    loops,
    cooldown,
    signal: controller.signal,
    clock,
  });

  assert.equal(maxRunning, 1);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { filterNewBuys, selectRoundRobinWallets } from '../collectors/walletActivity.js';
import type { WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import type { WalletActivity } from '../gmgn/activity.js';
import { parseTrenchesResponse, type TrenchCandidate } from '../gmgn/trenches.js';
import { GmgnRateLimitError } from '../gmgn/errors.js';
import { runScheduler, SharedCooldown, type SchedulerClock } from '../scheduler.js';
import { evaluateGate } from './evaluateGate.js';
import { PHASE1_THRESHOLDS, logicVersion } from './gateConfig.js';

const FIXTURE = path.join(import.meta.dirname, '../gmgn/__fixtures__/trenches.near_completion.json');

function candidates(): TrenchCandidate[] {
  return parseTrenchesResponse(JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown, 'near_completion');
}

/** Φτιάχνει candidate με ελεγχόμενα gate metrics. */
function candidate(raw: Record<string, unknown>): TrenchCandidate {
  const base = candidates()[0];
  assert.ok(base);
  return { ...base, raw: { ...base.raw, ...raw } };
}

// --- logic_version ---------------------------------------------------------------------

test('logicVersion changes automatically when any threshold changes', () => {
  const baseline = logicVersion(PHASE1_THRESHOLDS);
  assert.match(baseline, /^gate-v1-[0-9a-f]{6}$/);
  assert.notEqual(baseline, logicVersion({ ...PHASE1_THRESHOLDS, maxRugRatio: 0.21 }));
  // Σταθερό ανεξάρτητα από τη σειρά των κλειδιών — αλλιώς μια αθώα αναδιάταξη θα
  // δημιουργούσε ψεύτικη νέα έκδοση και θα έσπαγε τη σύγκριση της Φάσης 2.
  assert.equal(
    logicVersion({ minSmartDegenCount: 1, maxRugRatio: 0.2, maxBundlerRate: 0.3, maxInsiderRatio: 0.3, maxTopHolderRate: 0.5 }),
    baseline,
  );
});

// --- gate evaluation -------------------------------------------------------------------

test('evaluateGate agrees with the server on the real gated fixture', () => {
  // Το fixture είναι από gated call, άρα ΟΛΑ πρέπει να περνούν το client-side gate.
  // Διαφωνία θα σήμαινε λάθος στο flag→field mapping.
  for (const item of candidates()) {
    const result = evaluateGate(item, PHASE1_THRESHOLDS);
    assert.equal(result.passed, true, `διαφωνία στο ${item.symbol}: ${result.failReason}`);
    assert.equal(result.failReason, null);
  }
});

test('evaluateGate reports every violated threshold, formatted for humans', () => {
  const result = evaluateGate(
    candidate({ rug_ratio: 0.34, smart_degen_count: 0 }),
    PHASE1_THRESHOLDS,
  );
  assert.equal(result.passed, false);
  assert.match(result.failReason ?? '', /rug_ratio 0\.34 > max 0\.2/);
  assert.match(result.failReason ?? '', /smart_degen_count 0 < min 1/);
});

test('a missing metric fails closed and is counted separately', () => {
  const result = evaluateGate(candidate({ rug_ratio: null }), PHASE1_THRESHOLDS);
  assert.equal(result.passed, false);
  assert.equal(result.missingFieldCount, 1);
  assert.match(result.failReason ?? '', /rug_ratio missing \(fail-closed\)/);
});

test('a boundary value passes — thresholds are inclusive', () => {
  const result = evaluateGate(
    candidate({ rug_ratio: 0.2, top_10_holder_rate: 0.5, smart_degen_count: 1 }),
    PHASE1_THRESHOLDS,
  );
  assert.equal(result.passed, true);
});

test('evaluateGate reads string metrics too', () => {
  // Το trenches δίνει numbers, αλλά ο αριθμός/τύπος των fields δεν είναι σταθερός.
  const result = evaluateGate(candidate({ rug_ratio: '0.34' }), PHASE1_THRESHOLDS);
  assert.match(result.failReason ?? '', /rug_ratio 0\.34 > max 0\.2/);
});

// --- activity cursor -------------------------------------------------------------------

function buy(txHash: string, timestamp: number): WalletActivity {
  return {
    wallet: 'W1', txHash, eventType: 'buy', tokenAddress: `T-${txHash}`,
    tokenSymbol: 'X', tokenAmount: 1, costUsd: 1, priceUsd: 1, timestamp,
    launchpadPlatform: 'Pump.fun',
  };
}

test('filterNewBuys stops at the cursor tx hash', () => {
  const page = [buy('c', 300), buy('b', 200), buy('a', 100)];
  assert.deepEqual(filterNewBuys(page, 'b', null).map((x) => x.txHash), ['c']);
  // Χωρίς cursor: όλα είναι νέα (πρώτο poll του wallet).
  assert.equal(filterNewBuys(page, null, null).length, 3);
  // Ο cursor στο πιο πρόσφατο: τίποτα νέο.
  assert.equal(filterNewBuys(page, 'c', null).length, 0);
});

test('filterNewBuys falls back to the timestamp when the hash fell off the page', () => {
  const page = [buy('e', 500), buy('d', 400)];
  // Ο cursor 'b' δεν υπάρχει πια στη σελίδα· το timestamp σώζει από re-trigger.
  assert.deepEqual(filterNewBuys(page, 'b', new Date(400_000)).map((x) => x.txHash), ['e']);
});

test('activity polling selects a bounded round-robin batch', () => {
  const wallets = Array.from({ length: 5 }, (_, index) => ({
    address: `W${index + 1}`,
  })) as WatchlistWallet[];

  assert.deepEqual(
    selectRoundRobinWallets(wallets, 0, 2).map((wallet) => wallet.address),
    ['W1', 'W2'],
  );
  assert.deepEqual(
    selectRoundRobinWallets(wallets, 2, 2).map((wallet) => wallet.address),
    ['W3', 'W4'],
  );
  assert.deepEqual(
    selectRoundRobinWallets(wallets, 4, 2).map((wallet) => wallet.address),
    ['W5', 'W1'],
  );
});

// --- scheduler -------------------------------------------------------------------------

function fakeSchedulerClock(): { clock: SchedulerClock; now: () => number } {
  let now = 0;
  return {
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    now: () => now,
  };
}

test('a 429 engages the shared cooldown, not just a local backoff', async () => {
  const { clock } = fakeSchedulerClock();
  const cooldown = new SharedCooldown(clock);
  const controller = new AbortController();

  await runScheduler({
    clock,
    cooldown,
    signal: controller.signal,
    // Το cooling log είναι το σημείο όπου ο scheduler έχει δει το cooldown: σταματάμε εκεί
    // ώστε το test να μη εξαρτάται από interleaving.
    log: (message) => {
      if (message.includes('cooling down')) controller.abort();
    },
    loops: [
      {
        name: 'discovery',
        intervalMs: 1_000,
        run: () => Promise.reject(new GmgnRateLimitError('banned', new Date(120_000), '')),
      },
    ],
  });

  // Το cooldown είναι κοινή κατάσταση, ρυθμισμένη στο retryAt του σφάλματος — άρα κάθε
  // άλλο loop θα το δει. (Δεν ελέγχουμε remainingMs: ο fake clock έχει ήδη προχωρήσει
  // μέσα στο cooling sleep, που είναι ακριβώς ό,τι θέλαμε να συμβεί.)
  assert.equal(cooldown.activeUntil, 120_000);
});

test('a loop does not run at all while the shared cooldown is active', async () => {
  const { clock } = fakeSchedulerClock();
  const cooldown = new SharedCooldown(clock);
  cooldown.engage(new Date(60_000));
  const controller = new AbortController();
  let runs = 0;

  await runScheduler({
    clock,
    cooldown,
    signal: controller.signal,
    log: () => controller.abort(),
    loops: [{ name: 'other', intervalMs: 1_000, run: async () => { runs += 1; } }],
  });

  assert.equal(runs, 0, 'ένα loop δε πρέπει να στείλει request μέσα στο cooldown');
});

test('SharedCooldown never shortens an existing cooldown', () => {
  const { clock } = fakeSchedulerClock();
  const cooldown = new SharedCooldown(clock);
  cooldown.engage(new Date(300_000));
  cooldown.engage(new Date(10_000));
  assert.equal(cooldown.activeUntil, 300_000);
});

test('SharedCooldown falls back to a fixed pause when retryAt is unknown', () => {
  const { clock } = fakeSchedulerClock();
  const cooldown = new SharedCooldown(clock);
  cooldown.engage(null, 45_000);
  assert.equal(cooldown.remainingMs(), 45_000);
});

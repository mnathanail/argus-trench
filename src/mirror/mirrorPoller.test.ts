import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { WalletActivity } from '../gmgn/activity.js';
import { GmgnRateLimitError } from '../gmgn/errors.js';
import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import type { MirrorOutcome } from './mirrorHandler.js';
import { activityToEvent, resetMirrorPollState, runMirrorPollCycle, type MirrorPollDeps } from './mirrorPoller.js';

const W = '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5';
const SOL = 'So11111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

function act(overrides: Partial<WalletActivity> = {}): WalletActivity {
  return {
    wallet: W,
    txHash: 'tx1',
    eventType: 'buy',
    tokenAddress: 'Mint1',
    tokenSymbol: 'M',
    tokenAmount: 1_000_000,
    costUsd: 20,
    priceUsd: 0.00002,
    timestamp: NOW - 10,
    launchpadPlatform: 'Pump.fun',
    quoteAmount: 0.2,
    quoteAddress: SOL,
    isOpenOrClose: 1,
    ...overrides,
  };
}

test('activityToEvent: Pump.fun buy με SOL quote → pump-amm event (τιμή = sol/tokens)', () => {
  const e = activityToEvent(act(), 'Pump.fun');
  assert.deepEqual(e, {
    signature: 'tx1',
    mint: 'Mint1',
    traderPublicKey: W,
    txType: 'buy',
    tokenAmount: 1_000_000,
    solAmount: 0.2,
    pool: 'pump-amm',
  });
});

test('activityToEvent: άλλο launchpad → pool other', () => {
  assert.equal(activityToEvent(act(), 'Bonk')?.pool, 'other');
  assert.equal(activityToEvent(act(), null)?.pool, 'other');
});

test('activityToEvent: όχι SOL quote / λείπουν ποσά / άλλος τύπος → null', () => {
  assert.equal(activityToEvent(act({ quoteAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }), 'Pump.fun'), null);
  assert.equal(activityToEvent(act({ quoteAmount: null }), 'Pump.fun'), null);
  assert.equal(activityToEvent(act({ tokenAmount: 0 }), 'Pump.fun'), null);
  assert.equal(activityToEvent(act({ eventType: 'transferIn' }), 'Pump.fun'), null);
  // wrapped SOL δεκτό
  assert.notEqual(activityToEvent(act({ quoteAddress: 'So11111111111111111111111111111111111111112' }), 'Pump.fun'), null);
});

test('activityToEvent: sell με is_open_or_close=1 → newTokenBalance 0 (πλήρης έξοδος)· αλλιώς χωρίς', () => {
  assert.equal(activityToEvent(act({ eventType: 'sell', isOpenOrClose: 1 }), 'Pump.fun')?.newTokenBalance, 0);
  const partial = activityToEvent(act({ eventType: 'sell', isOpenOrClose: 0 }), 'Pump.fun');
  assert.equal(partial !== null && 'newTokenBalance' in partial, false);
  // buy με is_open_or_close=1 (άνοιγμα) — όχι balance
  const buy = activityToEvent(act({ isOpenOrClose: 1 }), 'Pump.fun');
  assert.equal(buy !== null && 'newTokenBalance' in buy, false);
});

function fakeDeps(activities: WalletActivity[][], opts: Partial<MirrorPollDeps> = {}) {
  const handled: PumpPortalTradeEvent[] = [];
  const launchpadCalls: string[] = [];
  let call = 0;
  const deps: MirrorPollDeps = {
    listWallets: async () => [W],
    fetchActivity: async () => activities[Math.min(call++, activities.length - 1)] ?? [],
    launchpadOf: async (mint) => {
      launchpadCalls.push(mint);
      return 'Pump.fun';
    },
    handle: async (event): Promise<MirrorOutcome> => {
      handled.push(event);
      return { kind: 'added', wallet: event.traderPublicKey, token: event.mint };
    },
    nowSec: () => NOW,
    ...opts,
  };
  return { deps, handled, launchpadCalls };
}

beforeEach(() => resetMirrorPollState());

test('runMirrorPollCycle: πρώτο poll = μόνο τα τελευταία 300s, με χρονολογική σειρά', async () => {
  const { deps, handled } = fakeDeps([
    [
      act({ txHash: 'new2', timestamp: NOW - 5, eventType: 'sell', isOpenOrClose: 0 }),
      act({ txHash: 'old', timestamp: NOW - 301 }),
      act({ txHash: 'new1', timestamp: NOW - 60 }),
    ],
  ]);
  const r = await runMirrorPollCycle(deps);
  assert.deepEqual(handled.map((e) => e.signature), ['new1', 'new2']);
  assert.equal(r.newActivities, 2);
  assert.equal(r.outcomes.length, 2);
  assert.equal(r.failures, 0);
});

test('runMirrorPollCycle: ο cursor προχωράει — ίδιο δευτερόλεπτο ξαναδίνεται (dedupe στο handler), παλιότερα όχι', async () => {
  const first = [act({ txHash: 'a', timestamp: NOW - 20 })];
  const second = [act({ txHash: 'b', timestamp: NOW - 2 }), act({ txHash: 'a', timestamp: NOW - 20 }), act({ txHash: 'z', timestamp: NOW - 30 })];
  const { deps, handled } = fakeDeps([first, second]);
  await runMirrorPollCycle(deps);
  await runMirrorPollCycle(deps);
  assert.deepEqual(handled.map((e) => e.signature), ['a', 'a', 'b']);
});

test('runMirrorPollCycle: launchpad από το activity row· token info μόνο όταν λείπει', async () => {
  const { deps, handled, launchpadCalls } = fakeDeps([
    [act({ txHash: 'x', launchpadPlatform: 'Pump.fun' }), act({ txHash: 'y', tokenAddress: 'Mint2', launchpadPlatform: null, timestamp: NOW - 5 })],
  ]);
  await runMirrorPollCycle(deps);
  assert.deepEqual(launchpadCalls, ['Mint2']);
  assert.deepEqual(handled.map((e) => e.pool), ['pump-amm', 'pump-amm']);
});

test('runMirrorPollCycle: μη αντιγράψιμο activity (όχι SOL quote) μετράει αλλά δεν πάει στο handler', async () => {
  const { deps, handled } = fakeDeps([[act({ quoteAddress: 'USDC' })]]);
  const r = await runMirrorPollCycle(deps);
  assert.equal(handled.length, 0);
  assert.equal(r.newActivities, 1);
});

test('runMirrorPollCycle: σφάλμα → failure και συνεχίζει· rate limit → rethrow', async () => {
  const { deps } = fakeDeps([], {
    listWallets: async () => [W, 'Other'],
    fetchActivity: async (wallet) => {
      if (wallet === W) throw new Error('boom');
      return [act({ wallet: 'Other' })];
    },
  });
  const origError = console.error;
  console.error = () => undefined;
  try {
    const r = await runMirrorPollCycle(deps);
    assert.equal(r.failures, 1);
    assert.equal(r.outcomes.length, 1);

    const { deps: rl } = fakeDeps([], {
      fetchActivity: async () => {
        throw new GmgnRateLimitError('429', null, '');
      },
    });
    await assert.rejects(runMirrorPollCycle(rl), GmgnRateLimitError);
  } finally {
    console.error = origError;
  }
});

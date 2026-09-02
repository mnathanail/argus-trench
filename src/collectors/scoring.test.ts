import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideLifecycleTransition } from './scoring.js';

function wallet(overrides: Partial<Parameters<typeof decideLifecycleTransition>[0]> = {}) {
  return {
    active: true,
    winRate: 0.6,
    tradeCount: 50,
    deactivatedReason: null,
    ...overrides,
  };
}

test('decideLifecycleTransition: no transition when already-active wallet just dips once (advisory territory)', () => {
  const result = decideLifecycleTransition(
    wallet({ active: true, winRate: 0.55, tradeCount: 50 }), // previous reading: passing
    { winRate: 0.45, tradeCount: 50 }, // current: failing (first dip)
  );
  assert.equal(result, null);
});

test('decideLifecycleTransition: deactivates on the SECOND consecutive failing reading', () => {
  const result = decideLifecycleTransition(
    wallet({ active: true, winRate: 0.45, tradeCount: 50 }), // previous reading: already failing
    { winRate: 0.42, tradeCount: 50 }, // current: still failing
  );
  assert.equal(result, 'deactivate');
});

test('decideLifecycleTransition: low trade_count alone (even with good win rate) counts as failing', () => {
  const result = decideLifecycleTransition(
    wallet({ active: true, winRate: 0.9, tradeCount: 5 }), // previous: fails on sample size
    { winRate: 0.9, tradeCount: 8 }, // current: still fails on sample size
  );
  assert.equal(result, 'deactivate');
});

test('decideLifecycleTransition: does not reactivate on a single passing reading after deactivation', () => {
  const result = decideLifecycleTransition(
    wallet({ active: false, deactivatedReason: 'below_threshold', winRate: 0.4, tradeCount: 50 }),
    { winRate: 0.55, tradeCount: 50 }, // first recovery reading
  );
  assert.equal(result, null);
});

test('decideLifecycleTransition: reactivates on the SECOND consecutive passing reading after deactivation', () => {
  const result = decideLifecycleTransition(
    wallet({ active: false, deactivatedReason: 'below_threshold', winRate: 0.55, tradeCount: 50 }),
    { winRate: 0.58, tradeCount: 50 },
  );
  assert.equal(result, 'reactivate');
});

test('decideLifecycleTransition: NEVER reactivates a manually /unwatch-ed wallet, even with two great readings', () => {
  const result = decideLifecycleTransition(
    wallet({ active: false, deactivatedReason: 'manual', winRate: 0.7, tradeCount: 200 }),
    { winRate: 0.75, tradeCount: 205 },
  );
  assert.equal(result, null);
});

test('decideLifecycleTransition: a healthy active wallet staying healthy triggers nothing', () => {
  const result = decideLifecycleTransition(
    wallet({ active: true, winRate: 0.6, tradeCount: 100 }),
    { winRate: 0.62, tradeCount: 102 },
  );
  assert.equal(result, null);
});

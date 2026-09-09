import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computePnl } from './pnl.js';
import { PAPER_ASSUMED_FEES_PCT } from './paperTradingConfig.js';

test('computePnl: a tp_tier_1-style +50% gain', () => {
  const result = computePnl(1, 1.5, 10, 0.01);
  assert.equal(result.pnlPct, 0.5);
  assert.ok(Math.abs(result.pnlSol - 10 * 0.01 * 0.5) < 1e-12);
  assert.ok(Math.abs(result.pnlNetPct - (0.5 - PAPER_ASSUMED_FEES_PCT)) < 1e-12);
});

test('computePnl: a loss (exit below entry) gives a negative pnlPct and pnlSol', () => {
  const result = computePnl(1, 0.7, 10, 0.01);
  assert.ok(Math.abs(result.pnlPct - -0.3) < 1e-12);
  assert.ok(result.pnlSol < 0);
});

test('computePnl: null bankroll/sizePct treated as zero — pnlSol is 0, pnlPct is unaffected', () => {
  const result = computePnl(1, 2, null, null);
  assert.equal(result.pnlPct, 1);
  assert.equal(result.pnlSol, 0);
});

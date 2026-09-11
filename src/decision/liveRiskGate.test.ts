import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countConsecutiveLosses } from './liveRiskGate.js';

test('countConsecutiveLosses: no trades — zero', () => {
  assert.equal(countConsecutiveLosses([]), 0);
});

test('countConsecutiveLosses: all wins — zero', () => {
  assert.equal(countConsecutiveLosses([{ pnlSol: 0.01 }, { pnlSol: 0.02 }]), 0);
});

test('countConsecutiveLosses: three losses in a row (newest first) — three', () => {
  assert.equal(countConsecutiveLosses([{ pnlSol: -0.01 }, { pnlSol: -0.02 }, { pnlSol: -0.005 }]), 3);
});

test('countConsecutiveLosses: stops counting at the first win, even with losses further back', () => {
  const trades = [{ pnlSol: -0.01 }, { pnlSol: -0.02 }, { pnlSol: 0.05 }, { pnlSol: -0.03 }, { pnlSol: -0.03 }];
  assert.equal(countConsecutiveLosses(trades), 2);
});

test('countConsecutiveLosses: a null pnl breaks the streak (does not count as a loss)', () => {
  assert.equal(countConsecutiveLosses([{ pnlSol: -0.01 }, { pnlSol: null }, { pnlSol: -0.02 }]), 1);
});

test('countConsecutiveLosses: exactly zero pnl does not count as a loss', () => {
  assert.equal(countConsecutiveLosses([{ pnlSol: -0.01 }, { pnlSol: 0 }, { pnlSol: -0.02 }]), 1);
});

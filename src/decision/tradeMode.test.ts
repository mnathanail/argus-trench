import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideTradeMode } from './tradeMode.js';

test('decideTradeMode: enough available balance — live', () => {
  assert.equal(decideTradeMode(1, 0.05), 'live');
});

test('decideTradeMode: exactly enough (boundary) — still live', () => {
  assert.equal(decideTradeMode(0.05, 0.05), 'live');
});

test('decideTradeMode: not quite enough — falls back to paper', () => {
  assert.equal(decideTradeMode(0.04, 0.05), 'paper');
});

test('decideTradeMode: zero available — paper', () => {
  assert.equal(decideTradeMode(0, 0.05), 'paper');
});

test('decideTradeMode: never returns "live" for a negative balance (defensive)', () => {
  assert.equal(decideTradeMode(-0.1, 0.05), 'paper');
});

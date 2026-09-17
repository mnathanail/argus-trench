import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateExitAmountSol, inferExitReason } from './strategyOrders.js';

// estimateExitAmountSol — 2026-09-17, κοινό μεταξύ του live strategy reconciler
// (collectors/liveStrategyReconciler.ts) ΚΑΙ του exit handler's idempotent-guard
// (realtimeExitHandler.ts) — και τα δύο μαθαίνουν για ένα ήδη-κλεισμένο native order,
// μόνο από διαφορετική αφορμή, και ΠΡΕΠΕΙ να υπολογίζουν το ίδιο πραγματικό pnl.

test('estimateExitAmountSol: applies the real GMGN open/close price ratio to the real entry amount', () => {
  // token διπλασιάστηκε (open 0.001 -> close 0.002) πάνω σε πραγματικό entry 2 SOL
  const result = estimateExitAmountSol(2, 0.001, 0.002);
  assert.equal(result, 4);
});

test('estimateExitAmountSol: a loss ratio scales down correctly', () => {
  // -50%: close τιμή η μισή της open
  const result = estimateExitAmountSol(2, 0.002, 0.001);
  assert.equal(result, 1);
});

test('estimateExitAmountSol: null entry amount -> null (δεν έχουμε πραγματικό baseline)', () => {
  assert.equal(estimateExitAmountSol(null, 0.001, 0.002), null);
});

test('estimateExitAmountSol: null openPrice -> null (δε γίνεται ratio)', () => {
  assert.equal(estimateExitAmountSol(2, null, 0.002), null);
});

test('estimateExitAmountSol: openPrice=0 -> null (θα ήταν διαίρεση με το μηδέν)', () => {
  assert.equal(estimateExitAmountSol(2, 0, 0.002), null);
});

test('estimateExitAmountSol: null closePrice -> null', () => {
  assert.equal(estimateExitAmountSol(2, 0.001, null), null);
});

test('inferExitReason: a reason code containing "loss" maps to stop_loss', () => {
  assert.equal(inferExitReason('loss_stop'), 'stop_loss');
  assert.equal(inferExitReason('LOSS_STOP_TRACE'), 'stop_loss');
});

test('inferExitReason: anything else defaults to trailing_stop (the only other sub-order type we attach)', () => {
  assert.equal(inferExitReason('profit_stop_trace'), 'trailing_stop');
  assert.equal(inferExitReason(''), 'trailing_stop');
  assert.equal(inferExitReason('unknown_code'), 'trailing_stop');
});

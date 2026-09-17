import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE, parseSwapResponse, SwapFailedError, WSOL_MINT } from './swap.js';

test('WSOL_MINT is the correct, real mint address (ends in ...112, not ...111)', () => {
  assert.equal(WSOL_MINT, 'So11111111111111111111111111111111111111112');
  assert.notEqual(WSOL_MINT, 'So11111111111111111111111111111111111111111');
});

test('parseSwapResponse: a pending order — not filled, no exception', () => {
  const result = parseSwapResponse({ order_id: 'ord-1', hash: 'sig-1', status: 'pending' });
  assert.equal(result.filled, false);
  assert.equal(result.status, 'pending');
  assert.equal(result.orderId, 'ord-1');
  assert.equal(result.executedPrice, null);
});

test('parseSwapResponse: a confirmed order with a report — filled, executedPrice extracted', () => {
  const result = parseSwapResponse({
    order_id: 'ord-2',
    hash: 'sig-2',
    status: 'confirmed',
    report: {
      input_amount: '50000000',
      output_amount: '123456789',
      price: '0.000000123',
    },
  });
  assert.equal(result.filled, true);
  assert.equal(result.executedPrice, 0.000000123);
});

test('parseSwapResponse: "successful" also counts as filled (SKILL.md uses both terms)', () => {
  const result = parseSwapResponse({ order_id: 'ord-3', status: 'successful', report: { price: '1.5' } });
  assert.equal(result.filled, true);
});

test('parseSwapResponse: an inline error_code throws SwapFailedError, does not silently report a fake status', () => {
  assert.throws(
    () => parseSwapResponse({ error_code: '40003701', error_status: 'insufficient token balance' }),
    SwapFailedError,
  );
});

// errorCode on SwapFailedError — 2026-09-17: exposed as a structured field (not just
// baked into the message string) so callers can match specific GMGN business errors,
// e.g. the exit handler's idempotent-guard for a native-order-already-closed race.

test('parseSwapResponse: SwapFailedError carries the real GMGN error_code as a structured field', () => {
  try {
    parseSwapResponse({ error_code: INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE, error_status: 'insufficient token balance' });
    assert.fail('expected SwapFailedError to be thrown');
  } catch (error) {
    assert.ok(error instanceof SwapFailedError);
    assert.equal(error.errorCode, INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE);
  }
});

test('parseSwapResponse: a response with no fields at all defaults to pending, not a crash', () => {
  const result = parseSwapResponse({});
  assert.equal(result.status, 'pending');
  assert.equal(result.filled, false);
  assert.equal(result.orderId, null);
});

// strategy_order_id — 2026-09-17, native condition-orders (incident #1193). Best-effort
// creation: μπορεί να λείπει ακόμα κι όταν το ίδιο το swap πέτυχε πλήρως.

test('parseSwapResponse: strategy_order_id extracted when present (condition-orders attach succeeded)', () => {
  const result = parseSwapResponse({ order_id: 'ord-4', status: 'confirmed', strategy_order_id: 'strat-1' });
  assert.equal(result.strategyOrderId, 'strat-1');
});

test('parseSwapResponse: strategyOrderId is null when the field is absent (no condition-orders requested)', () => {
  const result = parseSwapResponse({ order_id: 'ord-5', status: 'confirmed' });
  assert.equal(result.strategyOrderId, null);
});

test('parseSwapResponse: strategyOrderId is null when the field is an empty string (best-effort creation failed)', () => {
  const result = parseSwapResponse({ order_id: 'ord-6', status: 'confirmed', strategy_order_id: '' });
  assert.equal(result.strategyOrderId, null);
});

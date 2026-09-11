import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSwapResponse, SwapFailedError, WSOL_MINT } from './swap.js';

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

test('parseSwapResponse: a response with no fields at all defaults to pending, not a crash', () => {
  const result = parseSwapResponse({});
  assert.equal(result.status, 'pending');
  assert.equal(result.filled, false);
  assert.equal(result.orderId, null);
});

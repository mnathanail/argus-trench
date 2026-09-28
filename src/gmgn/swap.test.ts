import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GmgnCliError } from './errors.js';
import {
  executeLiveSell,
  INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE,
  parseSwapResponse,
  swapApiErrorCodeFromCliOutput,
  SwapFailedError,
  WSOL_MINT,
} from './swap.js';

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

// --- 2026-09-28: GMGN API business errors φτάνουν ως GmgnCliError, όχι ως JSON error_code ---

const REAL_SELL_FAILURE_OUTPUT = [
  '',
  '⚠️  Swap — confirmation required',
  '---------------------------------',
  '  Chain:        sol',
  '[gmgn-cli] Proceeding non-interactively (--yes + GMGN_ALLOW_AUTOMATED_TRADES=1).',
  '[gmgn-cli] POST /v1/trade/swap failed: HTTP 400 code=40003701 error=INSUFFICIENT_BALANCE message=insufficient token balance',
];

test('swapApiErrorCodeFromCliOutput: extracts the GMGN code from the CLI API-error line', () => {
  assert.equal(swapApiErrorCodeFromCliOutput(REAL_SELL_FAILURE_OUTPUT.join('\n')), INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE);
});

test('swapApiErrorCodeFromCliOutput: null when there is no swap API error line (network error, abort, ...)', () => {
  assert.equal(swapApiErrorCodeFromCliOutput('[gmgn-cli] POST /v1/trade/swap fetch failed: ECONNRESET'), null);
  assert.equal(swapApiErrorCodeFromCliOutput('[gmgn-cli] No interactive terminal available'), null);
  // ένα code σε ΑΛΛΟ endpoint δεν είναι swap business error
  assert.equal(swapApiErrorCodeFromCliOutput('[gmgn-cli] GET /v1/trade/order failed: HTTP 400 code=40003701'), null);
});

async function withFakeCliAndAutomation<T>(stderrLines: readonly string[], fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gmgn-fake-swap-'));
  const file = path.join(dir, 'gmgn-cli');
  const body = [...stderrLines.map((l) => `console.error(${JSON.stringify(l)});`), 'process.exit(1);'].join('\n');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  const prevBin = process.env.GMGN_CLI_BIN;
  const prevAuto = process.env.GMGN_ALLOW_AUTOMATED_TRADES;
  process.env.GMGN_CLI_BIN = file;
  process.env.GMGN_ALLOW_AUTOMATED_TRADES = '1';
  try {
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.GMGN_CLI_BIN;
    else process.env.GMGN_CLI_BIN = prevBin;
    if (prevAuto === undefined) delete process.env.GMGN_ALLOW_AUTOMATED_TRADES;
    else process.env.GMGN_ALLOW_AUTOMATED_TRADES = prevAuto;
  }
}

test('REGRESSION trade 6490: executeLiveSell turns the CLI "code=40003701" failure into SwapFailedError(errorCode=40003701) — so the already-sold-by-native-order path can reconcile', async () => {
  await withFakeCliAndAutomation(REAL_SELL_FAILURE_OUTPUT, async () => {
    await assert.rejects(executeLiveSell('WalletAbc', 'TokenXyz'), (error: unknown) => {
      assert.ok(error instanceof SwapFailedError, `περίμενα SwapFailedError, ήρθε ${String(error)}`);
      assert.equal(error.errorCode, INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE);
      assert.ok(error.cause instanceof GmgnCliError, 'το αρχικό GmgnCliError (με όλο το output) μένει ως cause');
      assert.match(error.message, /code=40003701/);
      return true;
    });
  });
});

test('executeLiveSell: a CLI failure WITHOUT a swap API code stays a plain GmgnCliError (no false reconciliation)', async () => {
  await withFakeCliAndAutomation(['[gmgn-cli] POST /v1/trade/swap fetch failed: ECONNRESET'], async () => {
    await assert.rejects(executeLiveSell('WalletAbc', 'TokenXyz'), (error: unknown) => {
      assert.ok(error instanceof GmgnCliError);
      assert.ok(!(error instanceof SwapFailedError));
      return true;
    });
  });
});

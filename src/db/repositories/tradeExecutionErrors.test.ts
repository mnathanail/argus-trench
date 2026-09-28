import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GmgnCliError } from '../../gmgn/errors.js';
import { serializeErrorDetail } from './tradeExecutionErrors.js';

// Πραγματικό incident 2026-09-28 (trade 6490): το πλήρες output του gmgn-cli δεν
// αποθηκευόταν, οπότε ο πραγματικός λόγος αποτυχίας μιας live πώλησης χανόταν.

test('serializeErrorDetail keeps GmgnCliError.output — the full CLI text with the real failure reason', () => {
  const output = '[gmgn-cli] Proceeding non-interactively\n[gmgn-cli] POST /v1/trade/swap failed: HTTP 400 code=40003701';
  const error = new GmgnCliError('gmgn-cli failed: x', 1, output, ['swap', '--yes']);
  const parsed = JSON.parse(serializeErrorDetail(error) ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['name'], 'GmgnCliError');
  assert.equal(parsed['output'], output);
  assert.equal(parsed['exitCode'], 1);
  assert.deepEqual(parsed['command'], ['swap', '--yes']);
});

test('serializeErrorDetail includes a nested cause', () => {
  const inner = new GmgnCliError('inner', 1, 'inner output', []);
  const outer = new Error('outer', { cause: inner });
  const parsed = JSON.parse(serializeErrorDetail(outer) ?? '{}') as { cause?: Record<string, unknown> };
  assert.equal(parsed.cause?.['output'], 'inner output');
});

test('serializeErrorDetail: undefined stays null, plain objects are stringified as before', () => {
  assert.equal(serializeErrorDetail(undefined), null);
  assert.equal(serializeErrorDetail({ a: 1 }), '{"a":1}');
});

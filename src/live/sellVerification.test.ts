import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifySellFailure,
  SELL_VERIFY_ATTEMPTS,
  verifySellAfterError,
  type SellVerificationDeps,
} from './sellVerification.js';

// Πραγματικό incident 2026-09-27/28: trade 6442 — το CLI επέστρεψε error, αλλά η πώληση
// είχε εκτελεστεί on-chain (+104%). Το trade πάγωσε ως needs_manual_exit.

test('classifySellFailure: token gone + SOL came in → our sell executed', () => {
  assert.deepEqual(classifySellFailure(0, 0.106), { kind: 'sold', proceedsSol: 0.106 });
});

test('classifySellFailure: token gone but no SOL came in → sold elsewhere, NOT closed with guessed numbers', () => {
  assert.deepEqual(classifySellFailure(0, 0), { kind: 'gone_elsewhere' });
  assert.deepEqual(classifySellFailure(0, -0.05), { kind: 'gone_elsewhere' }); // π.χ. ταυτόχρονο buy άλλου trade
  assert.deepEqual(classifySellFailure(0, null), { kind: 'gone_elsewhere' });
});

test('classifySellFailure: tokens still there → still_held; lookup failed → unknown', () => {
  assert.deepEqual(classifySellFailure(1234, null), { kind: 'still_held', tokenBalance: 1234 });
  assert.deepEqual(classifySellFailure(null, null), { kind: 'unknown' });
});

function deps(tokenBalances: (number | Error)[], solNow: number | Error): SellVerificationDeps & { calls: number } {
  let i = 0;
  const d = {
    calls: 0,
    fetchTokenBalance: () => {
      d.calls += 1;
      const v = tokenBalances[Math.min(i++, tokenBalances.length - 1)];
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as number);
    },
    getSolBalance: () => (solNow instanceof Error ? Promise.reject(solNow) : Promise.resolve(solNow)),
    sleep: () => Promise.resolve(),
  };
  return d;
}

test('verifySellAfterError: REGRESSION 6442 — balance already 0 on the first check, SOL up → sold with the real proceeds', async () => {
  const d = deps([0], 1.106);
  const verdict = await verifySellAfterError('W', 'T', 1.0, d);
  assert.equal(verdict.kind, 'sold');
  if (verdict.kind === 'sold') assert.ok(Math.abs(verdict.proceedsSol - 0.106) < 1e-9);
  assert.equal(d.calls, 1);
});

test('verifySellAfterError: GMGN index lags — tokens visible first, gone on a later check → sold', async () => {
  const d = deps([5000, 0], 1.05);
  const verdict = await verifySellAfterError('W', 'T', 1.0, d);
  assert.equal(verdict.kind, 'sold');
  assert.equal(d.calls, 2);
});

test('verifySellAfterError: tokens still there after every check → still_held (caller retries the sell once)', async () => {
  const d = deps([5000], 1.0);
  const verdict = await verifySellAfterError('W', 'T', 1.0, d);
  assert.deepEqual(verdict, { kind: 'still_held', tokenBalance: 5000 });
  assert.equal(d.calls, SELL_VERIFY_ATTEMPTS);
});

test('verifySellAfterError: every balance lookup fails → unknown (never throws)', async () => {
  const d = deps([new Error('429')], 1.0);
  assert.deepEqual(await verifySellAfterError('W', 'T', 1.0, d), { kind: 'unknown' });
});

test('verifySellAfterError: token gone but the SOL balance lookup fails → gone_elsewhere (fail-safe, no guessed close)', async () => {
  const d = deps([0], new Error('portfolio info failed'));
  assert.deepEqual(await verifySellAfterError('W', 'T', 1.0, d), { kind: 'gone_elsewhere' });
});

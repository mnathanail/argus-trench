import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTokenBalance } from './tokenBalance.js';
import { GmgnResponseError } from './errors.js';

/**
 * Το `.agents/skills/gmgn-portfolio/SKILL.md` δεν τεκμηριώνει το response schema αυτού
 * του route (μόνο usage examples) — δεν υπάρχει "πραγματικό captured response" σαν το
 * `portfolio.test.ts`. Δοκιμάζουμε τα πιο πιθανά ονόματα πεδίου αμυντικά, ένα-ένα.
 */

test('parseTokenBalance: accepts top-level "balance" field (most likely shape, mirrors portfolio info)', () => {
  assert.equal(parseTokenBalance({ balance: '0' }), 0);
  assert.equal(parseTokenBalance({ balance: '1234.5' }), 1234.5);
});

test('parseTokenBalance: accepts "token_balance" when "balance" is absent', () => {
  assert.equal(parseTokenBalance({ token_balance: 42 }), 42);
});

test('parseTokenBalance: accepts "amount" or "ui_amount" as fallbacks', () => {
  assert.equal(parseTokenBalance({ amount: '7' }), 7);
  assert.equal(parseTokenBalance({ ui_amount: 3.5 }), 3.5);
});

test('parseTokenBalance: zero balance parses as 0, not falsy-skipped (critical for the watchdog — balance=0 IS the signal)', () => {
  assert.equal(parseTokenBalance({ balance: 0 }), 0);
  assert.equal(parseTokenBalance({ balance: '0' }), 0);
});

test('parseTokenBalance: throws with full context on a completely unrecognized shape, never silently returns 0', () => {
  assert.throws(() => parseTokenBalance({ unexpected_field: 123 }), GmgnResponseError);
});

test('parseTokenBalance: throws on a non-object response', () => {
  assert.throws(() => parseTokenBalance(null), GmgnResponseError);
  assert.throws(() => parseTokenBalance('nope'), GmgnResponseError);
});

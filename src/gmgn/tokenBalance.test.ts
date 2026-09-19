import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTokenBalance } from './tokenBalance.js';
import { GmgnResponseError } from './errors.js';

/**
 * ΔΙΟΡΘΩΣΗ 2026-09-19 (πραγματικό εύρημα, live production call — βλ. σχόλιο στο
 * tokenBalance.ts): το πρώτο, αμυντικό parsing (top-level `balance`/`token_balance`/
 * `amount`/`ui_amount`) ήταν εντελώς λάθος σχήμα. Το πραγματικό response,
 * αναπαραγμένο εδώ αυτούσιο:
 * ```json
 * { "balances": [ { "wallet_address": "yFb3v4wfoc7fSrxXXJ9YTM6JwMVZdnus5fmKe2A6gH5",
 *                    "token_address": "8sonGQ17UF1chMFVeLJAgEppExQupumed6uhSXy8pump",
 *                    "balance": "0", "decimal": 0, "height": 448450539, "tx_index": 0 } ] }
 * ```
 * Πριν αυτή τη διόρθωση, το `fetchTokenBalance` πέταγε `GmgnResponseError` σε ΚΑΘΕ
 * κλήση, ό,τι κι αν ήταν το πραγματικό balance — ο watchdog δεν μπόρεσε ΠΟΤΕ να
 * σημαδέψει needs_manual_exit σε τρία ήδη-κλεισμένα (χειροκίνητα, στο GMGN) live trades.
 */
const REAL_RESPONSE = {
  balances: [
    {
      wallet_address: 'yFb3v4wfoc7fSrxXXJ9YTM6JwMVZdnus5fmKe2A6gH5',
      token_address: '8sonGQ17UF1chMFVeLJAgEppExQupumed6uhSXy8pump',
      balance: '0',
      decimal: 0,
      height: 448450539,
      tx_index: 0,
    },
  ],
};

test('parseTokenBalance: πραγματικό production response (wrapper "balances" array) parses correctly', () => {
  assert.equal(parseTokenBalance(REAL_RESPONSE), 0);
});

test('parseTokenBalance: μη-μηδενικό balance μέσα στο balances[0] parses correctly', () => {
  const withBalance = { balances: [{ ...REAL_RESPONSE.balances[0], balance: '1234.5' }] };
  assert.equal(parseTokenBalance(withBalance), 1234.5);
});

test('parseTokenBalance: numeric (όχι string) balance γίνεται επίσης δεκτό', () => {
  const numeric = { balances: [{ ...REAL_RESPONSE.balances[0], balance: 42 }] };
  assert.equal(parseTokenBalance(numeric), 42);
});

test('parseTokenBalance: άδειο "balances" array σημαίνει balance=0 (καμία θέση), ΟΧΙ σφάλμα', () => {
  assert.equal(parseTokenBalance({ balances: [] }), 0);
});

test('parseTokenBalance: zero balance parses as 0, not falsy-skipped (critical for the watchdog — balance=0 IS the signal)', () => {
  assert.equal(parseTokenBalance({ balances: [{ balance: 0 }] }), 0);
  assert.equal(parseTokenBalance({ balances: [{ balance: '0' }] }), 0);
});

test('parseTokenBalance: throws with context όταν λείπει το top-level "balances"', () => {
  assert.throws(() => parseTokenBalance({ unexpected_field: 123 }), GmgnResponseError);
});

test('parseTokenBalance: throws όταν λείπει το "balance" μέσα στο πρώτο στοιχείο', () => {
  assert.throws(() => parseTokenBalance({ balances: [{ wallet_address: 'x' }] }), GmgnResponseError);
});

test('parseTokenBalance: throws on a non-object response', () => {
  assert.throws(() => parseTokenBalance(null), GmgnResponseError);
  assert.throws(() => parseTokenBalance('nope'), GmgnResponseError);
});

test('parseTokenBalance: throws όταν "balances" δεν είναι array', () => {
  assert.throws(() => parseTokenBalance({ balances: { balance: '0' } }), GmgnResponseError);
});

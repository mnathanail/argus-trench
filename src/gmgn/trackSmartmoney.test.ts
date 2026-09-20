/**
 * Fixture-based, ίδιο μοτίβο με gmgn.test.ts — το fixture αντιγράφει το τεκμηριωμένο
 * σχήμα του `.claude/skills/gmgn-track/SKILL.md` για `track kol`/`track smartmoney`
 * (ΔΕΝ είναι πραγματικό captured response, σε αντίθεση με τα trenches/activity fixtures —
 * δεν έχει γίνει ακόμα πραγματικό call σε αυτό το route μέσα στο project).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildSmartMoneyArgs, parseSmartMoneyResponse } from './trackSmartmoney.js';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__/track.smartmoney.json');

function fixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
}

test('buildSmartMoneyArgs defaults to sol chain, passes through limit/side', () => {
  assert.deepEqual(buildSmartMoneyArgs({}), ['track', 'smartmoney', '--chain', 'sol']);
  assert.deepEqual(buildSmartMoneyArgs({ chain: 'bsc', limit: 50, side: 'buy' }), [
    'track',
    'smartmoney',
    '--chain',
    'bsc',
    '--limit',
    '50',
    '--side',
    'buy',
  ]);
});

test('parseSmartMoneyResponse reads base_address (not quote_address) as the token of interest', () => {
  const trades = parseSmartMoneyResponse(fixture());
  assert.equal(trades.length, 2);
  assert.equal(trades[0]?.tokenAddress, 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump');
  assert.equal(trades[0]?.tokenSymbol, 'JEANPHIL');
});

test('parseSmartMoneyResponse converts numeric-string fields (amount_usd, price_usd) to numbers', () => {
  const [first] = parseSmartMoneyResponse(fixture());
  assert.equal(first?.amountUsd, 412.55);
  assert.equal(first?.priceUsd, 0.000224891);
  assert.equal(typeof first?.amountUsd, 'number');
});

test('parseSmartMoneyResponse keeps is_open_or_close as given — 0=open/add, 1=close/reduce (opposite of follow-wallet)', () => {
  const trades = parseSmartMoneyResponse(fixture());
  assert.equal(trades[0]?.isOpenOrClose, 0); // buy, position opened
  assert.equal(trades[1]?.isOpenOrClose, 1); // sell, position closed
});

test('parseSmartMoneyResponse carries maker_info.tags through unchanged', () => {
  const [first] = parseSmartMoneyResponse(fixture());
  assert.deepEqual(first?.makerTags, ['smart_degen', 'photon']);
});

test('parseSmartMoneyResponse tolerates a missing list (empty array, not a throw)', () => {
  assert.deepEqual(parseSmartMoneyResponse({}), []);
});

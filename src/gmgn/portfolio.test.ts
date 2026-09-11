import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePortfolioInfoSolBalances } from './portfolio.js';
import { GmgnResponseError } from './errors.js';

/** Ακριβώς το response που έστειλε ο χρήστης 2026-09-11, μετά από πραγματική κατάθεση
 * 0.0208... SOL — δεν είναι φτιαγμένο fixture, είναι το πραγματικό production JSON. */
const REAL_FUNDED_RESPONSE = {
  wallets: [
    { chain: 'arbitrum', address: '0xaa49056698da0e13d8916aee563efabfbdf45158', balances: [] },
    { chain: 'arc', address: '0xaa49056698da0e13d8916aee563efabfbdf45158', balances: [] },
    {
      chain: 'base',
      address: '0xaa49056698da0e13d8916aee563efabfbdf45158',
      balances: [
        { symbol: 'ETH', token_address: '0x0000000000000000000000000000000000000000', balance: '0', usd_value: '' },
        { symbol: 'USDC', token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', balance: '0', usd_value: '' },
      ],
    },
    {
      chain: 'sol',
      address: 'yFb3v4wfoc7fSrxXXJ9YTM6JwMVZdnus5fmKe2A6gH5',
      balances: [
        {
          symbol: 'SOL',
          token_address: 'So11111111111111111111111111111111111111111',
          balance: '0.020816731',
          usd_value: '',
        },
        {
          symbol: 'USDC',
          token_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          balance: '0',
          usd_value: '',
        },
      ],
    },
    { chain: 'stable', address: '0xaa49056698da0e13d8916aee563efabfbdf45158', balances: [] },
  ],
};

test('parsePortfolioInfoSolBalances: parses the real captured response correctly', () => {
  const balances = parsePortfolioInfoSolBalances(REAL_FUNDED_RESPONSE);
  assert.deepEqual(balances, [
    { symbol: 'SOL', balance: 0.020816731 },
    { symbol: 'USDC', balance: 0 },
  ]);
});

test('parsePortfolioInfoSolBalances: balance is parsed as a human-unit number, not a lamport integer', () => {
  const balances = parsePortfolioInfoSolBalances(REAL_FUNDED_RESPONSE);
  const sol = balances.find((b) => b.symbol === 'SOL');
  // Αν διαβαζόταν σαν lamports θα ήταν 20816731 — εδώ πρέπει να είναι το μικρό, δεκαδικό SOL ποσό.
  assert.ok(sol !== undefined && sol.balance < 1);
});

test('parsePortfolioInfoSolBalances: throws (does not silently return empty) when there is no sol-chain wallet', () => {
  assert.throws(() => parsePortfolioInfoSolBalances({ wallets: [] }), GmgnResponseError);
});

test('parsePortfolioInfoSolBalances: throws on a completely unexpected shape', () => {
  assert.throws(() => parsePortfolioInfoSolBalances({ unexpected: true }), GmgnResponseError);
});

/**
 * Ίδιο fixture με scoring.test.ts/walletDiscovery.test.ts (`portfolio.stats.json`) —
 * ΠΡΑΓΜΑΤΙΚΟ captured response 2026-09-11, όχι hand-built. Δεν υπήρχε μέχρι τώρα
 * αποκλειστικό test file για το `parseWalletStats` — προστέθηκε μαζί με την εξαγωγή
 * του `common` block (proposal "#1", 2026-09-20).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildStatsArgs, parseWalletStats } from './walletStats.js';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__/portfolio.stats.json');

function fixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
}

test('buildStatsArgs defaults to sol chain', () => {
  assert.deepEqual(buildStatsArgs({ wallet: 'W1' }), [
    'portfolio',
    'stats',
    '--chain',
    'sol',
    '--wallet',
    'W1',
  ]);
});

test('parseWalletStats reads winrate from pnl_stat, not top-level', () => {
  const stats = parseWalletStats(fixture());
  assert.equal(stats.winRate, 0.5288552507095553);
  assert.equal(stats.tokenCount, 1066);
});

test('parseWalletStats extracts common.created_at as walletCreatedAt', () => {
  const stats = parseWalletStats(fixture());
  assert.equal(stats.walletCreatedAt, 1772708253);
});

test('parseWalletStats extracts common.fund_from_address as fundFromAddress', () => {
  const stats = parseWalletStats(fixture());
  assert.equal(stats.fundFromAddress, 'GsM6EkCmSGy4FU9xyX2ti1bgGcyxTE1mQ8AeBeXyC8Jz');
});

test('parseWalletStats returns null for walletCreatedAt/fundFromAddress when common is absent', () => {
  const stats = parseWalletStats({ wallet_address: 'W1', pnl_stat: {} });
  assert.equal(stats.walletCreatedAt, null);
  assert.equal(stats.fundFromAddress, null);
});

test('parseWalletStats treats an empty fund_from_address string as null, not as a real address', () => {
  const stats = parseWalletStats({
    wallet_address: 'W1',
    pnl_stat: {},
    common: { created_at: 100, fund_from_address: '' },
  });
  assert.equal(stats.walletCreatedAt, 100);
  assert.equal(stats.fundFromAddress, null);
});

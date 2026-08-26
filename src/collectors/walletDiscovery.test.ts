import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseTrenchesResponse } from '../gmgn/trenches.js';
import type { WalletStats } from '../gmgn/walletStats.js';
import {
  passesAutoDiscoveryThreshold,
  pickRecentGraduated,
  rankCandidatesByFrequency,
} from './walletDiscovery.js';

const FIXTURE = path.join(import.meta.dirname, '../gmgn/__fixtures__/trenches.completed.json');

function completedCandidates() {
  return parseTrenchesResponse(JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown, 'completed');
}

// --- pickRecentGraduated -----------------------------------------------------------------

test('pickRecentGraduated sorts by complete_timestamp, not created_timestamp', () => {
  const candidates = completedCandidates();
  const timestamps = candidates.map((c) => Number(c.raw['complete_timestamp']));
  const picked = pickRecentGraduated(candidates, candidates.length);
  const pickedTimestamps = picked.map((c) => Number(c.raw['complete_timestamp']));
  assert.deepEqual(
    pickedTimestamps,
    [...timestamps].sort((a, b) => b - a),
  );
});

test('pickRecentGraduated respects the sample size', () => {
  const candidates = completedCandidates();
  assert.ok(candidates.length >= 3, 'το fixture πρέπει να έχει αρκετά items για το test');
  assert.equal(pickRecentGraduated(candidates, 3).length, 3);
});

test('pickRecentGraduated treats a missing complete_timestamp as oldest, not first', () => {
  const [a, b] = completedCandidates();
  assert.ok(a && b);
  const withMissing = [
    { ...a, raw: { ...a.raw, complete_timestamp: undefined } },
    { ...b, raw: { ...b.raw, complete_timestamp: 9_999_999_999 } },
  ];
  const picked = pickRecentGraduated(withMissing, 2);
  assert.equal(picked[0]?.tokenAddress, b.tokenAddress);
});

// --- rankCandidatesByFrequency ------------------------------------------------------------

function holder(address: string) {
  return { address, tags: ['smart_degen'] };
}

test('rankCandidatesByFrequency ranks multi-token wallets first but keeps single-token ones', () => {
  const perToken = [
    [holder('W_multi'), holder('W_single_1')],
    [holder('W_multi'), holder('W_single_2')],
    [holder('W_multi')],
  ];
  const ranked = rankCandidatesByFrequency(perToken);

  assert.equal(ranked[0]?.address, 'W_multi');
  assert.equal(ranked[0]?.tokenCount, 3);
  // Single-appearance wallets ΔΕΝ αποκλείονται — απλά βαρύνουν λιγότερο.
  const singles = ranked.filter((c) => c.tokenCount === 1).map((c) => c.address);
  assert.deepEqual(new Set(singles), new Set(['W_single_1', 'W_single_2']));
});

test('rankCandidatesByFrequency does not double-count duplicate holders within one token', () => {
  const ranked = rankCandidatesByFrequency([[holder('W1'), holder('W1')]]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.tokenCount, 1);
});

test('rankCandidatesByFrequency on no tokens returns no candidates', () => {
  assert.deepEqual(rankCandidatesByFrequency([]), []);
});

// --- passesAutoDiscoveryThreshold ---------------------------------------------------------

function stats(overrides: Partial<WalletStats> = {}): WalletStats {
  return {
    walletAddress: 'W1',
    winRate: 0.6,
    tokenCount: 20,
    realizedPnlRatio: 0.3,
    realizedProfitUsd: 100,
    buyCount: 500,
    sellCount: 480,
    avgHoldingPeriodSec: 3600,
    lastTradeAt: 0,
    ...overrides,
  };
}

test('passesAutoDiscoveryThreshold matches the manual advisory floor exactly: winRate > 0.5 AND tokenCount >= 15', () => {
  assert.equal(passesAutoDiscoveryThreshold(stats({ winRate: 0.6, tokenCount: 20 })), true);
  // Boundary: win rate είναι strict >, token count είναι >=.
  assert.equal(passesAutoDiscoveryThreshold(stats({ winRate: 0.5, tokenCount: 20 })), false);
  assert.equal(passesAutoDiscoveryThreshold(stats({ winRate: 0.6, tokenCount: 15 })), true);
  assert.equal(passesAutoDiscoveryThreshold(stats({ winRate: 0.6, tokenCount: 14 })), false);
});

test('passesAutoDiscoveryThreshold rejects nulls instead of coercing to zero', () => {
  assert.equal(passesAutoDiscoveryThreshold(stats({ winRate: null })), false);
  assert.equal(passesAutoDiscoveryThreshold(stats({ tokenCount: null })), false);
});

test('passesAutoDiscoveryThreshold uses tokenCount (token_num), a wallet with huge buy+sell but few tokens still fails', () => {
  // Ίδιο σκεπτικό με το CLAUDE.md: buy+sell μπορεί να είναι ~5× το token_num.
  assert.equal(
    passesAutoDiscoveryThreshold(stats({ winRate: 0.9, tokenCount: 5, buyCount: 5000, sellCount: 5000 })),
    false,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WalletActivity } from '../gmgn/activity.js';
import { computeOwnSellRatio } from './ownSellRatio.js';

const T = 'TokenX';
const ENTRY = Date.UTC(2026, 8, 28, 19, 11, 51);
const act = (eventType: 'buy' | 'sell', secAfterEntry: number, costUsd: number | null, priceUsd: number | null, token = T): WalletActivity => ({
  wallet: 'W', txHash: `${eventType}-${secAfterEntry}`, eventType, tokenAddress: token, tokenSymbol: null,
  tokenAmount: 632241.86, costUsd, priceUsd, timestamp: Math.floor((ENTRY + secAfterEntry * 1000) / 1000), launchpadPlatform: null,
});

test('computeOwnSellRatio: sell USD / buy USD — MUSCLE, native stop-loss (−59%)', () => {
  const r = computeOwnSellRatio([act('buy', 2, 5.897, 0.0000093276)], [act('sell', 36000, 2.406, 0.0000038059)], T, ENTRY);
  assert.ok(r !== null);
  assert.equal(r.source, 'cost_usd');
  assert.ok(Math.abs(r.ratio - 2.406 / 5.897) < 1e-9);
  assert.equal(r.sellTxHash, 'sell-36000');
});

test('computeOwnSellRatio: several partial sells are summed; sells of other tokens / before the buy are ignored', () => {
  const r = computeOwnSellRatio(
    [act('buy', 1, 6, 1)],
    [act('sell', -600, 99, 1), act('sell', 100, 2, 1), act('sell', 200, 1, 1), act('sell', 150, 50, 1, 'Other')],
    T, ENTRY,
  );
  assert.ok(r !== null);
  assert.ok(Math.abs(r.ratio - 0.5) < 1e-9);
  assert.equal(r.sellTxHash, 'sell-200');
});

test('computeOwnSellRatio: no cost_usd → price ratio; no buy or no sell → null', () => {
  const r = computeOwnSellRatio([act('buy', 1, null, 2)], [act('sell', 100, null, 3)], T, ENTRY);
  assert.equal(r?.source, 'price_usd');
  assert.ok(Math.abs((r?.ratio ?? 0) - 1.5) < 1e-9);
  assert.equal(computeOwnSellRatio([], [act('sell', 100, 1, 1)], T, ENTRY), null);
  assert.equal(computeOwnSellRatio([act('buy', 1, 6, 1)], [], T, ENTRY), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickUnscannedTokens } from '../collectors/walletDiscovery.js';
import { buildTrendingArgs, parseTrendingResponse } from './trending.js';

// ⚠️ Σχήμα από το SKILL.md (`data.rank`), όχι πραγματικό response — επαλήθευση με
// `npm run top-traders-check` (τυπώνει την αρχή του response αν το σχήμα δεν ταιριάζει).
const item = { address: 'TokA', history_highest_market_cap: '812000.5', creation_timestamp: 1759140000, symbol: 'A' };

test('buildTrendingArgs: Pump.fun tokens 1h–3d old that already ran, by 24h volume', () => {
  const args = buildTrendingArgs();
  const flag = (f: string): string | undefined => args[args.indexOf(f) + 1];
  assert.equal(flag('--interval'), '24h');
  assert.equal(flag('--platform'), 'Pump.fun');
  assert.equal(flag('--min-created'), '1h');
  assert.equal(flag('--max-created'), '3d');
  assert.equal(flag('--min-history-highest-marketcap'), '250000');
  assert.equal(flag('--order-by'), 'volume');
});

test('parseTrendingResponse accepts data.rank, rank, list and a bare array', () => {
  for (const raw of [{ data: { rank: [item] } }, { rank: [item] }, { list: [item] }, [item], { data: [item] }]) {
    assert.deepEqual(parseTrendingResponse(raw), [
      { address: 'TokA', symbol: 'A', historyHighestMarketCap: 812000.5, creationTimestamp: 1759140000 },
    ]);
  }
});

test('parseTrendingResponse fails loudly on an unknown shape', () => {
  assert.throws(() => parseTrendingResponse({ data: { tokens: [item] } }), /rank/);
});

test('pickUnscannedTokens skips tokens scanned recently and duplicates, keeps order', () => {
  const t = (address: string) => ({ address, historyHighestMarketCap: null, creationTimestamp: null });
  const picked = pickUnscannedTokens([t('A'), t('B'), t('A'), t('C'), t('D')], new Map([['B', 0]]), 2);
  assert.deepEqual(picked, [{ tokenAddress: 'A' }, { tokenAddress: 'C' }]);
});

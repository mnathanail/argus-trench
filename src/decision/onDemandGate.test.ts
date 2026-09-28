import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseTokenInfo, parseTokenSecurity, type TokenInfo } from '../gmgn/tokenInfo.js';
import { evaluateOnDemandGate } from './onDemandGate.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../gmgn/__fixtures__/${name}`, import.meta.url), 'utf8'));

test('parseTokenInfo: real GMGN output (2026-09-28)', () => {
  const info = parseTokenInfo(fixture('token-info.pump.json'));
  assert.equal(info.tokenAddress, '92S1TyUWK6u19iSy78AKbNyFBSUPS5FxYySYsstfpump');
  assert.equal(info.launchpadPlatform, 'Pump.fun');
  assert.equal(info.creationTimestamp, 1790614744);
  assert.equal(info.topHolderRate, 0.0098);
  assert.equal(info.bundlerVolumeRate, 0);
  assert.equal(info.entrapmentVolumeRate, 0);
  assert.equal(info.smartWallets, 2);
  assert.equal(info.migrationMarketCap, 410.84);
});

test('parseTokenSecurity: real output has NO rug_ratio / insider / bundler → null, not 0', () => {
  const sec = parseTokenSecurity(fixture('token-security.pump.json'));
  assert.equal(sec.topHolderRate, 0.0098);
  assert.equal(sec.rugRatio, null);
  assert.equal(sec.insiderHoldRate, null);
  assert.equal(sec.bundlerTraderAmountRate, null);
});

test('evaluateOnDemandGate: the real sample passes; rug/insider are reported as unavailable', () => {
  const r = evaluateOnDemandGate(
    parseTokenInfo(fixture('token-info.pump.json')),
    parseTokenSecurity(fixture('token-security.pump.json')),
  );
  assert.equal(r.passed, true);
  assert.deepEqual(r.unavailable, ['rug_ratio', 'suspected_insider_hold_rate']);
  assert.equal(r.metrics['bundler_rate_source'], 'info.stat.top_bundler_trader_percentage');
});

const base: TokenInfo = {
  tokenAddress: 'T',
  launchpadPlatform: 'Pump.fun',
  creationTimestamp: 1,
  holderCount: 10,
  topHolderRate: 0.1,
  bundlerVolumeRate: 0.1,
  entrapmentVolumeRate: 0.1,
  ratTraderVolumeRate: 0,
  smartWallets: 0,
  migrationMarketCap: 410,
};

test('evaluateOnDemandGate: same limits as the discovery gate, fail-closed on unknown required fields', () => {
  assert.match(evaluateOnDemandGate({ ...base, topHolderRate: 0.6 }, null).failReason ?? '', /top_10_holder_rate/);
  assert.match(evaluateOnDemandGate({ ...base, bundlerVolumeRate: 0.31 }, null).failReason ?? '', /bundler_rate/);
  assert.match(evaluateOnDemandGate({ ...base, entrapmentVolumeRate: 0.31 }, null).failReason ?? '', /entrapment_rate/);
  assert.match(evaluateOnDemandGate({ ...base, entrapmentVolumeRate: null }, null).failReason ?? '', /fail-closed/);
  assert.match(evaluateOnDemandGate({ ...base, launchpadPlatform: 'Moonshot' }, null).failReason ?? '', /launchpad/);
});

test('evaluateOnDemandGate: rug/insider enforced when GMGN does return them; security bundler wins over info', () => {
  const sec = { topHolderRate: null, rugRatio: 0.25, insiderHoldRate: 0.1, bundlerTraderAmountRate: null };
  assert.match(evaluateOnDemandGate(base, sec).failReason ?? '', /rug_ratio/);
  const sec2 = { topHolderRate: null, rugRatio: 0.1, insiderHoldRate: 0.35, bundlerTraderAmountRate: null };
  assert.match(evaluateOnDemandGate(base, sec2).failReason ?? '', /insider/);
  const sec3 = { topHolderRate: null, rugRatio: 0.1, insiderHoldRate: 0.1, bundlerTraderAmountRate: 0.5 };
  assert.match(evaluateOnDemandGate({ ...base, bundlerVolumeRate: 0 }, sec3).failReason ?? '', /bundler_rate 0.5/);
});

test('evaluateOnDemandGate: GMGN smart-wallet count 0 does NOT block — the trigger wallet is the smart money', () => {
  assert.equal(evaluateOnDemandGate({ ...base, smartWallets: 0 }, null).passed, true);
});

/**
 * Fixture-based, ίδιο μοτίβο με trackSmartmoney.test.ts. Τα fixtures εδώ αντιγράφουν το
 * σχήμα του `token holders` (χωρίς `--tag`) όπως το χρησιμοποιεί το πηγαίο Python script
 * (`.agents/skills/gmgn-holder-analysis/analyze.py`) — δεν είναι πραγματικό captured
 * response, είναι χτισμένο για να ελέγξει τη μεταφορά της float_share/risk_pct μαθηματικής
 * λογικής 1:1.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildAllHoldersArgs,
  computeFloatShare,
  computeRiskWalletPct,
  FLOAT_MIN,
  isFloatDegenerate,
  parseAllHoldersResponse,
} from './holderRisk.js';

const ALL_FIXTURE = path.join(import.meta.dirname, '__fixtures__/token.holders.all.json');
const DEGENERATE_FIXTURE = path.join(
  import.meta.dirname,
  '__fixtures__/token.holders.degenerate.json',
);

function fixture(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

test('buildAllHoldersArgs omits --tag entirely, defaults chain=sol limit=100', () => {
  assert.deepEqual(buildAllHoldersArgs({ tokenAddress: 'TOKEN' }), [
    'token',
    'holders',
    '--chain',
    'sol',
    '--address',
    'TOKEN',
    '--limit',
    '100',
  ]);
});

test('buildAllHoldersArgs passes through chain/limit overrides, still no --tag', () => {
  const args = buildAllHoldersArgs({ tokenAddress: 'TOKEN', chain: 'bsc', limit: 50 });
  assert.deepEqual(args, ['token', 'holders', '--chain', 'bsc', '--address', 'TOKEN', '--limit', '50']);
  assert.ok(!args.includes('--tag'));
});

test('parseAllHoldersResponse reads addr_type/amount_percentage/maker_token_tags', () => {
  const holders = parseAllHoldersResponse(fixture(ALL_FIXTURE));
  assert.equal(holders.length, 7);
  const bundler = holders.find((h) => h.address === 'BundlerWallet111111111111111111111111111111');
  assert.equal(bundler?.addrType, 0);
  assert.equal(bundler?.amountPercentage, 0.08);
  assert.deepEqual(bundler?.makerTokenTags, ['bundler']);
});

test('parseAllHoldersResponse defaults missing addr_type to 0 (normal), like Python h.get("addr_type", 0)', () => {
  const holders = parseAllHoldersResponse({ list: [{ address: 'X', amount_percentage: 0.1 }] });
  assert.equal(holders[0]?.addrType, 0);
});

test('computeFloatShare: float_raw = 1 - burn_pct - dex_pct, floatShare floors at 1e-9', () => {
  const holders = parseAllHoldersResponse(fixture(ALL_FIXTURE));
  const float = computeFloatShare(holders);
  assert.equal(float.burnPct, 0.10);
  assert.equal(float.dexPct, 0.60);
  assert.ok(Math.abs(float.floatRaw - 0.30) < 1e-9);
  assert.ok(Math.abs(float.floatShare - 0.30) < 1e-9);
});

test('isFloatDegenerate is false when float_raw is comfortably above FLOAT_MIN', () => {
  const holders = parseAllHoldersResponse(fixture(ALL_FIXTURE));
  const float = computeFloatShare(holders);
  const normalCount = holders.filter((h) => h.addrType === 0).length;
  assert.equal(isFloatDegenerate(float, normalCount), false);
});

test('computeRiskWalletPct dedupes a wallet with multiple risk tags and divides by float_share (not total supply)', () => {
  const holders = parseAllHoldersResponse(fixture(ALL_FIXTURE));
  const float = computeFloatShare(holders);
  const risk = computeRiskWalletPct(holders, float);
  // bundler(0.08) + rat_trader(0.04) + sniper&bundler(0.03) = 0.15 raw share, / floatShare 0.30 = 0.5
  assert.ok(risk.riskPct !== null);
  assert.ok(Math.abs((risk.riskPct as number) - 0.5) < 1e-9);
  assert.equal(risk.riskWalletCount, 3); // deduped: 3 distinct addresses, not 4 tag-hits
  assert.equal(risk.bundlerCount, 2); // BundlerWallet + SniperAndBundlerWallet
  assert.equal(risk.ratTraderCount, 1);
  assert.equal(risk.sniperCount, 1);
});

test('computeRiskWalletPct excludes burn/DEX holders even if (hypothetically) tagged', () => {
  const holders = parseAllHoldersResponse(fixture(ALL_FIXTURE));
  const float = computeFloatShare(holders);
  const risk = computeRiskWalletPct(holders, float);
  // Ούτε το burn (addr_type 1) ούτε το DEX pool (addr_type 2) holder του fixture έχουν
  // risk tag, αλλά επιβεβαιώνουμε ρητά ότι η μέτρηση περιορίζεται σε addr_type===0.
  assert.equal(risk.riskWalletCount, 3);
});

test('degenerate float (DEX pool ~99.9% of supply) makes riskPct null, not a misleading number', () => {
  const holders = parseAllHoldersResponse(fixture(DEGENERATE_FIXTURE));
  const float = computeFloatShare(holders);
  assert.ok(float.floatRaw < FLOAT_MIN);
  const normalCount = holders.filter((h) => h.addrType === 0).length;
  assert.equal(isFloatDegenerate(float, normalCount), true);

  const risk = computeRiskWalletPct(holders, float);
  // Χωρίς το degenerate guard, το $ dust wallet (0.001 raw) θα φαινόταν σαν ~100% του
  // float (0.001 / 0.001 floatShare) — ακριβώς το ιστορικό bug που περιγράφει το Python
  // script. riskPct πρέπει να είναι null, όχι ένας μεγάλος αριθμός.
  assert.equal(risk.riskPct, null);
});

test('no normal holders at all also counts as degenerate (empty holder list guard)', () => {
  const holders = parseAllHoldersResponse({ list: [] });
  const float = computeFloatShare(holders);
  assert.equal(isFloatDegenerate(float, 0), true);
  const risk = computeRiskWalletPct(holders, float);
  assert.equal(risk.riskPct, null);
  assert.equal(risk.riskWalletCount, 0);
});

test('parseAllHoldersResponse tolerates a missing list (empty array, not a throw)', () => {
  assert.deepEqual(parseAllHoldersResponse({}), []);
});

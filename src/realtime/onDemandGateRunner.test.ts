import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';

import { parseTokenInfo, type TokenInfo } from '../gmgn/tokenInfo.js';
import { resetOnDemandGateState, tryOnDemandGate, type OnDemandGateDeps } from './onDemandGateRunner.js';

const INFO: TokenInfo = parseTokenInfo(
  JSON.parse(readFileSync(new URL('../gmgn/__fixtures__/token-info.pump.json', import.meta.url), 'utf8')),
);
const SEC = { topHolderRate: 0.0098, rugRatio: null, insiderHoldRate: null, bundlerTraderAmountRate: null };

function deps(overrides: Partial<OnDemandGateDeps> = {}) {
  const inserts: { gatePassed: boolean; gateSnapshot: Record<string, unknown> }[] = [];
  let infoCalls = 0;
  const d: OnDemandGateDeps = {
    enabled: true,
    maxPerMinute: 2,
    now: () => 1_000_000,
    hasAnyGateEvaluation: async () => false,
    fetchInfo: async () => {
      infoCalls += 1;
      return INFO;
    },
    fetchSecurity: async () => SEC,
    insert: async (input) => {
      inserts.push(input);
      return 1;
    },
    log: () => {},
    ...overrides,
  };
  return { d, inserts, infoCalls: () => infoCalls };
}

beforeEach(() => resetOnDemandGateState());

test('passes the real sample and records the evaluation with created_timestamp', async () => {
  const { d, inserts } = deps();
  assert.equal(await tryOnDemandGate('MintA', 'v', d), 'passed');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]?.gatePassed, true);
  assert.equal(inserts[0]?.gateSnapshot['created_timestamp'], 1790614744);
  assert.equal(inserts[0]?.gateSnapshot['source'], 'on_demand');
});

test('already evaluated (by discovery or earlier on-demand) → skipped, no GMGN call', async () => {
  const t = deps({ hasAnyGateEvaluation: async () => true });
  assert.equal(await tryOnDemandGate('MintA', 'v', t.d), 'skipped');
  assert.equal(t.infoCalls(), 0);
});

test('concurrent events for the same token share ONE check', async () => {
  const t = deps();
  const [a, b] = await Promise.all([tryOnDemandGate('MintA', 'v', t.d), tryOnDemandGate('MintA', 'v', t.d)]);
  assert.deepEqual([a, b], ['passed', 'passed']);
  assert.equal(t.infoCalls(), 1);
});

test('rate cap per minute', async () => {
  const t = deps();
  assert.equal(await tryOnDemandGate('M1', 'v', t.d), 'passed');
  assert.equal(await tryOnDemandGate('M2', 'v', t.d), 'passed');
  assert.equal(await tryOnDemandGate('M3', 'v', t.d), 'skipped');
});

test('token info failure → skipped (nothing recorded, retried on the next signal); security failure is tolerated', async () => {
  const bad = deps({ fetchInfo: async () => { throw new Error('HTTP 500'); } });
  assert.equal(await tryOnDemandGate('M1', 'v', bad.d), 'skipped');
  assert.equal(bad.inserts.length, 0);

  const noSec = deps({ fetchSecurity: async () => { throw new Error('HTTP 500'); } });
  assert.equal(await tryOnDemandGate('M2', 'v', noSec.d), 'passed');
});

test('failed gate is recorded as failed (so it is not re-checked)', async () => {
  const t = deps({ fetchInfo: async () => ({ ...INFO, topHolderRate: 0.9 }) });
  assert.equal(await tryOnDemandGate('M1', 'v', t.d), 'failed');
  assert.equal(t.inserts[0]?.gatePassed, false);
});

test('disabled → skipped', async () => {
  const t = deps({ enabled: false });
  assert.equal(await tryOnDemandGate('M1', 'v', t.d), 'skipped');
});

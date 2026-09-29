import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StrategyOrderInfo } from '../gmgn/strategyOrders.js';
import { attachNativeStrategy, NATIVE_ATTACH_ATTEMPTS, type AttachDeps } from './nativeStrategyAttach.js';

const STRATEGY = { orderId: 'fc919ed0', status: 'open', strategyStatus: 'running' } as StrategyOrderInfo;

function deps(findResults: (StrategyOrderInfo | null | Error)[]) {
  const saved: [number, string][] = [];
  let missing = 0;
  let calls = 0;
  const d: AttachDeps = {
    find: async () => {
      const r = findResults[Math.min(calls++, findResults.length - 1)];
      if (r instanceof Error) throw r;
      return r ?? null;
    },
    save: async (id, orderId) => { saved.push([id, orderId]); },
    reportMissing: async () => { missing += 1; },
    sleep: async () => {},
    log: () => {},
  };
  return { d, saved, missing: () => missing, calls: () => calls };
}

test('attachNativeStrategy: the strategy appears after the swap → saved on the attempt it shows up', async () => {
  const t = deps([null, new Error('HTTP 500'), STRATEGY]);
  const r = await attachNativeStrategy(6549, 'W', 'GqqA', 0, t.d);
  assert.equal(r?.orderId, 'fc919ed0');
  assert.deepEqual(t.saved, [[6549, 'fc919ed0']]);
  assert.equal(t.calls(), 3);
  assert.equal(t.missing(), 0);
});

test('attachNativeStrategy: never found → reported once, nothing saved', async () => {
  const t = deps([null]);
  assert.equal(await attachNativeStrategy(1, 'W', 'T', 0, t.d), null);
  assert.equal(t.calls(), NATIVE_ATTACH_ATTEMPTS);
  assert.equal(t.missing(), 1);
  assert.deepEqual(t.saved, []);
});

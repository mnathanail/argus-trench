import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MirrorShadowState } from '../db/repositories/mirror.js';
import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { advanceShadow, handleMirrorShadowTick, hasActiveShadow, setMirrorShadowsForTest, SHADOW_TIMEOUT_MS, shadowPnl, type ShadowDeps } from './mirrorShadow.js';

const T0 = 1_800_000_000_000;
const st = (o: Partial<MirrorShadowState> = {}): MirrorShadowState => ({
  positionId: 1,
  tokenAddress: 'Tok',
  openedAt: new Date(T0),
  entryPrice: 1,
  peakPrice: 1,
  trailingActive: false,
  ...o,
});

test('advanceShadow: stop-loss −50%', () => {
  const r = advanceShadow(st(), 0.45, T0 + 1000);
  assert.equal(r.kind, 'exit');
  assert.equal(r.kind === 'exit' && r.reason, 'stop_loss');
});

test('advanceShadow: +50% ενεργοποιεί trailing, −25% από peak → trailing_stop', () => {
  const a = advanceShadow(st(), 1.6, T0 + 1000);
  assert.equal(a.kind, 'update');
  assert.ok(a.kind === 'update' && a.trailingActive && a.changed);
  const b = advanceShadow(st({ peakPrice: 3, trailingActive: true }), 2.2, T0 + 2000);
  assert.equal(b.kind, 'exit');
  assert.ok(b.kind === 'exit' && b.reason === 'trailing_stop' && Math.abs(b.exitPrice - 2.2) < 1e-9);
});

test('advanceShadow: 24h χωρίς έξοδο → timeout στην τιμή', () => {
  const r = advanceShadow(st(), 1.1, T0 + SHADOW_TIMEOUT_MS);
  assert.ok(r.kind === 'exit' && r.reason === 'timeout' && r.exitPrice === 1.1);
});

test('advanceShadow: χωρίς αλλαγή peak/trailing → changed=false', () => {
  const r = advanceShadow(st({ peakPrice: 1.2 }), 1.1, T0 + 1000);
  assert.ok(r.kind === 'update' && !r.changed);
});

test('shadowPnl: 0.1 SOL (default), ×2 → +0.1 − 2% fees', () => {
  const { pnlSol } = shadowPnl(1, 2);
  assert.ok(Math.abs(pnlSol - (0.1 - 0.1 * 0.02)) < 1e-9, String(pnlSol));
});

function ev(price: number, mint = 'Tok'): PumpPortalTradeEvent {
  // graduated-style event → τιμή = sol/tokens
  return { signature: 's' + price, mint, traderPublicKey: 'X', txType: 'buy', tokenAmount: 100, solAmount: price * 100, pool: 'pump-amm' };
}

test('handleMirrorShadowTick: ενημερώνει, κλείνει, αφαιρεί από το cache· άσχετο token → τίποτα', async () => {
  const updates: unknown[] = [];
  const closes: { reason: string }[] = [];
  const deps: ShadowDeps = {
    update: async (i) => void updates.push(i),
    close: async (i) => void closes.push(i),
    nowMs: () => T0 + 1000,
  };
  setMirrorShadowsForTest([st()]);
  assert.deepEqual(await handleMirrorShadowTick(ev(5, 'Other'), deps), []);
  await handleMirrorShadowTick(ev(1.6), deps); // trailing on
  await handleMirrorShadowTick(ev(2.0), deps); // νέο peak
  assert.equal(updates.length, 2);
  const closed = await handleMirrorShadowTick(ev(1.4), deps); // < 2.0×0.75=1.5 → trailing_stop
  assert.equal(closed.length, 1);
  assert.equal(closes[0]!.reason, 'trailing_stop');
  assert.equal(hasActiveShadow('Tok'), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkTick } from './tickExit.js';
import { decideShadowTick, shadowTick, type ShadowState, type TrailingConfirmationRules } from './shadowExit.js';
import type { PumpPortalTradeEvent } from './pumpportalEvents.js';

const ENTRY_AT = new Date('2026-09-27T21:22:10Z');
const RULES: TrailingConfirmationRules = { graceMs: 60_000, confirmMs: 10_000 };
const at = (sec: number): Date => new Date(ENTRY_AT.getTime() + sec * 1000);
const fresh: ShadowState = { peak: null, trailingActive: false, breachSince: null };

function step(state: ShadowState, sec: number, price: number) {
  return shadowTick({ entryPrice: 1, entryAt: ENTRY_AT, now: at(sec), currentPrice: price, state }, RULES);
}

test('REGRESSION 6442: ×3 then a 25%+ wick at 19″ — today\'s logic exits, the shadow 4B does NOT (inside grace)', () => {
  // Σημερινή λογική: peak 3 → stop 2.25 → tick 2.2 = trailing_stop.
  const real = checkTick({ entryPrice: 1, peakPriceSinceEntry: 3, trailingActive: true, currentPrice: 2.2 });
  assert.equal(real.exit?.exitReason, 'trailing_stop');

  let r = step(fresh, 5, 3.0);
  assert.equal(r.exit, null);
  assert.equal(r.state.trailingActive, true);
  r = step(r.state, 19, 2.2);
  assert.equal(r.exit, null, 'μέσα στο grace το trailing δεν βγαίνει');
  assert.equal(r.state.breachSince, null, 'το ρολόι επιβεβαίωσης δεν ξεκινάει μέσα στο grace');
});

test('after grace: exits only once the price stays below the stop for the confirmation window', () => {
  let r = step(fresh, 5, 3.0); // peak 3, stop 2.25
  r = step(r.state, 70, 2.2); // πρώτο tick κάτω από το stop μετά το grace → αρχίζει το ρολόι
  assert.equal(r.exit, null);
  assert.equal(r.state.breachSince?.getTime(), at(70).getTime());
  r = step(r.state, 75, 2.1); // 5″ < 10″
  assert.equal(r.exit, null);
  r = step(r.state, 80, 2.0); // 10″ → έξοδος στην τρέχουσα τιμή
  assert.deepEqual(r.exit, { reason: 'trailing_stop', price: 2.0 });
});

test('a tick back above the stop resets the confirmation clock (a wick, not a real reversal)', () => {
  let r = step(fresh, 5, 3.0);
  r = step(r.state, 70, 2.2); // ρολόι από 70″
  r = step(r.state, 74, 2.6); // πάνω από το stop 2.25 → μηδενισμός
  assert.equal(r.state.breachSince, null);
  r = step(r.state, 78, 2.2); // νέο ρολόι από 78″
  r = step(r.state, 82, 2.2); // μόνο 4″
  assert.equal(r.exit, null);
});

test('a new peak raises the stop; the confirmed exit uses the new stop', () => {
  let r = step(fresh, 5, 3.0);
  r = step(r.state, 100, 8.0); // peak 8 → stop 6
  assert.equal(r.state.peak, 8);
  r = step(r.state, 110, 5.9);
  r = step(r.state, 121, 5.8);
  assert.deepEqual(r.exit, { reason: 'trailing_stop', price: 5.8 });
});

test('stop-loss stays IMMEDIATE, even inside the grace period', () => {
  const r = step(fresh, 3, 0.4);
  assert.deepEqual(r.exit, { reason: 'stop_loss', price: 0.4 });
});

test('before activation (+50%) there is no trailing at all', () => {
  const r = step(fresh, 90, 1.3);
  assert.equal(r.exit, null);
  assert.equal(r.state.trailingActive, false);
});

// --- decideShadowTick ---

const TOKEN = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const WALLET = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
function ev(price: number, overrides: Partial<PumpPortalTradeEvent> = {}): PumpPortalTradeEvent {
  return {
    signature: 's', mint: TOKEN, traderPublicKey: 'Other111', txType: 'buy', tokenAmount: 100, solAmount: 1,
    vSolInBondingCurve: price, vTokensInBondingCurve: 1, marketCapSol: 1, pool: 'pump', ...overrides,
  };
}
const trade = (state: ShadowState = fresh) => ({ entryPrice: 1, entryAt: ENTRY_AT, triggerWalletAddress: WALLET, state });

test('decideShadowTick: trigger wallet sells → exit_signal, same as the real logic', () => {
  const d = decideShadowTick(trade(), ev(1.2, { txType: 'sell', traderPublicKey: WALLET }), at(30), RULES);
  assert.deepEqual(d, { type: 'exit', reason: 'exit_signal', price: 1.2 });
});

test('decideShadowTick: a tick after 24h closes the shadow as timeout at that tick\'s price', () => {
  const d = decideShadowTick(trade({ peak: 2, trailingActive: true, breachSince: null }), ev(1.7), at(24 * 3600 + 1), RULES);
  assert.deepEqual(d, { type: 'exit', reason: 'timeout', price: 1.7 });
});

test('decideShadowTick: no price (graduated dust) → ignore; unchanged state → ignore (no wasted write)', () => {
  const dust = ev(1, { pool: undefined, vSolInBondingCurve: undefined, vTokensInBondingCurve: undefined, solAmount: 0.0009 });
  assert.deepEqual(decideShadowTick(trade(), dust, at(30), RULES), { type: 'ignore' });
  const s: ShadowState = { peak: 1.3, trailingActive: false, breachSince: null };
  assert.deepEqual(decideShadowTick(trade(s), ev(1.2), at(30), RULES), { type: 'ignore' });
});

test('decideShadowTick: a new peak → update', () => {
  const d = decideShadowTick(trade(), ev(1.6), at(30), RULES);
  assert.deepEqual(d, { type: 'update', state: { peak: 1.6, trailingActive: true, breachSince: null } });
});

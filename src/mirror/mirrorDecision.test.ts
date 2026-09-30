import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { mirrorBuySol } from './mirrorConfig.js';
import { decideMirror, mirrorPnl, type MirrorPositionState } from './mirrorDecision.js';

const W = '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5';
const OTHER = '4UrFSCrGxgoCtCUBAEZq7ZmPK3Pczkxx7PwYnkBMi1KR';
const CFG = { buySol: 0.1, entrySlippagePct: 0.03 };

/** Bonding-curve event με τιμή = price SOL/token (vSol/vTokens). */
function ev(overrides: Partial<PumpPortalTradeEvent> = {}, price = 0.0001): PumpPortalTradeEvent {
  return {
    signature: 'sig',
    mint: 'Mint',
    traderPublicKey: W,
    txType: 'buy',
    tokenAmount: 1_000_000,
    solAmount: 100,
    vSolInBondingCurve: price * 1_000_000_000,
    vTokensInBondingCurve: 1_000_000_000,
    marketCapSol: 50,
    pool: 'pump',
    ...overrides,
  };
}

function pos(overrides: Partial<MirrorPositionState> = {}): MirrorPositionState {
  return { id: 1, walletAddress: W, tokensHeld: 1000, solIn: 0.2, solOut: 0, targetTokensEst: 2_000_000, lastPriceSol: 0.0001, ...overrides };
}

test('first buy opens a position with the fixed amount, entry slippage applied', () => {
  const d = decideMirror(ev({ newTokenBalance: 1_000_000 }), null, CFG);
  assert.equal(d.action, 'buy');
  if (d.action !== 'buy') return;
  assert.equal(d.open, true);
  assert.equal(d.ourSol, 0.1);
  assert.ok(Math.abs(d.fillPrice - 0.000103) < 1e-12);
  assert.ok(Math.abs(d.ourTokens - 0.1 / 0.000103) < 1e-6);
  assert.equal(d.targetBalanceAfter, 1_000_000);
});

test('every further buy of the same wallet adds the same fixed amount (re-buys mirrored)', () => {
  const d = decideMirror(ev(), pos(), CFG);
  assert.ok(d.action === 'buy' && !d.open && d.ourSol === 0.1);
});

test('partial sell mirrors the same % using newTokenBalance', () => {
  // πούλησε 500k από 2M (υπόλοιπο 1.5M) → 25%
  const d = decideMirror(ev({ txType: 'sell', tokenAmount: 500_000, newTokenBalance: 1_500_000 }), pos(), CFG);
  assert.equal(d.action, 'sell');
  if (d.action !== 'sell') return;
  assert.equal(d.close, false);
  assert.ok(Math.abs(d.pct - 0.25) < 1e-12);
  assert.ok(Math.abs(d.ourTokens - 250) < 1e-9);
  assert.equal(d.pctSource, 'new_token_balance');
});

test('full exit of the wallet closes the whole position', () => {
  const d = decideMirror(ev({ txType: 'sell', tokenAmount: 2_000_000, newTokenBalance: 0 }), pos(), CFG);
  assert.ok(d.action === 'sell' && d.close && d.ourTokens === 1000 && d.pct === 1);
});

test('without newTokenBalance the % comes from our estimate; with no estimate at all we exit fully', () => {
  const est = decideMirror(ev({ txType: 'sell', tokenAmount: 1_000_000 }), pos(), CFG);
  assert.ok(est.action === 'sell' && Math.abs(est.pct - 0.5) < 1e-12 && est.pctSource === 'estimate');
  const unknown = decideMirror(ev({ txType: 'sell' }), pos({ targetTokensEst: null }), CFG);
  assert.ok(unknown.action === 'sell' && unknown.close && unknown.pctSource === 'unknown_full_exit');
});

test('a sell with no usable price uses the last known price, never leaves us stuck', () => {
  // graduated dust sell: pool pump-amm χωρίς curve πεδία και solAmount < 0.01 → καμία τιμή
  const e = ev({ txType: 'sell', pool: 'pump-amm', vSolInBondingCurve: undefined, vTokensInBondingCurve: undefined, solAmount: 0.001, newTokenBalance: 0, tokenAmount: 2_000_000 });
  const d = decideMirror(e, pos({ lastPriceSol: 0.0002 }), CFG);
  assert.ok(d.action === 'sell' && d.close && d.priceSol === 0.0002);
});

test('ignored: other pools, a token already mirrored from another wallet, sells without a position', () => {
  assert.deepEqual(decideMirror(ev({ pool: 'raydium' }), null, CFG), { action: 'ignored', reason: 'pool', priceSol: null });
  const other = decideMirror(ev({ traderPublicKey: OTHER }), pos(), CFG);
  assert.ok(other.action === 'ignored' && other.reason === 'other_wallet_position');
  const noPos = decideMirror(ev({ txType: 'sell' }), null, CFG);
  assert.ok(noPos.action === 'ignored' && noPos.reason === 'no_position');
});

test('mirrorPnl: out − in − fees on what we put in', () => {
  const r = mirrorPnl(0.3, 0.45, 0.02);
  assert.ok(Math.abs(r.pnlSol - (0.45 - 0.3 - 0.006)) < 1e-12);
  assert.ok(r.pnlPct !== null && Math.abs(r.pnlPct - 0.144 / 0.3) < 1e-12);
});

test('mirrorBuySol reads MIRROR_BUY_SOL, falls back to 0.1', () => {
  assert.equal(mirrorBuySol({ MIRROR_BUY_SOL: '0.25' }), 0.25);
  assert.equal(mirrorBuySol({ MIRROR_BUY_SOL: 'abc' }), 0.1);
  assert.equal(mirrorBuySol({}), 0.1);
});

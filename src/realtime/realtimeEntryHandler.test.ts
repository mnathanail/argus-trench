import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideEntry, type EntryWalletInput } from './realtimeEntryHandler.js';
import type { PumpPortalTradeEvent } from './pumpportalEvents.js';

const WALLET = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TOKEN = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';

function activeWallet(overrides: Partial<EntryWalletInput> = {}): EntryWalletInput {
  return {
    address: WALLET,
    active: true,
    winRate: 0.6,
    pnlMultiplier: 0.3,
    tradeCount: 40,
    source: 'smart_money',
    name: null,
    ...overrides,
  };
}

function buyEvent(overrides: Partial<PumpPortalTradeEvent> = {}): PumpPortalTradeEvent {
  return {
    signature: 'sig',
    mint: TOKEN,
    traderPublicKey: WALLET,
    txType: 'buy',
    tokenAmount: 100,
    solAmount: 1,
    vTokensInBondingCurve: 1,
    vSolInBondingCurve: 0.00001, // τιμή ρητά μικρή, ασήμαντη για αυτά τα tests
    marketCapSol: 100,
    pool: 'pump',
    ...overrides,
  };
}

test('enters when everything checks out: buy, active wallet, gated token, room under the cap', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), true, 5);
  assert.equal(decision.type, 'enter');
  if (decision.type === 'enter') assert.equal(decision.entryPrice, 0.00001);
});

test('skips a sell event — only buys open new positions', () => {
  const decision = decideEntry(buyEvent({ txType: 'sell' }), activeWallet(), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the wallet is unknown (null) — defensive, should not normally happen for a subscribed wallet', () => {
  const decision = decideEntry(buyEvent(), null, true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('ΕΥΡΗΜΑ-style guard: skips a buy from a wallet that was deactivated after we subscribed it', () => {
  const decision = decideEntry(buyEvent(), activeWallet({ active: false }), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the token has not (yet) passed the gate', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), false, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the open-trades cap has been reached', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), true, 800);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when no real-time price is available (e.g. already migrated off the bonding curve)', () => {
  const decision = decideEntry(buyEvent({ pool: 'raydium' }), activeWallet(), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('uses the real event price (vSol/vTokens), not any placeholder', () => {
  const decision = decideEntry(
    buyEvent({ vSolInBondingCurve: 53.93797509913754, vTokensInBondingCurve: 596796597.218102 }),
    activeWallet(),
    true,
    5,
  );
  assert.equal(decision.type, 'enter');
  if (decision.type === 'enter') {
    assert.ok(Math.abs(decision.entryPrice - 9.0393e-8) / 9.0393e-8 < 0.01);
  }
});

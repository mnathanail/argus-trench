import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideForTick, type TickDecisionInput } from './realtimeExitHandler.js';
import type { PumpPortalTradeEvent } from './pumpportalEvents.js';

const ENTRY_AT = new Date('2026-09-09T00:00:00Z');
const WALLET = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TOKEN = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';

function trade(overrides: Partial<TickDecisionInput> = {}): TickDecisionInput {
  return {
    simulatedEntryPrice: 1,
    entryAt: ENTRY_AT,
    peakPriceSinceEntry: null,
    trailingActive: false,
    triggerWalletAddress: WALLET,
    ...overrides,
  };
}

function buyEvent(overrides: Partial<PumpPortalTradeEvent> = {}): PumpPortalTradeEvent {
  return {
    signature: 'sig',
    mint: TOKEN,
    traderPublicKey: 'SomeOtherTrader1111111111111111111111111',
    txType: 'buy',
    tokenAmount: 100,
    solAmount: 1,
    vTokensInBondingCurve: 500_000_000,
    vSolInBondingCurve: 50, // τιμή = 1e-7... απλοποιώ πιο κάτω με ρητά νούμερα
    marketCapSol: 100,
    pool: 'pump',
    ...overrides,
  };
}

/** Βοηθητικό: φτιάχνει event με ΣΥΓΚΕΚΡΙΜΕΝΗ τιμή (vSol/vTokens = price ακριβώς). */
function eventAtPrice(price: number, overrides: Partial<PumpPortalTradeEvent> = {}): PumpPortalTradeEvent {
  return buyEvent({ vSolInBondingCurve: price, vTokensInBondingCurve: 1, ...overrides });
}

test('ΕΥΡΗΜΑ #1: a tick arriving after the real 24h boundary is ignored, even if the price would otherwise trigger tp_tier_1', () => {
  const justPastBoundary = new Date(ENTRY_AT.getTime() + 25 * 60 * 60 * 1000); // 25h μετά
  const decision = decideForTick(trade(), eventAtPrice(1.6), justPastBoundary); // +60%, θα ήταν tp_tier_1
  assert.deepEqual(decision, { type: 'ignore' });
});

test('a tick just under the 24h boundary is processed normally (not incorrectly ignored)', () => {
  const justBeforeBoundary = new Date(ENTRY_AT.getTime() + 23 * 60 * 60 * 1000); // 23h μετά
  const decision = decideForTick(trade(), eventAtPrice(1.6), justBeforeBoundary);
  assert.equal(decision.type, 'close');
});

test('ΕΥΡΗΜΑ #1 (variant): a wallet-sell arriving after the 24h boundary is ignored too, not just price ticks', () => {
  const justPastBoundary = new Date(ENTRY_AT.getTime() + 25 * 60 * 60 * 1000);
  const lateSell = eventAtPrice(1.1, { txType: 'sell', traderPublicKey: WALLET });
  const decision = decideForTick(trade(), lateSell, justPastBoundary);
  assert.deepEqual(decision, { type: 'ignore' });
});

test('exit_signal: a sell BY the trigger wallet closes immediately, regardless of price', () => {
  const sellEvent = eventAtPrice(0.5, { txType: 'sell', traderPublicKey: WALLET }); // τιμή θα ήταν ζημιά
  const decision = decideForTick(trade(), sellEvent, ENTRY_AT);
  assert.equal(decision.type, 'close');
  if (decision.type === 'close') {
    assert.equal(decision.exitReason, 'exit_signal');
    assert.equal(decision.exitPrice, 0.5);
  }
});

test('a sell by a DIFFERENT wallet (not the trigger wallet) does not count as exit_signal — falls through to price-tick handling', () => {
  const sellEvent = eventAtPrice(0.5, { txType: 'sell', traderPublicKey: 'SomeoneElseEntirely111111111111111111111' });
  const decision = decideForTick(trade(), sellEvent, ENTRY_AT);
  assert.notEqual(decision.type === 'close' && decision.exitReason, 'exit_signal');
});

test('a buy event (not a sell) from the trigger wallet does not trigger exit_signal', () => {
  const buyByTrigger = eventAtPrice(1.6, { txType: 'buy', traderPublicKey: WALLET });
  const decision = decideForTick(trade(), buyByTrigger, ENTRY_AT);
  assert.equal(decision.type, 'close');
  if (decision.type === 'close') assert.equal(decision.exitReason, 'tp_tier_1');
});

test('a token that migrated off the bonding curve (pool !== "pump") is ignored, not treated as a price of 0', () => {
  const migratedEvent = eventAtPrice(1.6, { pool: 'raydium' });
  const decision = decideForTick(trade(), migratedEvent, ENTRY_AT);
  assert.deepEqual(decision, { type: 'ignore' });
});

test('a tick that raises the peak without triggering any exit returns an update decision', () => {
  const decision = decideForTick(trade({ peakPriceSinceEntry: 1.1 }), eventAtPrice(1.3), ENTRY_AT);
  assert.deepEqual(decision, { type: 'update', newPeakPriceSinceEntry: 1.3, newTrailingActive: false });
});

test('a tick that changes nothing (price below the already-known peak, trailing still inactive) is ignored — no wasted write', () => {
  const decision = decideForTick(trade({ peakPriceSinceEntry: 1.3 }), eventAtPrice(1.2), ENTRY_AT);
  assert.deepEqual(decision, { type: 'ignore' });
});

test('trailing_stop fires correctly through the full decision path (activation on one tick, stop on a later one)', () => {
  const afterActivation = decideForTick(trade(), eventAtPrice(2.0), ENTRY_AT); // +100%, ενεργοποίηση
  assert.equal(afterActivation.type, 'update');
  const peak = afterActivation.type === 'update' ? afterActivation.newPeakPriceSinceEntry : 0;
  const trailingActive = afterActivation.type === 'update' ? afterActivation.newTrailingActive : false;

  const afterDrop = decideForTick(
    trade({ peakPriceSinceEntry: peak, trailingActive }),
    eventAtPrice(1.1), // κάτω από 2.0*(1-0.4)=1.2
    ENTRY_AT,
  );
  assert.equal(afterDrop.type, 'close');
  if (afterDrop.type === 'close') assert.equal(afterDrop.exitReason, 'trailing_stop');
});

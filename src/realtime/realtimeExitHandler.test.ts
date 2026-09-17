import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decideForTick,
  shouldSkipLiveExitCheck,
  isPastLiveTimeout,
  isUnpriceableNonSellEvent,
  type TickDecisionInput,
} from './realtimeExitHandler.js';
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

// shouldSkipLiveExitCheck — πραγματικό incident 2026-09-15: μια αποτυχημένη πραγματική
// πώληση (needs_manual_exit) ή μια ήδη-σε-εξέλιξη απόπειρα (exit_attempt_started_at
// πρόσφατο) ΔΕΝ πρέπει ποτέ να ξαναδοκιμαστεί αυτόματα.

function liveTrade(overrides: Partial<Parameters<typeof shouldSkipLiveExitCheck>[0]> = {}) {
  return {
    needsManualExit: false,
    mode: 'live' as const,
    exitAttemptStartedAt: null,
    ...overrides,
  };
}

test('shouldSkipLiveExitCheck: needsManualExit=true πάντα αγνοείται, ασχέτως mode/χρόνου', () => {
  assert.equal(shouldSkipLiveExitCheck(liveTrade({ needsManualExit: true }), ENTRY_AT), true);
  assert.equal(shouldSkipLiveExitCheck(liveTrade({ needsManualExit: true, mode: 'log_only' }), ENTRY_AT), true);
});

test('shouldSkipLiveExitCheck: paper/log_only trade ΠΟΤΕ δεν αγνοείται λόγω exit_attempt_started_at (δεν εφαρμόζεται εκεί)', () => {
  const staleButPaper = liveTrade({ mode: 'log_only', exitAttemptStartedAt: ENTRY_AT });
  assert.equal(shouldSkipLiveExitCheck(staleButPaper, new Date(ENTRY_AT.getTime() + 1_000)), false);
});

test('shouldSkipLiveExitCheck: live trade με ΠΡΟΣΦΑΤΗ exit_attempt_started_at αγνοείται — άλλη απόπειρα ήδη σε εξέλιξη', () => {
  const attemptStarted = ENTRY_AT;
  const now = new Date(ENTRY_AT.getTime() + 10_000); // 10s μετά — ακόμα «φρέσκο»
  assert.equal(shouldSkipLiveExitCheck(liveTrade({ exitAttemptStartedAt: attemptStarted }), now), true);
});

test('shouldSkipLiveExitCheck: live trade με ΠΑΛΙΑ exit_attempt_started_at ΔΕΝ αγνοείται — πιθανή κολλημένη προσπάθεια, επιτρέπεται νέα', () => {
  const attemptStarted = ENTRY_AT;
  const now = new Date(ENTRY_AT.getTime() + 61_000); // 61s μετά — πλέον «μπαγιάτικο»
  assert.equal(shouldSkipLiveExitCheck(liveTrade({ exitAttemptStartedAt: attemptStarted }), now), false);
});

test('shouldSkipLiveExitCheck: live trade χωρίς καμία προηγούμενη απόπειρα δεν αγνοείται', () => {
  assert.equal(shouldSkipLiveExitCheck(liveTrade(), ENTRY_AT), false);
});

// isPastLiveTimeout / isUnpriceableNonSellEvent — πραγματικό incident 2026-09-17
// (#1193): μετά το fix που απέκλεισε τα live trades από το periodic resolver, ΚΑΝΕΝΑΣ
// μηχανισμός δεν κλείνει πια ένα live trade λόγω timeout ή όταν το token «αποφοιτήσει»
// από το bonding curve — αυτές οι δύο functions είναι το «κάτι» που το καλύπτει.

test('isPastLiveTimeout: false πριν το πραγματικό 24ωρο όριο', () => {
  const justBefore = new Date(ENTRY_AT.getTime() + 23 * 60 * 60 * 1000);
  assert.equal(isPastLiveTimeout(ENTRY_AT, justBefore), false);
});

test('isPastLiveTimeout: true ακριβώς στο και μετά το 24ωρο όριο', () => {
  const justAfter = new Date(ENTRY_AT.getTime() + 25 * 60 * 60 * 1000);
  assert.equal(isPastLiveTimeout(ENTRY_AT, justAfter), true);
});

test('isUnpriceableNonSellEvent: true όταν το token έχει «αποφοιτήσει» (pool !== "pump")', () => {
  const migrated = eventAtPrice(1.5, { pool: 'pump-amm' });
  assert.equal(isUnpriceableNonSellEvent(migrated), true);
});

test('isUnpriceableNonSellEvent: false για κανονικό, ακόμα-στο-bonding-curve event', () => {
  assert.equal(isUnpriceableNonSellEvent(eventAtPrice(1.5)), false);
});

test('isUnpriceableNonSellEvent: false για exit_signal (wallet sell) ΑΚΟΜΑ ΚΙ ΑΝ το token έχει ήδη αποφοιτήσει — δεν χρειάζεται τιμή, ελέγχεται πρώτο στο decideForTick', () => {
  const migratedSell = eventAtPrice(1.5, { pool: 'pump-amm', txType: 'sell', traderPublicKey: WALLET });
  assert.equal(isUnpriceableNonSellEvent(migratedSell), false);
});

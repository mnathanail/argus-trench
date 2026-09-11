import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkTick } from './tickExit.js';

const ENTRY_PRICE = 1;

test('checkTick: price still below tier1 (+50%) — no exit, peak tracked, trailing stays off', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 1.2, // +20%
  });
  assert.equal(result.exit, null);
  assert.equal(result.newPeakPriceSinceEntry, 1.2);
  assert.equal(result.newTrailingActive, false);
});

test('checkTick: price reaches exactly tier1 (+50%) — closes tp_tier_1 at the tier price, not the raw tick price', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 1.3,
    trailingActive: false,
    currentPrice: 1.55, // πέρα από το +50% όριο
  });
  assert.deepEqual(result.exit, { exitReason: 'tp_tier_1', exitPrice: 1.5 });
});

test('checkTick: price jumps directly to +150% in one tick — activates trailing, does NOT report tp_tier_1 (tier2 always wins)', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 2.5, // +150%, περνάει και τα δύο thresholds στο ίδιο tick
  });
  assert.equal(result.exit, null, 'δεν πρέπει να κλείσει — μόλις ενεργοποιήθηκε το trailing');
  assert.equal(result.newTrailingActive, true);
  assert.equal(result.newPeakPriceSinceEntry, 2.5);
});

test('checkTick: once trailing is active (persisted from a previous tick), a 40% drop from peak triggers trailing_stop', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0, // peak από προηγούμενα ticks
    trailingActive: true, // ήδη ενεργό από προηγούμενο tick
    currentPrice: 1.79, // κάτω από 3.0*(1-0.4)=1.8
  });
  assert.equal(result.exit?.exitReason, 'trailing_stop');
  // Ανοχή floating-point: 3.0*(1-0.4) δεν είναι ακριβώς 1.8 σε IEEE 754.
  assert.ok(Math.abs((result.exit?.exitPrice ?? 0) - 1.8) < 1e-9);
});

test('checkTick: trailing active, price still above the stop — stays open, peak does not decrease', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0,
    trailingActive: true,
    currentPrice: 2.5, // πάνω από το stop (1.8), αλλά κάτω από το ήδη-καταγεγραμμένο peak
  });
  assert.equal(result.exit, null);
  assert.equal(result.newPeakPriceSinceEntry, 3.0, 'το peak ΔΕΝ πρέπει ποτέ να μειωθεί');
});

test('checkTick: trailing active, a new higher price raises the peak (and therefore the stop level for future ticks)', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0,
    trailingActive: true,
    currentPrice: 4.0, // νέο peak
  });
  assert.equal(result.exit, null);
  assert.equal(result.newPeakPriceSinceEntry, 4.0);
});

test('checkTick: first-ever tick (peakPriceSinceEntry=null) uses entryPrice as the starting baseline', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.8, // κάτω από το entry
  });
  // peak = max(entryPrice, currentPrice) = max(1, 0.8) = 1, ΟΧΙ 0.8
  assert.equal(result.newPeakPriceSinceEntry, 1);
});

test('checkTick: a sequence of ticks — activation, new peak, then a drop that triggers trailing_stop', () => {
  // tick 1: +100%, ενεργοποίηση
  let state = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 2.0,
  });
  assert.equal(state.exit, null);
  assert.equal(state.newTrailingActive, true);

  // tick 2: ανεβαίνει άλλο σε 3.0 — νέο peak
  state = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: state.newPeakPriceSinceEntry,
    trailingActive: state.newTrailingActive,
    currentPrice: 3.0,
  });
  assert.equal(state.exit, null);
  assert.equal(state.newPeakPriceSinceEntry, 3.0);

  // tick 3: πέφτει στο 1.7 — κάτω από 3.0*(1-0.4)=1.8, πρέπει να κλείσει
  state = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: state.newPeakPriceSinceEntry,
    trailingActive: state.newTrailingActive,
    currentPrice: 1.7,
  });
  assert.equal(state.exit?.exitReason, 'trailing_stop');
  assert.ok(Math.abs((state.exit?.exitPrice ?? 0) - 1.8) < 1e-9);
});

// --- stop_loss: νέο 2026-09-11, πρώτη φορά πραγματικό κεφάλαιο ---------------------

test('checkTick: a 50% drop from entry triggers stop_loss', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.5, // ακριβώς στο όριο
  });
  assert.equal(result.exit?.exitReason, 'stop_loss');
  assert.equal(result.exit?.exitPrice, 0.5);
});

test('checkTick: a drop that stays above the stop-loss threshold does not trigger it', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.51, // λίγο πάνω από το -50% όριο
  });
  assert.notEqual(result.exit?.exitReason, 'stop_loss');
});

test('checkTick: stop_loss is checked from ENTRY, not from peak — even after trailing has activated', () => {
  // Ακραίο σενάριο: μεγάλο pump (ενεργοποίηση trailing), μετά κατάρρευση κάτω από το
  // 50% του ΑΡΧΙΚΟΥ entry — το stop_loss πρέπει να πυροδοτήσει, όχι το trailing_stop
  // (αν και μαθηματικά ένα τόσο μεγάλο crash θα πυροδοτούσε ούτως ή άλλως και τα δύο).
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0,
    trailingActive: true,
    currentPrice: 0.4, // κάτω από το 0.5 του entry
  });
  assert.equal(result.exit?.exitReason, 'stop_loss');
});

test('checkTick: stop_loss takes priority even on the very first tick, before any tier logic runs', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.3, // βαθιά κάτω από όλα τα thresholds
  });
  assert.equal(result.exit?.exitReason, 'stop_loss');
  assert.equal(result.exit?.exitPrice, 0.5); // πάντα στο -50% όριο, όχι στην ωμή τιμή του tick
});

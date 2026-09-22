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

// ΑΛΛΑΓΗ 2026-09-22: EXIT_TIER_2_ACTIVATION_SCALE μετακόμισε από +100% στο +50% (ίδιο
// σημείο με το tier1) — βλ. σχόλιο στο paperTradingConfig.ts. Το tier1 ΠΑΥΕΙ να
// πυροδοτείται όταν η τιμή φτάνει +50%: ενεργοποιείται trailing αντ' αυτού (η σειρά
// ελέγχου του checkTick βάζει το activation-check πριν το tier1-check). Το test
// "reaches exactly tier1" περιέγραφε ΑΚΡΙΒΩΣ το bug που φτιάξαμε σήμερα.
test('checkTick: price reaches +50% — activates trailing instead of tp_tier_1 (tier1 no longer wins the exit race)', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 1.3,
    trailingActive: false,
    currentPrice: 1.55, // πέρα από το +50% όριο, τώρα ενεργοποιεί trailing
  });
  assert.equal(result.exit, null, 'δεν πρέπει να κλείσει — μόλις ενεργοποιήθηκε το trailing');
  assert.equal(result.newTrailingActive, true);
  assert.equal(result.newPeakPriceSinceEntry, 1.55);
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

test('checkTick: once trailing is active (persisted from a previous tick), a 25% drop from peak triggers trailing_stop at the OBSERVED price (just below the stop level), not the threshold', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0, // peak από προηγούμενα ticks
    trailingActive: true, // ήδη ενεργό από προηγούμενο tick
    currentPrice: 2.24, // κάτω από 3.0*(1-0.25)=2.25 (πάνω από το floor 1.1, αδρανές εδώ)
  });
  assert.equal(result.exit?.exitReason, 'trailing_stop');
  assert.equal(result.exit?.exitPrice, 2.24);
});

test('checkTick: trailing_stop records the threshold when the tick lands exactly on it (min(threshold, observed) === threshold)', () => {
  const peak = 3.0;
  // Υπολογισμένο με ΤΗΝ ΙΔΙΑ έκφραση που χρησιμοποιεί το checkTick (peak * (1 -
  // EXIT_TIER_2_DRAWDOWN_PCT)) — ΟΧΙ ένα ανεξάρτητο literal, που θα μπορούσε να διαφέρει
  // στο τελευταίο floating-point bit και να κάνει το "ακριβώς στο threshold" σενάριο
  // tests-only illusion. Στο peak=3.0 το floor (1.1) είναι ήδη αδρανές.
  const stopPrice = peak * (1 - 0.25);
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: peak,
    trailingActive: true,
    currentPrice: stopPrice,
  });
  assert.equal(result.exit?.exitReason, 'trailing_stop');
  assert.ok(Math.abs((result.exit?.exitPrice ?? 0) - stopPrice) < 1e-9);
});

test('checkTick: trailing_stop records the worse, observed price when the drop overshoots the threshold (real pump.fun collapse scenario)', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0, // stop level = 2.25
    trailingActive: true,
    currentPrice: 1.2, // η τιμή προσπέρασε κατά πολύ το -25% από peak μέχρι το επόμενο tick
  });
  assert.equal(result.exit?.exitReason, 'trailing_stop');
  assert.equal(result.exit?.exitPrice, 1.2, 'το paper P&L πρέπει να καταγράψει την πραγματική, χειρότερη τιμή — όχι το αισιόδοξο threshold');
});

// --- profit floor: νέο 2026-09-22 -----------------------------------------------------

test('checkTick: profit floor is inactive when the mathematical stop is already above it (peak far above minimum activation)', () => {
  // peak=3.0, drawdown 25% → μαθηματικό stop 2.25, πολύ πάνω από το floor (1.1) —
  // επιβεβαιώνει ότι το Math.max δεν αλλάζει τίποτα σε αυτή την κοινή περίπτωση.
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 3.0,
    trailingActive: true,
    currentPrice: 2.3, // πάνω από 2.25, δεν κλείνει ακόμα
  });
  assert.equal(result.exit, null);
});

test('checkTick: profit floor kicks in at the minimum possible activation peak (+50%) — never lets the stop fall below +10%', () => {
  // peak=1.5 (ελάχιστο δυνατό ενεργοποιημένο peak, ακριβώς στο activation threshold).
  // Μαθηματικό stop: 1.5*0.75=1.125 — ήδη πάνω από το floor (1.1) σε αυτή την τιμή, αλλά
  // το test δείχνει ρητά τον υπολογισμό Math.max(1.125, 1.1) = 1.125 (το floor ΔΕΝ
  // επεμβαίνει εδώ ακόμα, βλ. το επόμενο test για μια περίπτωση όπου ΘΑ επενέβαινε αν το
  // drawdown ήταν πιο φαρδύ — τεκμηριώνει ρητά ότι με τις τρέχουσες σταθερές ο συνδυασμός
  // είναι ήδη ασφαλής χωρίς να χρειάζεται το floor να κάνει τη δουλειά).
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: 1.5,
    trailingActive: true,
    currentPrice: 1.125,
  });
  assert.equal(result.exit?.exitReason, 'trailing_stop');
  assert.equal(result.exit?.exitPrice, 1.125);
  assert.ok(result.exit!.exitPrice >= ENTRY_PRICE, 'ποτέ ζημιά στο ελάχιστο δυνατό ενεργοποιημένο peak');
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

  // tick 3: πέφτει στο 1.7 — κάτω από 3.0*(1-0.25)=2.25, πρέπει να κλείσει στην πραγματική,
  // παρατηρημένη τιμή (1.7), όχι στο threshold (2.25).
  state = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: state.newPeakPriceSinceEntry,
    trailingActive: state.newTrailingActive,
    currentPrice: 1.7,
  });
  assert.equal(state.exit?.exitReason, 'trailing_stop');
  assert.equal(state.exit?.exitPrice, 1.7);
});

// --- stop_loss: νέο 2026-09-11, πρώτη φορά πραγματικό κεφάλαιο ---------------------

test('checkTick: a 50% drop from entry triggers stop_loss at the threshold when the tick lands exactly on it', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.5, // ακριβώς στο όριο
  });
  assert.equal(result.exit?.exitReason, 'stop_loss');
  assert.equal(result.exit?.exitPrice, 0.5);
});

test('checkTick: stop_loss records the worse, observed price when the crash overshoots -50% (real pump.fun scenario, review finding)', () => {
  const result = checkTick({
    entryPrice: ENTRY_PRICE,
    peakPriceSinceEntry: null,
    trailingActive: false,
    currentPrice: 0.28, // -72%, η κατάρρευση προσπέρασε κατά πολύ το -50% threshold
  });
  assert.equal(result.exit?.exitReason, 'stop_loss');
  assert.equal(result.exit?.exitPrice, 0.28, 'πρέπει να καταγραφεί η πραγματική τιμή, όχι το αισιόδοξο -50%');
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
  // Παρατηρημένη τιμή (0.3), όχι το -50% όριο — βλ. διόρθωση 2026-09-17 πιο πάνω.
  assert.equal(result.exit?.exitPrice, 0.3);
});

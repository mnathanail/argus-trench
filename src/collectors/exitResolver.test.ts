import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveExit } from './exitResolver.js';
import type { Candle } from '../gmgn/kline.js';

const ENTRY_AT = new Date('2026-08-28T00:00:00Z');
const ENTRY_PRICE = 1;

function candle(secondsAfterEntry: number, high: number, low: number, close?: number): Candle {
  return {
    timestamp: ENTRY_AT.getTime() + secondsAfterEntry * 1000,
    open: high,
    high,
    low,
    close: close ?? high,
  };
}

// ΑΛΛΑΓΗ 2026-09-22: EXIT_TIER_2_ACTIVATION_SCALE μετακόμισε από +100% στο +50% (ίδιο
// σημείο με το tier1) — βλ. σχόλιο στο paperTradingConfig.ts. Με τη σειρά ελέγχου του
// resolveExit (tier2-activation πριν το tier1-check), το tier1 ΠΑΥΕΙ να πυροδοτείται σε
// ΚΑΘΕ candle που φτάνει +50%: το trailing παίρνει τον έλεγχο αντ' αυτού. Το παλιό test
// "closes at tp_tier_1 when high reaches +50%" περιέγραφε ΑΚΡΙΒΩΣ το bug που φτιάξαμε
// σήμερα (tier1 έκλεβε την έξοδο πριν προλάβει ποτέ να ενεργοποιηθεί trailing) — το
// αντικαθιστούμε με ένα test που επιβεβαιώνει τη ΝΕΑ, σκόπιμη συμπεριφορά.
test('resolveExit: reaching +50% now activates trailing instead of tp_tier_1 (tier1 no longer wins the exit race)', () => {
  const candles: Candle[] = [
    candle(60, 1.2, 1.1),
    candle(120, 1.5, 1.4), // +50% — ενεργοποιεί trailing τώρα, ΟΧΙ tp_tier_1
    candle(180, 3.0, 2.9), // νέο peak 3.0 → stop = 3.0*0.75 = 2.25
    candle(240, 2.2, 2.1), // low 2.1 breaches stop (2.25) → trailing_stop
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'trailing_stop');
  assert.equal(result?.exitPrice, 2.1);
});

test('resolveExit: activates trailing at +50%, then closes at -25% from the post-activation peak, at the OBSERVED candle.low (not the threshold)', () => {
  const candles: Candle[] = [
    candle(60, 1.5, 1.4), // activates trailing at peak=1.5 (+50%)
    candle(120, 2.0, 1.9), // new peak 2.0 → stop now at 2.0*0.75 = 1.5
    candle(180, 1.9, 1.3), // low 1.3 breaches stop (1.5) → trailing_stop
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'trailing_stop');
  // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #2, candle-based μισό): πριν καταγράφαμε πάντα το
  // threshold — τώρα Math.min(threshold, candle.low) = min(1.5, 1.3) = 1.3, η
  // πραγματική, χειρότερη τιμή που "είδε" το candle.
  assert.equal(result?.exitPrice, 1.3);
});

// ΝΕΟ 2026-09-22 — PROFIT_FLOOR_SCALE: το peak είναι ελάχιστο δυνατό (ακριβώς +50%),
// άρα το μαθηματικό stop (peak*0.75=1.125) είναι ήδη πάνω από το floor (entry*1.1=1.1) —
// επιβεβαιώνει ότι με τις τρέχουσες τιμές το floor είναι αβλαβές/αδρανές, το κανονικό
// trailing δουλεύει όπως υπολογίστηκε.
test('resolveExit: profit floor is inactive at the current constants — minimum activated trailing stop is +12.5%, above the +10% floor', () => {
  const candles: Candle[] = [
    candle(60, 1.5, 1.5), // ακριβώς +50%, ελάχιστο δυνατό peak για ενεργοποίηση
    candle(120, 1.126, 1.126), // ακόμα πάνω από το μαθηματικό stop (1.125) — ΔΕΝ κλείνει
    candle(180, 1.125, 1.125), // ακριβώς στο μαθηματικό stop → trailing_stop (το floor 1.1 δεν
    // προλαβαίνει καν να παίξει ρόλο — ο μαθηματικός υπολογισμός είναι ήδη πιο αυστηρός)
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'trailing_stop');
  assert.equal(result?.exitPrice, 1.125);
});

test('resolveExit: trailing_stop records the threshold when candle.low lands exactly on it (min(threshold, observed) === threshold)', () => {
  const candles: Candle[] = [
    candle(60, 2.0, 1.9),
    candle(120, 2.5, 2.4), // peak 2.5 → stop at 1.5
    candle(180, 2.4, 1.5), // low lands exactly on the stop level
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'trailing_stop');
  assert.ok(Math.abs((result?.exitPrice ?? 0) - 1.5) < 1e-9);
});

// --- stop_loss: νέο 2026-09-17 (review εύρημα #4) — πριν αυτό το candle-based engine
// δεν είχε ΚΑΘΟΛΟΥ stop_loss, μόνο το tick-based checkTick το είχε -----------------------

test('resolveExit: a candle.low crossing -50% from entry triggers stop_loss, at the observed low (real pump.fun crash scenario)', () => {
  const candles: Candle[] = [
    candle(60, 1.05, 0.95), // κοντά στο entry, καμία επίδραση
    candle(120, 0.6, 0.28), // κατάρρευση: low 0.28 προσπερνάει κατά πολύ το -50% (0.5)
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'stop_loss');
  assert.equal(result?.exitPrice, 0.28, 'πρέπει να καταγραφεί η πραγματική τιμή, όχι το αισιόδοξο -50%');
  assert.equal(result?.exitAt.getTime(), candles[1]?.timestamp ?? NaN);
});

test('resolveExit: stop_loss records the threshold when candle.low lands exactly on it', () => {
  const candles: Candle[] = [candle(60, 1.05, 0.5)];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'stop_loss');
  assert.equal(result?.exitPrice, 0.5);
});

test('resolveExit: stop_loss takes priority over tier hits in the same candle (checked first, per priority order)', () => {
  // Ακραίο σενάριο: το ίδιο candle έχει high που θα πυροδοτούσε tp_tier_1 ΚΑΙ low που
  // πυροδοτεί stop_loss (μεγάλο εύρος μέσα στο ίδιο 1-λεπτο candle) — stop_loss πρέπει να
  // κερδίσει, ίδια προτεραιότητα με το checkTick.
  const candles: Candle[] = [candle(60, 1.6, 0.4)];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'stop_loss');
});

test('resolveExit: stop_loss is checked from ENTRY, not from peak — even after trailing has activated', () => {
  const candles: Candle[] = [
    candle(60, 3.0, 2.9), // ενεργοποιεί trailing, peak=3.0
    candle(120, 2.0, 0.4), // κατάρρευση κάτω από το 0.5 του ΑΡΧΙΚΟΥ entry
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'stop_loss');
});

test('resolveExit: a candle.low that stays above the stop-loss threshold does not trigger it', () => {
  const candles: Candle[] = [candle(60, 1.1, 0.51)]; // λίγο πάνω από το -50% όριο
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.notEqual(result?.exitReason, 'stop_loss');
});

test('resolveExit: wallet exit_signal takes priority over a tier hit in the same candle', () => {
  const sellAt = new Date(candle(120, 0, 0).timestamp);
  const candles: Candle[] = [candle(60, 1.2, 1.1), candle(120, 1.6, 1.5, 1.55)]; // also crosses tier 1 here
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: sellAt,
    now: ENTRY_AT,
  });
  assert.equal(result?.exitReason, 'exit_signal');
  assert.equal(result?.exitPrice, 1.55);
});

test('resolveExit: times out after 24h with nothing else triggered', () => {
  const candles: Candle[] = [candle(3600, 1.1, 1.0, 1.05)];
  const now = new Date(ENTRY_AT.getTime() + 25 * 60 * 60 * 1000);
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now });
  assert.equal(result?.exitReason, 'timeout');
  assert.equal(result?.exitPrice, 1.05);
});

test('resolveExit: returns null (still open) when nothing triggered and no timeout yet', () => {
  const candles: Candle[] = [candle(60, 1.1, 1.0)];
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: null,
    now: new Date(ENTRY_AT.getTime() + 60_000),
  });
  assert.equal(result, null);
});

test('resolveExit: ignores candles before entry (e.g. a kline window that starts slightly early)', () => {
  const candles: Candle[] = [
    { timestamp: ENTRY_AT.getTime() - 3_600_000, open: 5, high: 5, low: 5, close: 5 }, // pre-entry spike, must be ignored
    candle(60, 1.1, 1.0, 1.05),
  ];
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: null,
    now: new Date(ENTRY_AT.getTime() + 60_000),
  });
  assert.equal(result, null); // δεν πρέπει να "χτυπήσει" tier 1 λόγω του pre-entry candle
});

test('resolveExit: empty candles (dead/no-liquidity token) times out as no_market_data, not a flat-price timeout', () => {
  const now = new Date(ENTRY_AT.getTime() + 25 * 60 * 60 * 1000);
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles: [], walletSellAt: null, now });
  assert.equal(result?.exitReason, 'no_market_data');
  assert.equal(result?.exitPrice, ENTRY_PRICE);
});

test('resolveExit: empty candles but not yet 24h — still open, not a premature no_market_data', () => {
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles: [],
    walletSellAt: null,
    now: new Date(ENTRY_AT.getTime() + 60_000),
  });
  assert.equal(result, null);
});

test('resolveExit: empty candles but wallet already sold — exit_signal wins, not no_market_data', () => {
  const sellAt = new Date(ENTRY_AT.getTime() + 60_000);
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles: [],
    walletSellAt: sellAt,
    now: new Date(ENTRY_AT.getTime() + 120_000),
  });
  assert.equal(result?.exitReason, 'exit_signal');
});

// --- late-check correctness: never read past the real 24h boundary ---------------------
// Real incident 2026-09-07: trades checked ~73h after entry (backlog) incorrectly could
// "see" price action or wallet-sells from well beyond their real timeout point — as if a
// live system would have kept holding a position it would have already force-closed.

test('resolveExit: a tier1-hit candle AFTER the 24h boundary is ignored — late check reports timeout, not tp_tier_1', () => {
  const candles: Candle[] = [
    candle(3600, 1.05, 1.0, 1.02), // 1h in, μέσα στο παράθυρο: μέτρια κίνηση, καμία tier
    candle(90 * 3600, 2.0, 1.9, 1.95), // 90h in, ΕΞΩ από το παράθυρο: θα ήταν tp_tier_1
  ];
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: null,
    now: new Date(ENTRY_AT.getTime() + 90 * 3600 * 1000), // ελέγχθηκε αργά, 90h μετά
  });
  assert.equal(result?.exitReason, 'timeout');
  assert.equal(result?.exitPrice, 1.02); // από το candle ΜΕΣΑ στο παράθυρο, ΟΧΙ το 1.95
});

test('resolveExit: a wallet-sell AFTER the 24h boundary is ignored — late check reports timeout, not exit_signal', () => {
  const candles: Candle[] = [candle(3600, 1.05, 1.0, 1.03)];
  const sellAt = new Date(ENTRY_AT.getTime() + 48 * 3600 * 1000); // πούλησε 48h μετά
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: sellAt,
    now: new Date(ENTRY_AT.getTime() + 73 * 3600 * 1000),
  });
  assert.equal(result?.exitReason, 'timeout');
});

test('resolveExit: real incident shape — checked ~73h late, a huge pump AFTER the boundary must not leak into the reported pnl', () => {
  const candles: Candle[] = [
    candle(1800, 0.95, 0.9, 0.92), // 30 λεπτά μετά: ελαφρώς κάτω
    candle(85_000, 0.6, 0.55, 0.58), // ~23.6h μετά, ΑΚΟΜΑ μέσα στο παράθυρο: πιο κάτω
    candle(200_000, 5.0, 4.5, 4.8), // ~55.5h μετά, ΠΟΛΥ έξω: τεράστιο pump, πρέπει να αγνοηθεί
  ];
  const result = resolveExit({
    entryPrice: ENTRY_PRICE,
    entryAt: ENTRY_AT,
    candles,
    walletSellAt: null,
    now: new Date(ENTRY_AT.getTime() + 73 * 3600 * 1000),
  });
  assert.equal(result?.exitReason, 'timeout');
  assert.equal(result?.exitPrice, 0.58);
  assert.ok((result?.exitPrice ?? 0) < ENTRY_PRICE, 'δεν πρέπει να δείχνει κέρδος από το μεταγενέστερο pump');
});

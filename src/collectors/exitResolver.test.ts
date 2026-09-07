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

test('resolveExit: closes at tp_tier_1 when high reaches +50%, ignoring later candles', () => {
  const candles: Candle[] = [
    candle(60, 1.2, 1.1),
    candle(120, 1.5, 1.4), // hits tier 1 exactly here
    candle(180, 3.0, 2.9), // would also hit tier 2 — must not be reached
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'tp_tier_1');
  assert.equal(result?.exitPrice, 1.5);
  assert.equal(result?.exitAt.getTime(), candles[1]?.timestamp ?? NaN);
});

test('resolveExit: activates trailing at +100%, then closes at -40% from the post-activation peak', () => {
  const candles: Candle[] = [
    candle(60, 2.0, 1.9), // activates trailing at peak=2.0 (skips tier 1 by jumping straight to +100%)
    candle(120, 2.5, 2.4), // new peak 2.5 → stop now at 1.5
    candle(180, 2.4, 1.4), // low 1.4 breaches stop (1.5) → trailing_stop
  ];
  const result = resolveExit({ entryPrice: ENTRY_PRICE, entryAt: ENTRY_AT, candles, walletSellAt: null, now: ENTRY_AT });
  assert.equal(result?.exitReason, 'trailing_stop');
  assert.equal(result?.exitPrice, 1.5);
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

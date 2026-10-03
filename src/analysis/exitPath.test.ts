import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Candle } from '../gmgn/kline.js';
import { MINUTE_MS, pathStats, simPnlSol, simulateExit, windowCandles } from './exitPath.js';

const T0 = 1_800_000_000_000;
/** candles από [low, high, close] ανά λεπτό, open = close του προηγούμενου (1 για το πρώτο). */
function series(bars: [number, number, number][], startMin = 1): Candle[] {
  let prev = 1;
  return bars.map(([low, high, close], i) => {
    const c = { timestamp: T0 + (startMin + i) * MINUTE_MS, open: prev, high, low, close };
    prev = close;
    return c;
  });
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('windowCandles: κρατάει μόνο [entry, entry+horizon) και ταξινομεί', () => {
  const cs = [...series([[1, 1, 1]], 0), ...series([[1, 1, 1], [1, 1, 1]], 1)].reverse();
  const w = windowCandles([{ ...cs[0]!, timestamp: T0 - MINUTE_MS }, ...cs], T0, 2 * MINUTE_MS);
  assert.deepEqual(w.map((c) => (c.timestamp - T0) / MINUTE_MS), [0, 1]);
});

test('pathStats: βύθιση πριν το +50%, λεπτά ως το +50%, checkpoints', () => {
  const cs = series([[0.9, 1.0, 0.95], [0.7, 0.9, 0.8], [0.8, 1.6, 1.5], [0.5, 1.5, 0.6]]);
  const s = pathStats(cs, 1, T0);
  assert.ok(close(s.minBeforeTrail!, 0.7), 'η βύθιση ΜΕΤΑ το +50% (0.5) δεν μετράει');
  assert.equal(s.minutesToTrail, 3);
  assert.ok(close(s.maxMultiple!, 1.6));
  assert.equal(s.at[15], null, 'τα δεδομένα δεν φτάνουν ως τα 15′');
});

test('simulateExit trail: stop −30% πιάνει πριν το −50%', () => {
  const cs = series([[0.8, 1.0, 0.9], [0.65, 0.9, 0.7], [0.4, 0.7, 0.45]]);
  const r30 = simulateExit(cs, 1, T0, { stopPct: 0.3, timeLimitMin: null, mode: 'trail' });
  assert.equal(r30.reason, 'stop');
  assert.ok(close(r30.multiple, 0.7));
  const r50 = simulateExit(cs, 1, T0, { stopPct: 0.5, timeLimitMin: null, mode: 'trail' });
  assert.equal(r50.reason, 'stop');
  assert.ok(close(r50.multiple, 0.5));
});

test('simulateExit: gap κάτω από το stop → έξοδος στο open', () => {
  const cs = series([[0.95, 1.0, 0.95], [0.2, 0.3, 0.25]]);
  cs[1]!.open = 0.3;
  const r = simulateExit(cs, 1, T0, { stopPct: 0.3, timeLimitMin: null, mode: 'trail' });
  assert.ok(close(r.multiple, 0.3));
});

test('simulateExit: συντηρητικά — low και high στο ίδιο candle → μετράει πρώτα το stop', () => {
  const cs = series([[0.6, 2.0, 1.8]]);
  const r = simulateExit(cs, 1, T0, { stopPct: 0.3, timeLimitMin: null, mode: 'trail' });
  assert.equal(r.reason, 'stop');
});

test('simulateExit trail: ενεργοποίηση +50%, έξοδος −25% από το peak', () => {
  const cs = series([[0.95, 1.6, 1.55], [1.5, 3.0, 2.9], [2.0, 2.9, 2.1]]);
  const r = simulateExit(cs, 1, T0, { stopPct: 0.5, timeLimitMin: null, mode: 'trail' });
  assert.equal(r.reason, 'trail');
  assert.ok(close(r.multiple, 2.25), String(r.multiple)); // 3.0 × 0.75
});

test('simulateExit: χρονικό όριο κλείνει μόνο θέσεις που δεν έπιασαν trailing', () => {
  const flat = series(Array.from({ length: 40 }, () => [0.9, 1.1, 0.95] as [number, number, number]));
  const r = simulateExit(flat, 1, T0, { stopPct: 0.5, timeLimitMin: 30, mode: 'trail' });
  assert.equal(r.reason, 'time_limit');
  assert.equal(r.minutes, 30);
  const winner = series([[0.95, 1.6, 1.55], ...Array.from({ length: 40 }, () => [1.5, 1.7, 1.6] as [number, number, number])]);
  const w = simulateExit(winner, 1, T0, { stopPct: 0.5, timeLimitMin: 30, mode: 'trail' });
  assert.equal(w.reason, 'horizon', 'το trailing συνεχίζει μετά το όριο');
});

test('simulateExit half_tp: μισό στο +50%, μισό με trailing', () => {
  const cs = series([[0.95, 1.6, 1.55], [1.5, 3.0, 2.9], [2.0, 2.9, 2.1]]);
  const r = simulateExit(cs, 1, T0, { stopPct: 0.5, timeLimitMin: null, mode: 'half_tp' });
  assert.ok(close(r.multiple, 0.5 * 1.5 + 0.5 * 2.25), String(r.multiple));
});

test('simulateExit ladder: 25% στο 2×, 25% στο 3×, υπόλοιπο στην τιμή εισόδου', () => {
  const cs = series([[0.95, 2.1, 2.0], [1.9, 3.2, 3.0], [0.8, 3.0, 0.9]]);
  const r = simulateExit(cs, 1, T0, { stopPct: 0.5, timeLimitMin: null, mode: 'ladder' });
  assert.equal(r.reason, 'breakeven');
  assert.ok(close(r.multiple, 0.25 * 2 + 0.25 * 3 + 0.5 * 1), String(r.multiple));
});

test('simulateExit: χωρίς candles → no_data, πολλαπλασιαστής 1', () => {
  assert.deepEqual(simulateExit([], 1, T0, { stopPct: 0.3, timeLimitMin: 30, mode: 'trail' }), { multiple: 1, reason: 'no_data', minutes: 0 });
});

test('simPnlSol: 0.1 SOL, ×2, 4.5% fees', () => {
  assert.ok(close(simPnlSol(2, 0.1, 0.045), 0.1 - 0.0045));
});

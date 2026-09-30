import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyResult, splitEpisodes, walletResult, type WalletTrade } from './copyReplay.js';

let n = 0;
const t = (o: Partial<WalletTrade>): WalletTrade => ({ mint: 'A', txType: 'buy', sol: 1, tokens: 100, balanceAfter: 100, blockTime: ++n, signature: 's' + n, ...o });
const OPTS = { buySol: 0.1, slippagePct: 0, feesPct: 0 };

test('επεισόδια: κλείνει στο μηδέν, νέα αγορά = νέο, ελλιπές (ήδη κρατούσε) αγνοείται', () => {
  const trades = [
    t({ mint: 'B', txType: 'sell', tokens: 50, balanceAfter: 50 }), // κρατούσε από πριν
    t({ mint: 'B', txType: 'buy', tokens: 10, balanceAfter: 60 }), // ακόμα ελλιπές
    t({ mint: 'B', txType: 'sell', tokens: 60, balanceAfter: 0 }),
    t({ mint: 'A', txType: 'buy', sol: 1, tokens: 100, balanceAfter: 100 }),
    t({ mint: 'A', txType: 'sell', sol: 2, tokens: 100, balanceAfter: 0 }),
    t({ mint: 'A', txType: 'buy', sol: 1, tokens: 100, balanceAfter: 100 }),
  ];
  const { episodes, incomplete } = splitEpisodes(trades);
  assert.equal(incomplete, 1);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0]!.closed, true);
  assert.equal(episodes[1]!.closed, false);
});

test('all vs first: ο μέσος όρος προς τα κάτω πονάει μόνο το all', () => {
  const { episodes } = splitEpisodes([
    t({ sol: 1, tokens: 100, balanceAfter: 100 }), // τιμή 0.01
    t({ sol: 1, tokens: 200, balanceAfter: 300 }), // 0.005 (αγοράζει στην πτώση)
    t({ txType: 'sell', sol: 0.6, tokens: 300, balanceAfter: 0 }), // 0.002
  ]);
  const ep = episodes[0]!;
  const w = walletResult(ep);
  assert.ok(Math.abs(w.pnlSol - (0.6 - 2)) < 1e-9);
  const all = copyResult(ep, 'all', OPTS);
  const first = copyResult(ep, 'first', OPTS);
  assert.equal(all.buys, 2);
  assert.equal(first.buys, 1);
  // first: 10 tokens → 0.02 SOL (−80%)· all: 10+20 tokens → 0.06 (−70%, αλλά 0.2 SOL μέσα)
  assert.ok(Math.abs(first.pnlSol - (0.02 - 0.1)) < 1e-9, String(first.pnlSol));
  assert.ok(Math.abs(all.pnlSol - (0.06 - 0.2)) < 1e-9, String(all.pnlSol));
});

test('μερική πώληση στο ίδιο % και ανοιχτό υπόλοιπο στην τελευταία τιμή', () => {
  const { episodes } = splitEpisodes([
    t({ sol: 1, tokens: 100, balanceAfter: 100 }),
    t({ txType: 'sell', sol: 1, tokens: 50, balanceAfter: 50 }), // 50%, τιμή 0.02
  ]);
  const r = copyResult(episodes[0]!, 'first', OPTS);
  // 10 tokens, πουλάμε 5 × 0.02 = 0.1, μένουν 5 × 0.02 = 0.1
  assert.ok(Math.abs(r.solOut - 0.1) < 1e-9);
  assert.ok(Math.abs(r.openValueSol - 0.1) < 1e-9);
  assert.equal(episodes[0]!.closed, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEntrySlippage, computePnl } from './pnl.js';
import { PAPER_ASSUMED_FEES_PCT, PAPER_ASSUMED_SLIPPAGE_PCT } from './paperTradingConfig.js';

test('computePnl: a tp_tier_1-style +50% gain — pnlSol is now derived from pnlNetPct (fee-adjusted), not gross pnlPct', () => {
  const result = computePnl(1, 1.5, 10, 0.01);
  assert.equal(result.pnlPct, 0.5);
  const expectedNetPct = 0.5 - PAPER_ASSUMED_FEES_PCT;
  assert.ok(Math.abs(result.pnlNetPct - expectedNetPct) < 1e-12);
  // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #5): πριν το pnlSol χρησιμοποιούσε το ΜΙΚΤΟ pnlPct
  // (10*0.01*0.5 = 0.05) — τώρα πρέπει να αντανακλά τα fees.
  assert.ok(Math.abs(result.pnlSol - 10 * 0.01 * expectedNetPct) < 1e-12);
  assert.ok(result.pnlSol < 10 * 0.01 * 0.5, 'το fee-adjusted pnlSol πρέπει να είναι αυστηρά μικρότερο από το μικτό');
});

test('computePnl: a loss (exit below entry) gives a negative pnlPct and an even more negative pnlSol once fees are included', () => {
  const result = computePnl(1, 0.7, 10, 0.01);
  assert.ok(Math.abs(result.pnlPct - -0.3) < 1e-12);
  assert.ok(result.pnlSol < 0);
  assert.ok(result.pnlSol < 10 * 0.01 * -0.3, 'οι ζημιές πρέπει να επιδεινώνονται από τα fees, όχι να τα αγνοούν');
});

test('computePnl: null bankroll/sizePct treated as zero — pnlSol is 0, pnlPct is unaffected', () => {
  const result = computePnl(1, 2, null, null);
  assert.equal(result.pnlPct, 1);
  assert.equal(result.pnlSol, 0);
});

// --- applyEntrySlippage: review εύρημα #3 ------------------------------------------------

test('applyEntrySlippage: marks the entry price up by the assumed slippage — a paper buy fills worse than the raw observed price', () => {
  const result = applyEntrySlippage(1, PAPER_ASSUMED_SLIPPAGE_PCT);
  assert.ok(Math.abs(result - (1 * (1 + PAPER_ASSUMED_SLIPPAGE_PCT))) < 1e-12);
  assert.ok(result > 1, 'η προσομοιωμένη τιμή εισόδου πρέπει να είναι χειρότερη (υψηλότερη) από την ωμή παρατηρημένη τιμή');
});

test('applyEntrySlippage: zero slippage is a no-op', () => {
  assert.equal(applyEntrySlippage(1.2345, 0), 1.2345);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fallbackOutcomeFor } from './liveEntryExecution.js';

/**
 * Πραγματικό εύρημα 2026-09-17 (ο χρήστης παρατήρησε trades που δεν εμφανίζονταν στο
 * GMGN — δηλαδή δεν ήταν ποτέ πραγματικά live): το `attemptLiveEntry` πέταγε εντελώς την
 * τιμή του `decideTradeMode()` (που ήδη σωστά υπολόγιζε 'paper' σε ανεπαρκές κεφάλαιο) —
 * ο μόνος έλεγχος ήταν `!== 'live'`, και ΚΑΘΕ τέτοια περίπτωση κατέληγε στο ίδιο,
 * hardcoded 'log_only'. Αποτέλεσμα: mode='paper' δεν χρησιμοποιούνταν ΠΟΤΕ στην πράξη.
 *
 * Αυτά τα tests κλειδώνουν τη διόρθωση: ανεπαρκές κεφάλαιο ΠΡΕΠΕΙ να δίνει 'paper' — όλες
 * οι άλλες αποτυχίες (risk gate, χαμένη κράτηση σε race, αποτυχημένο swap) ΠΡΕΠΕΙ να
 * παραμείνουν 'log_only', αφού εκεί το κεφάλαιο πράγματι υπήρχε.
 */

test('fallbackOutcomeFor: insufficient_capital falls back to "paper" — the exact bug the user reported', () => {
  const outcome = fallbackOutcomeFor('insufficient_capital');
  assert.equal(outcome.mode, 'paper');
});

test('fallbackOutcomeFor: risk_gate_blocked (kill-switch/daily cap) stays "log_only" — capital existed, gate blocked it', () => {
  const outcome = fallbackOutcomeFor('risk_gate_blocked');
  assert.equal(outcome.mode, 'log_only');
});

test('fallbackOutcomeFor: reservation_lost (near-simultaneous signal race) stays "log_only"', () => {
  const outcome = fallbackOutcomeFor('reservation_lost');
  assert.equal(outcome.mode, 'log_only');
});

test('fallbackOutcomeFor: swap_failed stays "log_only" — capital existed, the swap itself failed', () => {
  const outcome = fallbackOutcomeFor('swap_failed');
  assert.equal(outcome.mode, 'log_only');
});

test('fallbackOutcomeFor: every non-live outcome has no real entry data (actualEntryAmountSol/entryPrice/native order all null/false)', () => {
  for (const reason of ['insufficient_capital', 'risk_gate_blocked', 'reservation_lost', 'swap_failed'] as const) {
    const outcome = fallbackOutcomeFor(reason);
    assert.equal(outcome.actualEntryAmountSol, null);
    assert.equal(outcome.entryPrice, null);
    assert.equal(outcome.liveStrategyOrderId, null);
    assert.equal(outcome.nativeOrderVerified, false);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fallbackOutcomeFor, liveEntryAmountSol, type LiveFallbackReason } from './liveEntryExecution.js';

/**
 * Ιστορικό: 2026-09-17 το `attemptLiveEntry` πέταγε την τιμή του `decideTradeMode()` και
 * ΚΑΘΕ μη-live περίπτωση κατέληγε 'log_only' — τότε διορθώθηκε ώστε το ανεπαρκές κεφάλαιο
 * να δίνει 'paper'. 2026-09-27 (ρητή απόφαση χρήστη): ΚΑΘΕ αποτυχία live δίνει πλέον
 * 'paper' — "paper trades ΜΟΝΟ όταν για οποιονδήποτε λόγο δεν μπορεί να γίνει live".
 */

const ALL_REASONS: readonly LiveFallbackReason[] = [
  'graduated_paper_only',
  'wallet_unavailable',
  'insufficient_capital',
  'risk_gate_blocked',
  'reservation_lost',
  'swap_failed',
];

test('fallbackOutcomeFor: EVERY non-live reason falls back to "paper" — never "log_only"', () => {
  for (const reason of ALL_REASONS) {
    assert.equal(fallbackOutcomeFor(reason).mode, 'paper', `${reason} πρέπει να δίνει paper`);
  }
});

test('fallbackOutcomeFor: kill-switch (risk_gate_blocked) specifically gives "paper" — the case the user asked for', () => {
  assert.equal(fallbackOutcomeFor('risk_gate_blocked').mode, 'paper');
  assert.equal(fallbackOutcomeFor('risk_gate_blocked', true).mode, 'paper');
});

test('fallbackOutcomeFor: every non-live outcome has no real entry data (actualEntryAmountSol/entryPrice/native order all null/false)', () => {
  for (const reason of ALL_REASONS) {
    const outcome = fallbackOutcomeFor(reason);
    assert.equal(outcome.actualEntryAmountSol, null);
    assert.equal(outcome.entryPrice, null);
    assert.equal(outcome.liveStrategyOrderId, null);
    assert.equal(outcome.nativeOrderVerified, false);
  }
});

// --- killSwitchJustTriggered: νέο 2026-09-18, πραγματικό εύρημα -------------------------
// Ο χρήστης έμαθε ότι το kill-switch είχε ξαναχτυπήσει μόνο ώρες αργότερα, από ένα
// μπαγιάτικο daily digest — καμία proactive ειδοποίηση δεν έφευγε τη στιγμή που συνέβη.

test('fallbackOutcomeFor: killSwitchJustTriggered defaults to false when omitted', () => {
  assert.equal(fallbackOutcomeFor('risk_gate_blocked').killSwitchJustTriggered, false);
});

test('fallbackOutcomeFor: risk_gate_blocked with justHalted=true surfaces killSwitchJustTriggered — this is what triggers the proactive alert', () => {
  const outcome = fallbackOutcomeFor('risk_gate_blocked', true);
  assert.equal(outcome.killSwitchJustTriggered, true);
});

test('fallbackOutcomeFor: killSwitchJustTriggered=true is ignored for every reason OTHER than risk_gate_blocked — only the kill-switch path can set it', () => {
  for (const reason of ALL_REASONS.filter((r) => r !== 'risk_gate_blocked')) {
    const outcome = fallbackOutcomeFor(reason, true);
    assert.equal(outcome.killSwitchJustTriggered, false, `${reason} δεν πρέπει ποτέ να πυροδοτεί το kill-switch alert`);
  }
});

test('fallbackOutcomeFor: the shared paper outcome is never mutated by the killSwitch flag', () => {
  fallbackOutcomeFor('risk_gate_blocked', true);
  assert.equal(fallbackOutcomeFor('swap_failed').killSwitchJustTriggered, false);
});

test('fallbackOutcomeFor: graduated_paper_only (LIVE_ON_GRADUATED_TOKENS=false) gives paper, never flags the kill-switch', () => {
  const outcome = fallbackOutcomeFor('graduated_paper_only', true);
  assert.equal(outcome.mode, 'paper');
  assert.equal(outcome.killSwitchJustTriggered, false);
});

test('liveEntryAmountSol: διαφορά υπολοίπου αν είναι λογική, αλλιώς GMGN report, αλλιώς το μέγεθος θέσης', () => {
  assert.equal(liveEntryAmountSol(0.052, 0.05, 0.001, 0.05), 0.052);
  assert.ok(Math.abs(liveEntryAmountSol(0, 0.05, 0.001, 0.05) - 0.051) < 1e-12, 'μπαγιάτικο υπόλοιπο → report');
  assert.equal(liveEntryAmountSol(null, 0.05, null, 0.05), 0.05, 'δεν διαβάστηκε → report');
  assert.equal(liveEntryAmountSol(-0.3, null, null, 0.05), 0.05, 'άσχετη κίνηση wallet → μέγεθος θέσης');
  assert.equal(liveEntryAmountSol(0.4, 0.2, 0, 0.05), 0.05, 'όλα εκτός λογικού εύρους → μέγεθος θέσης');
});

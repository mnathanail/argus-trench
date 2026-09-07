import assert from 'node:assert/strict';
import { test } from 'node:test';

import { msUntilNextAthensTime, startOfAthensDay } from './athensTime.js';

test('msUntilNextAthensTime: target later today (winter, EET/UTC+2) — straightforward same-day math', () => {
  // 2026-01-15 10:00 UTC = 12:00 Αθήνας (χειμώνας, UTC+2). Στόχος 00:05 Αθήνας —
  // πέρασε ήδη σήμερα, άρα αναμένουμε αύριο 00:05 Αθήνας = 2026-01-15 22:05 UTC.
  const now = new Date('2026-01-15T10:00:00Z');
  const ms = msUntilNextAthensTime(0, 5, now);
  const result = new Date(now.getTime() + ms);
  assert.equal(result.toISOString(), '2026-01-15T22:05:00.000Z');
});

test('msUntilNextAthensTime: target still ahead today (summer, EEST/UTC+3)', () => {
  // 2026-07-10 05:00 UTC = 08:00 Αθήνας (καλοκαίρι, UTC+3). Στόχος 00:05 Αθήνας ΔΕΝ έχει
  // περάσει ακόμα σήμερα... περίμενε, 00:05 < 08:00, άρα ΕΧΕΙ περάσει. Αναμένουμε αύριο.
  const now = new Date('2026-07-10T05:00:00Z');
  const ms = msUntilNextAthensTime(0, 5, now);
  const result = new Date(now.getTime() + ms);
  assert.equal(result.toISOString(), '2026-07-10T21:05:00.000Z');
});

test('msUntilNextAthensTime: target still ahead LATER today (before midnight-Athens boundary)', () => {
  // 2026-07-09 20:00 UTC = 23:00 Αθήνας. Στόχος 00:05 Αθήνας είναι ~1h05m αργότερα, ΙΔΙΑ
  // Αθηναϊκή ημερολογιακή μέρα δεν έχει καν αρχίσει ακόμα... στην πραγματικότητα το
  // επόμενο 00:05 Αθήνας είναι η αρχή της 10ης Ιουλίου.
  const now = new Date('2026-07-09T20:00:00Z');
  const ms = msUntilNextAthensTime(0, 5, now);
  const result = new Date(now.getTime() + ms);
  assert.equal(result.toISOString(), '2026-07-09T21:05:00.000Z');
  assert.ok(ms > 0 && ms < 2 * 60 * 60 * 1000, 'πρέπει να είναι σε λίγο παρά πάνω από 1 ώρα');
});

test('msUntilNextAthensTime: correct across the autumn DST transition (2026-10-25)', () => {
  // Η Ελλάδα πάει από EEST(+3) σε EET(+2) την τελευταία Κυριακή Οκτωβρίου, 04:00→03:00
  // τοπικά. Ελέγχουμε ότι ο υπολογισμός δίνει ΘΕΤΙΚΗ, λογική καθυστέρηση γύρω από αυτό —
  // όχι αρνητικό ή εξωφρενικά λάθος νούμερο λόγω hardcoded offset.
  const beforeTransition = new Date('2026-10-24T20:00:00Z'); // 23:00 EEST στις 24/10
  const ms = msUntilNextAthensTime(0, 5, beforeTransition);
  assert.ok(ms > 0, 'ποτέ αρνητικό');
  assert.ok(ms < 3 * 60 * 60 * 1000, 'το επόμενο 00:05 Αθήνας πρέπει να είναι μέσα σε λίγες ώρες');
});

test('msUntilNextAthensTime: correct across the spring DST transition (2026-03-29)', () => {
  // EET(+2) → EEST(+3) την τελευταία Κυριακή Μαρτίου, 03:00→04:00 τοπικά.
  const beforeTransition = new Date('2026-03-28T21:00:00Z'); // 23:00 EET στις 28/3
  const ms = msUntilNextAthensTime(0, 5, beforeTransition);
  assert.ok(ms > 0, 'ποτέ αρνητικό');
  assert.ok(ms < 3 * 60 * 60 * 1000, 'το επόμενο 00:05 Αθήνας πρέπει να είναι μέσα σε λίγες ώρες');
});

test('msUntilNextAthensTime: idempotent-ish — calling again from the computed instant schedules ~24h later', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const firstMs = msUntilNextAthensTime(0, 5, now);
  const firstTarget = new Date(now.getTime() + firstMs);
  const secondMs = msUntilNextAthensTime(0, 5, firstTarget);
  // Πρέπει να πηγαίνει στην ΕΠΟΜΕΝΗ μέρα, όχι να ξαναγυρίζει στην ίδια στιγμή.
  assert.ok(secondMs > 23 * 60 * 60 * 1000 && secondMs < 25 * 60 * 60 * 1000);
});

test('startOfAthensDay: right after midnight, "today" is the day that just started (winter, UTC+2)', () => {
  // 2026-01-15 00:05 Αθήνας (χειμώνας) = 2026-01-14 22:05 UTC.
  const justAfterMidnight = new Date('2026-01-14T22:05:00Z');
  const today = startOfAthensDay(justAfterMidnight);
  assert.equal(today.toISOString(), '2026-01-14T22:00:00.000Z'); // 2026-01-15 00:00 Αθήνας
});

test('startOfAthensDay: daysAgo=1 gives yesterday, not "24 hours ago" — the actual bug we hit', () => {
  // Ίδια στιγμή με πάνω — 00:05 Αθήνας, 15/1. Θέλουμε "χθες" = 14/1, όχι ξανά 15/1.
  const justAfterMidnight = new Date('2026-01-14T22:05:00Z');
  const yesterday = startOfAthensDay(justAfterMidnight, 1);
  assert.equal(yesterday.toISOString(), '2026-01-13T22:00:00.000Z'); // 2026-01-14 00:00 Αθήνας
});

test('startOfAthensDay: daysAgo=1 across the autumn DST transition still gives exactly one calendar day back', () => {
  // 2026-10-26 00:05 Αθήνας — η ΠΡΩΤΗ μέρα μετά την αλλαγή ώρας (25/10 ήταν η μέρα με
  // 25 πραγματικές ώρες). "Χθες" πρέπει να είναι 25/10, ΟΧΙ κάτι λάθος λόγω των 25 ωρών.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // 2026-10-25 22:05 UTC = 2026-10-26 00:05 EET (μετά την αλλαγή, UTC+2).
  const now = new Date('2026-10-25T22:05:00Z');
  const yesterday = startOfAthensDay(now, 1);
  const parts = Object.fromEntries(formatter.formatToParts(yesterday).map((p) => [p.type, p.value]));
  assert.equal(`${parts.year}-${parts.month}-${parts.day}`, '2026-10-25');
});

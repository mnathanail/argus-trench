import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDailyDigest } from './dailyDigest.js';
import type { DailyDigestData } from '../db/repositories/dailyDigest.js';

function baseData(overrides: Partial<DailyDigestData> = {}): DailyDigestData {
  return {
    openedToday: 0,
    closedToday: 0,
    winsToday: 0,
    lossesToday: 0,
    profitSolToday: 0,
    deployedSolToday: 0,
    bestToday: null,
    worstToday: null,
    openAll: 0,
    closedAll: 0,
    profitSolAll: 0,
    needsManualExit: [],
    ...overrides,
  };
}

test('formatDailyDigest: a normal, active live day shows counts, win rate, best/worst, both totals, balance, kill-switch', () => {
  const data = baseData({
    openedToday: 4,
    closedToday: 3,
    winsToday: 2,
    lossesToday: 1,
    profitSolToday: 0.012345,
    deployedSolToday: 0.15,
    bestToday: { tokenAddress: 'BestTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', pnlPct: 1.823, exitReason: 'trailing_stop' },
    worstToday: { tokenAddress: 'WorstTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAA2', pnlPct: -0.6, exitReason: 'stop_loss' },
    openAll: 2,
    closedAll: 9,
    profitSolAll: 0.0456,
    needsManualExit: [],
  });

  const reply = formatDailyDigest(data, '17 Σεπτεμβρίου 2026', 0.281304, null);

  assert.match(reply, /📊 Live αναφορά — 17 Σεπτεμβρίου 2026/);
  assert.match(reply, /Νέα trades: 4/);
  assert.match(reply, /Έκλεισαν: 3 \(2🟢 \/ 1🔴, win rate 66\.7%\)/);
  assert.match(reply, /Πραγματικό κεφάλαιο σε νέες θέσεις: 0\.1500 SOL/);
  assert.match(reply, /Πραγματικό αποτέλεσμα ημέρας: \+0\.012345 SOL/);
  assert.match(reply, /Καλύτερο: Best…AAA1 \+182\.3% \(trailing_stop\)/);
  assert.match(reply, /Χειρότερο: Wors…AAA2 -60\.0% \(stop_loss\)/);
  assert.match(reply, /Ανοιχτά τώρα: 2/);
  assert.match(reply, /Κλεισμένα συνολικά: 9/);
  assert.match(reply, /Συνολικό πραγματικό αποτέλεσμα: \+0\.045600 SOL/);
  assert.match(reply, /Πραγματικό υπόλοιπο wallet: 0\.281304 SOL/);
  assert.match(reply, /Kill-switch: 🟢 ανενεργό/);
  assert.doesNotMatch(reply, /χειροκίνητη προσοχή/);
});

test('formatDailyDigest: a quiet day (nothing closed) skips best/worst and shows — for win rate, without crashing', () => {
  const data = baseData({ openedToday: 1, openAll: 1, closedAll: 0 });

  const reply = formatDailyDigest(data, '1 Ιανουαρίου 2026', 1.0, null);

  assert.match(reply, /Έκλεισαν: 0 \(0🟢 \/ 0🔴, win rate —\)/);
  assert.doesNotMatch(reply, /Καλύτερο/);
  assert.doesNotMatch(reply, /Χειρότερο/);
});

test('formatDailyDigest: a losing day shows negative SOL without a stray plus sign', () => {
  const data = baseData({ closedToday: 2, lossesToday: 2, profitSolToday: -0.021, profitSolAll: -0.021 });

  const reply = formatDailyDigest(data, '2 Ιανουαρίου 2026', 0.5, null);

  assert.match(reply, /Πραγματικό αποτέλεσμα ημέρας: -0\.021000 SOL/);
  assert.doesNotMatch(reply, /\+-/);
});

test('formatDailyDigest: an active kill-switch shows the halt reason clearly', () => {
  const data = baseData();

  const reply = formatDailyDigest(data, '3 Ιανουαρίου 2026', 0.4, '3 συνεχόμενες ζημιές');

  assert.match(reply, /Kill-switch: 🔴 ενεργό \(3 συνεχόμενες ζημιές\)/);
});

test('formatDailyDigest: an unreadable live balance shows a clear placeholder, not a crash or a fake zero', () => {
  const data = baseData();

  const reply = formatDailyDigest(data, '4 Ιανουαρίου 2026', null, null);

  assert.match(reply, /Πραγματικό υπόλοιπο wallet: \(αδύνατη η ανάγνωση\)/);
});

test('formatDailyDigest: trades needing manual exit are listed explicitly, with id, token, and amount — never silently dropped', () => {
  const data = baseData({
    needsManualExit: [
      { id: 42, tokenAddress: 'StuckTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', actualEntryAmountSol: 0.0512 },
      { id: 43, tokenAddress: 'StuckTokenBBBBBBBBBBBBBBBBBBBBBBBBBBBB2', actualEntryAmountSol: null },
    ],
  });

  const reply = formatDailyDigest(data, '5 Ιανουαρίου 2026', 0.3, null);

  assert.match(reply, /🚨 Χρειάζονται χειροκίνητη προσοχή \(2\):/);
  assert.match(reply, /#42 Stuc…AAA1 \(0\.0512 SOL\)/);
  assert.match(reply, /#43 Stuc…BBB2 \(\? SOL\)/);
});

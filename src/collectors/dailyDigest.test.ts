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
    profitPctToday: 0,
    deployedSolToday: 0,
    bestToday: null,
    worstToday: null,
    openAll: 0,
    closedAll: 0,
    profitSolAll: 0,
    profitPctAll: 0,
    walletsActive: 0,
    walletsAutoDeactivated: 0,
    ...overrides,
  };
}

test('formatDailyDigest: a normal, active day shows counts, win rate, best/worst, and both totals', () => {
  const data = baseData({
    openedToday: 23,
    closedToday: 15,
    winsToday: 9,
    lossesToday: 6,
    profitSolToday: 0.8234,
    profitPctToday: 0.823,
    deployedSolToday: 2.3,
    bestToday: { tokenAddress: 'BestTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', pnlPct: 1.823, exitReason: 'trailing_stop' },
    worstToday: { tokenAddress: 'WorstTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAA2', pnlPct: -0.712, exitReason: 'timeout' },
    openAll: 58,
    closedAll: 391,
    profitSolAll: 2.34,
    profitPctAll: 2.345,
    walletsActive: 68,
    walletsAutoDeactivated: 28,
  });

  const reply = formatDailyDigest(data, '4 Σεπτεμβρίου 2026');

  assert.match(reply, /📊 Ημερήσια αναφορά — 4 Σεπτεμβρίου 2026/);
  assert.match(reply, /Νέα trades: 23/);
  assert.match(reply, /Έκλεισαν: 15 \(9🟢 \/ 6🔴, win rate 60\.0%\)/);
  assert.match(reply, /Κεφάλαιο σε νέες θέσεις: 2\.3000 SOL/);
  assert.match(reply, /Αποτέλεσμα ημέρας: \+0\.8234 SOL \(\+82\.3%\)/);
  assert.match(reply, /Καλύτερο: Best…AAA1 \+182\.3% \(trailing_stop\)/);
  assert.match(reply, /Χειρότερο: Wors…AAA2 -71\.2% \(timeout\)/);
  assert.match(reply, /Ανοιχτά τώρα: 58/);
  assert.match(reply, /Κλεισμένα συνολικά: 391/);
  assert.match(reply, /Συνολικό αποτέλεσμα: \+2\.3400 SOL \(\+234\.5%\)/);
  assert.match(reply, /Wallets: 68 ενεργά, 28 αυτόματα απενεργοποιημένα/);
});

test('formatDailyDigest: a quiet day (nothing closed) skips best/worst and shows — for win rate, without crashing', () => {
  const data = baseData({ openedToday: 3, openAll: 10, closedAll: 5 });

  const reply = formatDailyDigest(data, '1 Ιανουαρίου 2026');

  assert.match(reply, /Έκλεισαν: 0 \(0🟢 \/ 0🔴, win rate —\)/);
  assert.doesNotMatch(reply, /Καλύτερο/);
  assert.doesNotMatch(reply, /Χειρότερο/);
});

test('formatDailyDigest: a losing day shows negative SOL and percentage without a stray plus sign', () => {
  const data = baseData({ closedToday: 4, lossesToday: 4, profitSolToday: -1.5, profitPctToday: -1.5 });

  const reply = formatDailyDigest(data, '2 Ιανουαρίου 2026');

  assert.match(reply, /Αποτέλεσμα ημέρας: -1\.5000 SOL \(-150\.0%\)/);
  assert.doesNotMatch(reply, /\+-/);
});

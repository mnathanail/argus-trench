import { getDailyDigestData, type DailyDigestData } from '../db/repositories/dailyDigest.js';
import { formatPercent, short } from '../telegram/commands.js';
import { startOfAthensDay } from '../util/athensTime.js';

/**
 * Καθαρή function, χωρίς DB — παίρνει τα ήδη-υπολογισμένα νούμερα, φτιάχνει το μήνυμα.
 * Ξεχωριστό από το `runDailyDigestCycle` ώστε να τεσταρίζεται χωρίς βάση.
 */
export function formatDailyDigest(data: DailyDigestData, today: string): string {
  const winRateToday =
    data.winsToday + data.lossesToday === 0
      ? '—'
      : formatPercent(data.winsToday / (data.winsToday + data.lossesToday));

  const bestLine =
    data.bestToday === null
      ? null
      : `• Καλύτερο: ${short(data.bestToday.tokenAddress)} ${formatPercent(data.bestToday.pnlPct, true)} (${data.bestToday.exitReason ?? '—'})`;
  const worstLine =
    data.worstToday === null
      ? null
      : `• Χειρότερο: ${short(data.worstToday.tokenAddress)} ${formatPercent(data.worstToday.pnlPct, true)} (${data.worstToday.exitReason ?? '—'})`;

  const solSign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;

  const lines = [
    `📊 Ημερήσια αναφορά — ${today}`,
    '',
    'Χθες:',
    `• Νέα trades: ${data.openedToday}`,
    `• Έκλεισαν: ${data.closedToday} (${data.winsToday}🟢 / ${data.lossesToday}🔴, win rate ${winRateToday})`,
    `• Κεφάλαιο σε νέες θέσεις: ${data.deployedSolToday.toFixed(4)} SOL`,
    `• Αποτέλεσμα ημέρας: ${solSign(data.profitSolToday)} (${formatPercent(data.profitPctToday, true)})`,
    ...(bestLine !== null ? [bestLine] : []),
    ...(worstLine !== null ? [worstLine] : []),
    '',
    'Συνολικά (all-time):',
    `• Ανοιχτά τώρα: ${data.openAll}`,
    `• Κλεισμένα συνολικά: ${data.closedAll}`,
    `• Συνολικό αποτέλεσμα: ${solSign(data.profitSolAll)} (${formatPercent(data.profitPctAll, true)})`,
    '',
    `Wallets: ${data.walletsActive} ενεργά, ${data.walletsAutoDeactivated} αυτόματα απενεργοποιημένα`,
  ];

  return lines.join('\n');
}

/** Η ημερομηνία μιας δεδομένης στιγμής, ΤΟΠΙΚΗ ώρα Αθήνας — για τον τίτλο της αναφοράς.
 * Ονομαστικά "date label", όχι "today" — καλείται με το `yesterdayStart`, αφού η
 * αναφορά αφορά ΧΘΕΣ (βλ. runDailyDigestCycle). */
function athensDateLabel(instant: Date): string {
  return new Intl.DateTimeFormat('el-GR', {
    timeZone: 'Europe/Athens',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(instant);
}

/**
 * Τρέχει στις 00:05 Αθήνας (βλ. main.ts) — δηλαδή λίγο ΜΕΤΑ τα μεσάνυχτα. Η αναφορά
 * πρέπει να αφορά τη μέρα που ΜΟΛΙΣ ΤΕΛΕΙΩΣΕ (χθες), όχι τη μέρα που μόλις ξεκίνησε
 * (σήμερα, 5 λεπτά παλιά) — πραγματικό bug, διορθώθηκε 2026-09-05: το πρώτο μήνυμα
 * έδειξε σχεδόν άδεια δεδομένα επειδή μετρούσε "σήμερα" αντί για "χθες".
 */
export async function runDailyDigestCycle(): Promise<string> {
  const now = new Date();
  const yesterdayStart = startOfAthensDay(now, 1);
  const todayStart = startOfAthensDay(now, 0);
  const data = await getDailyDigestData(yesterdayStart, todayStart);
  return formatDailyDigest(data, athensDateLabel(yesterdayStart));
}

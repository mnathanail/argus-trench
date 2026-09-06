import { getDailyDigestData, type DailyDigestData } from '../db/repositories/dailyDigest.js';
import { formatPercent, short } from '../telegram/commands.js';

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
    'Σήμερα:',
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

/** Η σημερινή ημερομηνία, ΤΟΠΙΚΗ ώρα Αθήνας — για τον τίτλο της αναφοράς. */
function athensDateLabel(now: Date): string {
  return new Intl.DateTimeFormat('el-GR', {
    timeZone: 'Europe/Athens',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

export async function runDailyDigestCycle(): Promise<string> {
  const data = await getDailyDigestData();
  return formatDailyDigest(data, athensDateLabel(new Date()));
}

import { getDailyDigestData, type DailyDigestData } from '../db/repositories/dailyDigest.js';
import { getLiveHaltState } from '../db/repositories/liveTradingState.js';
import { getLiveSolBalance } from '../gmgn/portfolio.js';
import { formatPercent, short } from '../telegram/commands.js';
import { startOfAthensDay } from '../util/athensTime.js';

/**
 * Καθαρή function, χωρίς DB/network — παίρνει τα ήδη-υπολογισμένα νούμερα, φτιάχνει το
 * μήνυμα. Ξεχωριστό από το `runDailyDigestCycle` ώστε να τεσταρίζεται χωρίς βάση.
 *
 * ΜΟΝΟ live δεδομένα — ρητή απόφαση χρήστη 2026-09-16, βλ. σχόλιο στο
 * db/repositories/dailyDigest.ts. `liveBalanceSol`/`haltReason` περνάνε ξεχωριστά (όχι
 * μέσα στο DailyDigestData) γιατί προέρχονται από εξωτερικές πηγές (πραγματικό GMGN
 * balance query, live_trading_state) — `null` για το balance σημαίνει "δεν μπορέσαμε να
 * το διαβάσουμε αυτή τη φορά", ΟΧΙ μηδενικό υπόλοιπο.
 */
export function formatDailyDigest(
  data: DailyDigestData,
  today: string,
  liveBalanceSol: number | null,
  haltReason: string | null,
): string {
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

  const solSign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(6)} SOL`;

  const manualExitLines =
    data.needsManualExit.length === 0
      ? []
      : [
          '',
          `🚨 Χρειάζονται χειροκίνητη προσοχή (${data.needsManualExit.length}):`,
          ...data.needsManualExit.map(
            (t) => `• #${t.id} ${short(t.tokenAddress)} (${t.actualEntryAmountSol?.toFixed(4) ?? '?'} SOL) — δες /trades`,
          ),
        ];

  const lines = [
    `📊 Live αναφορά — ${today}`,
    '',
    'Χθες:',
    `• Νέα trades: ${data.openedToday}`,
    `• Έκλεισαν: ${data.closedToday} (${data.winsToday}🟢 / ${data.lossesToday}🔴, win rate ${winRateToday})`,
    `• Πραγματικό κεφάλαιο σε νέες θέσεις: ${data.deployedSolToday.toFixed(4)} SOL`,
    `• Πραγματικό αποτέλεσμα ημέρας: ${solSign(data.profitSolToday)}`,
    ...(bestLine !== null ? [bestLine] : []),
    ...(worstLine !== null ? [worstLine] : []),
    '',
    'Συνολικά (live, all-time):',
    `• Ανοιχτά τώρα: ${data.openAll}`,
    `• Κλεισμένα συνολικά: ${data.closedAll}`,
    `• Συνολικό πραγματικό αποτέλεσμα: ${solSign(data.profitSolAll)}`,
    '',
    'Κατάσταση τώρα:',
    `• Πραγματικό υπόλοιπο wallet: ${liveBalanceSol !== null ? `${liveBalanceSol.toFixed(6)} SOL` : '(αδύνατη η ανάγνωση)'}`,
    `• Kill-switch: ${haltReason !== null ? `🔴 ενεργό (${haltReason})` : '🟢 ανενεργό'}`,
    ...manualExitLines,
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
 * (σήμερα, 5 λεπτά παλιά) — πραγματικό bug, διορθώθηκε 2026-09-05.
 *
 * ΜΟΝΟ live δεδομένα από 2026-09-16 (ρητή απόφαση χρήστη) — τα paper/log_only trades
 * συνεχίζουν να καταγράφονται κανονικά, απλά δεν εμφανίζονται πια εδώ.
 *
 * Το balance query (πραγματικό, εξωτερικό GMGN call) ΔΕΝ πρέπει ποτέ να ρίξει ολόκληρη
 * την αναφορά αν αποτύχει (π.χ. στιγμιαίο rate limit) — απλά δείχνει "(αδύνατη η
 * ανάγνωση)" αντί για το νούμερο, η υπόλοιπη αναφορά συνεχίζει κανονικά.
 */
export async function runDailyDigestCycle(): Promise<string> {
  const now = new Date();
  const yesterdayStart = startOfAthensDay(now, 1);
  const todayStart = startOfAthensDay(now, 0);
  const data = await getDailyDigestData(yesterdayStart, todayStart);
  const halt = await getLiveHaltState();

  let liveBalanceSol: number | null = null;
  try {
    liveBalanceSol = await getLiveSolBalance();
  } catch {
    liveBalanceSol = null;
  }

  return formatDailyDigest(data, athensDateLabel(yesterdayStart), liveBalanceSol, halt.haltedReason);
}

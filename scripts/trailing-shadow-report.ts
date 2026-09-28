import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { TRAILING_CONFIRM_MS, TRAILING_GRACE_MS } from '../src/decision/paperTradingConfig.js';

// Χρήση: railway run npm run trailing-shadow-report
//
// 2026-09-28: σύγκριση της ΠΡΑΓΜΑΤΙΚΗΣ εξόδου με το "4B" trailing (grace + επιβεβαίωση)
// που τρέχει σε shadow mode (migration 0017, src/realtime/shadowExit.ts). Trade-προς-trade,
// πάνω στα ΙΔΙΑ tokens και ticks. Read-only.
//
// Τιμές: και οι δύο πλευρές συγκρίνονται σε τιμή εξόδου έναντι simulated_entry_price
// (ίδια βάση, ίδια fees για όλα) — pct = exit/entry − 1. Το SOL αποτέλεσμα υπολογίζεται με
// το πραγματικό ποσό εισόδου (actual_entry_amount_sol για live, simulated για paper).

/** Κάτω από τόσες συγκρίσεις όπου τα δύο διαφέρουν, δεν βγάζουμε συμπέρασμα. */
const MIN_DIVERGED_FOR_VERDICT = 10;
const SAME_EPSILON = 0.001; // 0.1 ποσοστιαία μονάδα

interface Row {
  id: string;
  token_address: string;
  mode: string;
  exit_reason: string | null;
  shadow_exit_reason: string;
  simulated_entry_price: string;
  simulated_exit_price: string;
  shadow_exit_price: string;
  entry_amount_sol: string | null;
}

const pool = getPool();

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const sol = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`;

try {
  const { rows } = await pool.query<Row>(
    `SELECT pt.id, pt.token_address, pt.mode, pt.exit_reason, pt.shadow_exit_reason,
            pt.simulated_entry_price, pt.simulated_exit_price, pt.shadow_exit_price,
            COALESCE(pt.actual_entry_amount_sol, pt.simulated_entry_amount_sol) AS entry_amount_sol
       FROM paper_trades pt
      WHERE pt.shadow_tracked
        AND pt.status = 'closed'
        AND pt.shadow_exit_at IS NOT NULL
        AND pt.simulated_entry_price > 0
        AND pt.simulated_exit_price IS NOT NULL
        AND pt.shadow_exit_price IS NOT NULL
      ORDER BY pt.entry_at`,
  );
  const { rows: pending } = await pool.query<{ real_open: string; shadow_open: string; unresolved: string }>(
    `SELECT count(*) FILTER (WHERE status = 'open')                                            AS real_open,
            count(*) FILTER (WHERE status <> 'open' AND shadow_exit_at IS NULL)                 AS shadow_open,
            count(*) FILTER (WHERE shadow_exit_at IS NOT NULL AND shadow_exit_price IS NULL)    AS unresolved
       FROM paper_trades
      WHERE shadow_tracked`,
  );

  const trades = rows.map((r) => {
    const entry = Number(r.simulated_entry_price);
    const realPct = Number(r.simulated_exit_price) / entry - 1;
    const shadowPct = Number(r.shadow_exit_price) / entry - 1;
    const amount = r.entry_amount_sol === null ? 0 : Number(r.entry_amount_sol);
    return { ...r, realPct, shadowPct, diffPct: shadowPct - realPct, diffSol: (shadowPct - realPct) * amount, amount };
  });

  const diverged = trades.filter((t) => Math.abs(t.diffPct) > SAME_EPSILON);
  const better = diverged.filter((t) => t.diffPct > 0);
  const worse = diverged.filter((t) => t.diffPct < 0);
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
  };

  console.log(`\n=== Trailing shadow report — 4B: grace ${TRAILING_GRACE_MS / 1000}″, επιβεβαίωση ${TRAILING_CONFIRM_MS / 1000}″ ===`);
  console.log(`  συγκρίσιμα trades (και τα δύο κλειστά):  ${trades.length}`);
  console.log(`  ακόμα σε εξέλιξη: πραγματικό ανοιχτό ${pending[0]?.real_open ?? 0}, shadow ανοιχτό ${pending[0]?.shadow_open ?? 0}, shadow χωρίς τιμή (timeout) ${pending[0]?.unresolved ?? 0}`);
  console.log(`  ίδια έξοδος:  ${trades.length - diverged.length}`);
  console.log(`  διαφορετική:  ${diverged.length}  (4B καλύτερο ${better.length}, χειρότερο ${worse.length})`);

  console.log('\n  Μέσο αποτέλεσμα (όλα τα συγκρίσιμα):');
  console.log(`    σημερινή λογική: ${pct(avg(trades.map((t) => t.realPct)))}`);
  console.log(`    4B:              ${pct(avg(trades.map((t) => t.shadowPct)))}`);
  console.log(`  Διαφορά 4B − σημερινό, σε SOL (με τα πραγματικά ποσά εισόδου): ${sol(sum(trades.map((t) => t.diffSol)))}`);
  console.log(`  Διάμεση διαφορά όπου διαφέρουν: ${pct(median(diverged.map((t) => t.diffPct)))}`);

  const byReason = new Map<string, typeof trades>();
  for (const t of diverged) {
    const key = `${t.exit_reason ?? '?'} → ${t.shadow_exit_reason}`;
    byReason.set(key, [...(byReason.get(key) ?? []), t]);
  }
  if (byReason.size > 0) {
    console.log('\n  Πού διαφέρουν (πραγματικός λόγος → λόγος 4B):');
    for (const [key, ts] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${key.padEnd(34)} n=${String(ts.length).padEnd(4)} μέση διαφορά ${pct(avg(ts.map((t) => t.diffPct))).padEnd(8)} σύνολο ${sol(sum(ts.map((t) => t.diffSol)))}`);
    }
  }

  const biggest = [...diverged].sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct)).slice(0, 10);
  if (biggest.length > 0) {
    console.log('\n  Μεγαλύτερες διαφορές:');
    for (const t of biggest) {
      console.log(`    #${t.id} ${t.token_address.slice(0, 8)} ${t.mode.padEnd(5)} σημερινό ${pct(t.realPct).padEnd(9)} (${t.exit_reason}) | 4B ${pct(t.shadowPct).padEnd(9)} (${t.shadow_exit_reason})`);
    }
  }

  console.log('\n=== Ετυμηγορία ===');
  const totalDiffSol = sum(trades.map((t) => t.diffSol));
  if (diverged.length < MIN_DIVERGED_FOR_VERDICT) {
    console.log(`  ⏳ Ανεπαρκές δείγμα: μόνο ${diverged.length} trades όπου το 4B βγήκε διαφορετικά (χρειάζονται ≥ ${MIN_DIVERGED_FOR_VERDICT}).`);
  } else if (totalDiffSol > 0 && median(diverged.map((t) => t.diffPct)) > 0) {
    console.log('  ✅ Το 4B βγάζει περισσότερα: θετική συνολική διαφορά ΚΑΙ θετική διάμεση διαφορά.');
    console.log('     → εφαρμογή του 4B στις πραγματικές εξόδους.');
  } else if (totalDiffSol > 0) {
    console.log('  ⚠️ Συνολικά θετικό, αλλά η διάμεση διαφορά δεν είναι — το κέρδος έρχεται από λίγα outliers.');
    console.log('     Κοίτα τις μεγαλύτερες διαφορές πριν αποφασίσεις.');
  } else {
    console.log('  ❌ Το 4B δεν βγάζει περισσότερα με αυτές τις ρυθμίσεις — μένουμε στη σημερινή λογική.');
  }
} finally {
  await closePool();
}

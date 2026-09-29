import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run no-exit-signal-report
//
// 2026-09-29 (ρητό αίτημα χρήστη): «αν μπαίνουμε νωρίς και αφήνουμε το trailing να
// δουλέψει, βγάζουμε περισσότερα;» Συγκρίνει την ΠΡΑΓΜΑΤΙΚΗ έξοδο κάθε trade με το shadow
// «χωρίς exit_signal» (migration 0020, realtime/shadowExit.ts): ίδια trailing/stop-loss/
// timeout, αλλά ΔΕΝ πουλάμε όταν πουλάει το wallet που αντιγράφουμε. Ίδια ticks, ίδια
// tokens. Χωριστά για πρώιμες (on_demand) και κανονικές (discovery) αγορές. Read-only.
//
// Σημ.: η πραγματική τιμή εξόδου των live trades περιλαμβάνει slippage πώλησης, η shadow
// όχι (τιμή tick) — μικρή μεροληψία υπέρ του shadow.

const MIN_DIVERGED_FOR_VERDICT = 15;
const SAME_EPSILON = 0.001;

interface Row {
  id: string;
  token_address: string;
  mode: string;
  gate: string;
  exit_reason: string | null;
  nosig_exit_reason: string;
  simulated_entry_price: string;
  simulated_exit_price: string;
  nosig_exit_price: string;
  entry_amount_sol: string | null;
}

const pool = getPool();
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const sol = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]): number | null => (xs.length === 0 ? null : sum(xs) / xs.length);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

try {
  const { rows } = await pool.query<Row>(
    `SELECT pt.id, pt.token_address, pt.mode,
            COALESCE(d.trigger_wallet_snapshot_json->>'gate_source', 'discovery') AS gate,
            pt.exit_reason, pt.nosig_exit_reason,
            pt.simulated_entry_price, pt.simulated_exit_price, pt.nosig_exit_price,
            COALESCE(pt.actual_entry_amount_sol, pt.simulated_entry_amount_sol) AS entry_amount_sol
       FROM paper_trades pt
       JOIN decision_log d ON d.id = pt.decision_log_id
      WHERE pt.nosig_tracked
        AND pt.status = 'closed'
        AND pt.nosig_exit_at IS NOT NULL
        AND pt.simulated_entry_price > 0
        AND pt.simulated_exit_price IS NOT NULL
        AND pt.nosig_exit_price IS NOT NULL
      ORDER BY pt.entry_at`,
  );
  const { rows: pending } = await pool.query<{ real_open: string; nosig_open: string; unresolved: string }>(
    `SELECT count(*) FILTER (WHERE status = 'open')                                        AS real_open,
            count(*) FILTER (WHERE status <> 'open' AND nosig_exit_at IS NULL)             AS nosig_open,
            count(*) FILTER (WHERE nosig_exit_at IS NOT NULL AND nosig_exit_price IS NULL) AS unresolved
       FROM paper_trades
      WHERE nosig_tracked`,
  );

  const trades = rows.map((r) => {
    const entry = Number(r.simulated_entry_price);
    const realPct = Number(r.simulated_exit_price) / entry - 1;
    const nosigPct = Number(r.nosig_exit_price) / entry - 1;
    const amount = r.entry_amount_sol === null ? 0 : Number(r.entry_amount_sol);
    return { ...r, realPct, nosigPct, diffPct: nosigPct - realPct, diffSol: (nosigPct - realPct) * amount, amount };
  });

  const p = pending[0];
  console.log('\n=== Χωρίς exit_signal — shadow report ===');
  console.log(`  συγκρίσιμα trades: ${trades.length}   (σε εξέλιξη: πραγματικό ανοιχτό ${p?.real_open ?? 0}, shadow ανοιχτό ${p?.nosig_open ?? 0}, shadow χωρίς τιμή ${p?.unresolved ?? 0})`);

  for (const gate of ['on_demand', 'discovery']) {
    const g = trades.filter((t) => t.gate === gate);
    const diverged = g.filter((t) => Math.abs(t.diffPct) > SAME_EPSILON);
    const title = gate === 'on_demand' ? 'ΠΡΩΙΜΕΣ αγορές (on-demand gate)' : 'ΚΑΝΟΝΙΚΕΣ αγορές (discovery gate)';
    console.log(`\n--- ${title}: ${g.length} trades, διαφορετική έξοδος σε ${diverged.length} ---`);
    if (g.length === 0) continue;
    console.log(`  σημερινή λογική:   μέσο ${pct(avg(g.map((t) => t.realPct)))}  διάμεσο ${pct(median(g.map((t) => t.realPct)))}  σύνολο ${sol(sum(g.map((t) => t.realPct * t.amount)))}`);
    console.log(`  χωρίς exit_signal: μέσο ${pct(avg(g.map((t) => t.nosigPct)))}  διάμεσο ${pct(median(g.map((t) => t.nosigPct)))}  σύνολο ${sol(sum(g.map((t) => t.nosigPct * t.amount)))}`);
    const totalDiff = sum(g.map((t) => t.diffSol));
    console.log(`  διαφορά (χωρίς − σημερινό): ${sol(totalDiff)}`);

    const byReason = new Map<string, typeof g>();
    for (const t of diverged) {
      const key = `${t.exit_reason ?? '?'} → ${t.nosig_exit_reason}`;
      byReason.set(key, [...(byReason.get(key) ?? []), t]);
    }
    for (const [key, ts] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${key.padEnd(30)} n=${String(ts.length).padEnd(4)} μέση διαφορά ${pct(avg(ts.map((t) => t.diffPct))).padEnd(8)} σύνολο ${sol(sum(ts.map((t) => t.diffSol)))}`);
    }
    const line = (t: (typeof g)[number]): string =>
      `    #${t.id} ${t.token_address.slice(0, 8)} ${t.mode.padEnd(5)} σημερινό ${pct(t.realPct).padEnd(8)} (${t.exit_reason}) → ${pct(t.nosigPct)} (${t.nosig_exit_reason})`;
    const best = diverged.filter((t) => t.diffPct > 0).sort((a, b) => b.diffPct - a.diffPct).slice(0, 5);
    const worst = diverged.filter((t) => t.diffPct < 0).sort((a, b) => a.diffPct - b.diffPct).slice(0, 5);
    if (best.length > 0) console.log(`  μεγαλύτερα κέρδη χωρίς exit_signal:\n${best.map(line).join('\n')}`);
    if (worst.length > 0) console.log(`  μεγαλύτερες απώλειες χωρίς exit_signal:\n${worst.map(line).join('\n')}`);

    const med = median(diverged.map((t) => t.diffPct));
    if (diverged.length < MIN_DIVERGED_FOR_VERDICT) {
      console.log(`  ⏳ Ανεπαρκές δείγμα (${diverged.length} διαφορετικές εξόδους, χρειάζονται ≥ ${MIN_DIVERGED_FOR_VERDICT}).`);
    } else if (totalDiff > 0 && (med ?? 0) > 0) {
      console.log('  ✅ Χωρίς exit_signal βγάζει περισσότερα (σύνολο ΚΑΙ διάμεσο) → να βγει το exit_signal για αυτές τις αγορές.');
    } else if (totalDiff > 0) {
      console.log('  ⚠️ Σύνολο θετικό αλλά διάμεσο όχι — το κέρδος έρχεται από λίγα trades. Κοίτα τα παραπάνω πριν αποφασίσεις.');
    } else {
      console.log('  ❌ Το exit_signal προστατεύει — μένει όπως είναι.');
    }
  }
} finally {
  await closePool();
}

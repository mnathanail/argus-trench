import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run graduated-report
//
// 2026-09-27: αξιολόγηση της paper-only δοκιμής σε ήδη «αποφοιτημένα» tokens (εκτός
// bonding curve). Συγκρίνει τα graduated paper trades με τα κανονικά (bonding-curve)
// realtime trades της ίδιας περιόδου. Read-only — δεν αλλάζει τίποτα στη βάση.
//
// Αν το αποτέλεσμα είναι θετικό: LIVE_ON_GRADUATED_TOKENS = true στο
// src/decision/paperTradingConfig.ts. Αλλιώς μένει false.
//
// Μονάδες: pnl_net_pct είναι κλάσμα (−0.22 = −22%), ΜΕΤΑ τα assumed fees. pnl_sol είναι
// το υποθετικό αποτέλεσμα σε SOL με το paper position size.

/** Κάτω από τόσα κλεισμένα trades το δείγμα είναι πολύ μικρό για απόφαση. */
const MIN_CLOSED_FOR_VERDICT = 20;

interface GroupStats {
  total: number;
  open: number;
  closed: number;
  winners: number;
  avgNetPct: number | null;
  medianNetPct: number | null;
  sumPnlSol: number | null;
  bestNetPct: number | null;
  worstNetPct: number | null;
  since: Date | null;
}

const pool = getPool();

const STAGE_FILTER = `(d.trigger_wallet_snapshot_json->>'token_stage')`;

async function groupStats(stage: 'graduated' | 'bonding_curve', modes: string[]): Promise<GroupStats> {
  const { rows } = await pool.query<{
    total: string;
    open: string;
    closed: string;
    winners: string;
    avg_net: string | null;
    median_net: string | null;
    sum_pnl_sol: string | null;
    best_net: string | null;
    worst_net: string | null;
    since: Date | null;
  }>(
    `SELECT count(*)                                                        AS total,
            count(*) FILTER (WHERE pt.status = 'open')                      AS open,
            count(*) FILTER (WHERE pt.status = 'closed')                    AS closed,
            count(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct > 0) AS winners,
            avg(pt.pnl_net_pct) FILTER (WHERE pt.status = 'closed')         AS avg_net,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pt.pnl_net_pct)
              FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct IS NOT NULL) AS median_net,
            sum(pt.pnl_sol) FILTER (WHERE pt.status = 'closed')             AS sum_pnl_sol,
            max(pt.pnl_net_pct) FILTER (WHERE pt.status = 'closed')         AS best_net,
            min(pt.pnl_net_pct) FILTER (WHERE pt.status = 'closed')         AS worst_net,
            min(pt.entry_at)                                                AS since
       FROM paper_trades pt
       JOIN decision_log d ON d.id = pt.decision_log_id
      WHERE ${STAGE_FILTER} = $1
        AND pt.mode = ANY($2)`,
    [stage, modes],
  );
  const r = rows[0];
  const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    total: Number(r?.total ?? 0),
    open: Number(r?.open ?? 0),
    closed: Number(r?.closed ?? 0),
    winners: Number(r?.winners ?? 0),
    avgNetPct: num(r?.avg_net),
    medianNetPct: num(r?.median_net),
    sumPnlSol: num(r?.sum_pnl_sol),
    bestNetPct: num(r?.best_net),
    worstNetPct: num(r?.worst_net),
    since: r?.since ?? null,
  };
}

async function byExitReason(): Promise<{ exitReason: string; n: number; avgNetPct: number | null; sumPnlSol: number | null }[]> {
  const { rows } = await pool.query<{ exit_reason: string | null; n: string; avg_net: string | null; sum_pnl_sol: string | null }>(
    `SELECT pt.exit_reason, count(*) AS n, avg(pt.pnl_net_pct) AS avg_net, sum(pt.pnl_sol) AS sum_pnl_sol
       FROM paper_trades pt
       JOIN decision_log d ON d.id = pt.decision_log_id
      WHERE ${STAGE_FILTER} = 'graduated' AND pt.mode = 'paper' AND pt.status = 'closed'
      GROUP BY pt.exit_reason
      ORDER BY count(*) DESC`,
  );
  return rows.map((r) => ({
    exitReason: r.exit_reason ?? '(κενό)',
    n: Number(r.n),
    avgNetPct: r.avg_net === null ? null : Number(r.avg_net),
    sumPnlSol: r.sum_pnl_sol === null ? null : Number(r.sum_pnl_sol),
  }));
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const sol = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`);

function printGroup(title: string, s: GroupStats): void {
  const winRate = s.closed > 0 ? s.winners / s.closed : null;
  console.log(`\n=== ${title} ===`);
  console.log(`  από:            ${s.since ? s.since.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—'}`);
  console.log(`  trades:         ${s.total} (κλειστά ${s.closed}, ανοιχτά ${s.open})`);
  console.log(`  win rate:       ${pct(winRate)} (${s.winners}/${s.closed})`);
  console.log(`  μέσο pnl (net): ${pct(s.avgNetPct)}   διάμεσο: ${pct(s.medianNetPct)}`);
  console.log(`  σύνολο:         ${sol(s.sumPnlSol)}`);
  console.log(`  καλύτερο/χειρότερο: ${pct(s.bestNetPct)} / ${pct(s.worstNetPct)}`);
}

try {
  const graduated = await groupStats('graduated', ['paper']);
  const bondingCurve = await groupStats('bonding_curve', ['live', 'paper']);

  printGroup('GRADUATED tokens — paper (η δοκιμή)', graduated);
  printGroup('Bonding-curve tokens — live + paper (σύγκριση, ίδιο realtime κανάλι)', bondingCurve);

  const reasons = await byExitReason();
  if (reasons.length > 0) {
    console.log('\n=== Graduated — ανά λόγο εξόδου ===');
    for (const r of reasons) {
      console.log(`  ${r.exitReason.padEnd(15)} n=${String(r.n).padEnd(4)} μέσο ${pct(r.avgNetPct).padEnd(8)} σύνολο ${sol(r.sumPnlSol)}`);
    }
  }

  console.log('\n=== Ετυμηγορία ===');
  if (graduated.closed < MIN_CLOSED_FOR_VERDICT) {
    console.log(
      `  ⏳ Ανεπαρκές δείγμα: ${graduated.closed} κλειστά (χρειάζονται ≥ ${MIN_CLOSED_FOR_VERDICT}). ` +
        `Άφησέ το να τρέξει κι άλλο πριν αποφασίσεις.`,
    );
  } else if ((graduated.avgNetPct ?? 0) > 0 && (graduated.sumPnlSol ?? 0) > 0) {
    console.log('  ✅ Θετικό: μέσο και συνολικό αποτέλεσμα πάνω από μηδέν, μετά τα fees.');
    console.log('     → LIVE_ON_GRADUATED_TOKENS = true στο src/decision/paperTradingConfig.ts');
  } else {
    console.log('  ❌ Αρνητικό: μέσο ή συνολικό αποτέλεσμα κάτω από μηδέν, μετά τα fees.');
    console.log('     → LIVE_ON_GRADUATED_TOKENS μένει false.');
  }
  console.log(
    '  Σημ.: το αποτέλεσμα βασίζεται σε λίγα outliers αν το διάμεσο είναι πολύ πιο χαμηλά από το μέσο — ' +
      'δες και τα δύο πριν αποφασίσεις.',
  );
} finally {
  await closePool();
}

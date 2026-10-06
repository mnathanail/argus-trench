import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run on-demand-gate-report
//
// 2026-09-28: αξιολόγηση του on-demand gate (src/decision/onDemandGate.ts). Συγκρίνει τα
// bonding-curve realtime trades που μπήκαν μέσω on-demand gate (paper-only) με όσα μπήκαν
// μέσω του κανονικού gate του discovery, στην ΙΔΙΑ περίοδο. Read-only.
//
// Αν είναι θετικό: LIVE_ON_DEMAND_GATE = true στο src/decision/paperTradingConfig.ts.

const MIN_CLOSED_FOR_VERDICT = 20;

interface GroupRow {
  gate_source: string;
  total: string;
  open: string;
  closed: string;
  winners: string;
  avg_net: string | null;
  median_net: string | null;
  sum_pnl_sol: string | null;
  median_entry_mcap_sol: string | null;
  median_min_create_to_entry: string | null;
}

const pool = getPool();
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const sol = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`);
const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

try {
  const { rows: sinceRows } = await pool.query<{ since: Date | null }>(
    `SELECT min(pt.entry_at) AS since
       FROM paper_trades pt
       JOIN decision_log d ON d.id = pt.decision_log_id
      WHERE d.trigger_wallet_snapshot_json->>'gate_source' = 'on_demand'`,
  );
  const since = sinceRows[0]?.since ?? null;

  const { rows: checks } = await pool.query<{ passed: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE gate_passed)     AS passed,
            count(*) FILTER (WHERE NOT gate_passed) AS failed
       FROM decision_log
      WHERE candidate_source = 'on_demand' AND logic_version NOT LIKE '%:exp'`,
  );
  const { rows: reasons } = await pool.query<{ reason: string; n: string }>(
    `SELECT split_part(gate_fail_reason, ' ', 1) AS reason, count(*) AS n
       FROM decision_log
      WHERE candidate_source = 'on_demand' AND NOT gate_passed AND logic_version NOT LIKE '%:exp'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  );

  console.log('\n=== On-demand gate — έλεγχοι ===');
  console.log(`  πέρασαν ${checks[0]?.passed ?? 0}, απορρίφθηκαν ${checks[0]?.failed ?? 0}`);
  for (const r of reasons) console.log(`    απόρριψη: ${r.reason.padEnd(28)} ${r.n}`);

  if (since === null) {
    console.log('\n  Κανένα trade μέσω on-demand gate ακόμα.');
  } else {
    const { rows: groups } = await pool.query<GroupRow>(
      `SELECT COALESCE(d.trigger_wallet_snapshot_json->>'gate_source', 'discovery') AS gate_source,
              count(*)                                                                   AS total,
              count(*) FILTER (WHERE pt.status = 'open')                                 AS open,
              count(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct IS NOT NULL) AS closed,
              count(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct > 0)        AS winners,
              avg(pt.pnl_net_pct) FILTER (WHERE pt.status = 'closed')                    AS avg_net,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY pt.pnl_net_pct)
                FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct IS NOT NULL)       AS median_net,
              sum(pt.pnl_sol) FILTER (WHERE pt.status = 'closed')                        AS sum_pnl_sol,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY pt.simulated_entry_price * 1e9) AS median_entry_mcap_sol,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM
                pt.entry_at - to_timestamp((d.gate_snapshot_json->>'created_timestamp')::numeric)) / 60)
                                                                                         AS median_min_create_to_entry
         FROM paper_trades pt
         JOIN decision_log d ON d.id = pt.decision_log_id
        WHERE d.trigger_wallet_snapshot_json->>'source_channel' = 'pumpportal_websocket'
          AND d.trigger_wallet_snapshot_json->>'token_stage' = 'bonding_curve'
          AND NOT (d.trigger_wallet_snapshot_json ? 'experiment')
          AND pt.entry_at >= $1
        GROUP BY 1
        ORDER BY 1 DESC`,
      [since],
    );

    const { rows: agree } = await pool.query<{ n: string; later_passed: string }>(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM decision_log x
                 WHERE x.token_address = d.token_address
                   AND x.logic_version = d.logic_version
                   AND x.candidate_source = 'gated_pool'
                   AND x.gate_passed)) AS later_passed
         FROM paper_trades pt
         JOIN decision_log d ON d.id = pt.decision_log_id
        WHERE d.trigger_wallet_snapshot_json->>'gate_source' = 'on_demand'
          AND NOT (d.trigger_wallet_snapshot_json ? 'experiment')`,
    );

    console.log(`\n=== Σύγκριση (bonding-curve realtime trades από ${since.toISOString().replace('T', ' ').slice(0, 16)} UTC) ===`);
    const byName = new Map(groups.map((g) => [g.gate_source, g]));
    for (const g of groups) {
      const closed = Number(g.closed);
      const winRate = closed > 0 ? Number(g.winners) / closed : null;
      console.log(`\n  ${g.gate_source === 'on_demand' ? 'ON-DEMAND gate (paper)' : 'κανονικό gate (discovery)'}`);
      console.log(`    trades ${g.total} (κλειστά ${closed}, ανοιχτά ${g.open})   win rate ${pct(winRate)}`);
      console.log(`    μέσο ${pct(num(g.avg_net))}   διάμεσο ${pct(num(g.median_net))}   σύνολο ${sol(num(g.sum_pnl_sol))}`);
      console.log(
        `    είσοδος: διάμεσο market cap ${num(g.median_entry_mcap_sol)?.toFixed(0) ?? '—'} SOL, ` +
          `${num(g.median_min_create_to_entry)?.toFixed(1) ?? '—'}′ μετά τη δημιουργία`,
      );
    }
    const a = agree[0];
    console.log(
      `\n  Από τα on-demand tokens, πέρασαν ΑΡΓΟΤΕΡΑ και το πλήρες gate του discovery: ${a?.later_passed ?? 0}/${a?.n ?? 0}` +
        ' (τα υπόλοιπα: απορρίφθηκαν ή δεν τα είδε ποτέ — ενδεικτικό)',
    );

    console.log('\n=== Ετυμηγορία ===');
    const od = byName.get('on_demand');
    const disc = byName.get('discovery');
    const odClosed = Number(od?.closed ?? 0);
    const odMedian = num(od?.median_net);
    const discMedian = num(disc?.median_net);
    if (odClosed < MIN_CLOSED_FOR_VERDICT) {
      console.log(`  ⏳ Ανεπαρκές δείγμα: ${odClosed} κλειστά on-demand trades (χρειάζονται ≥ ${MIN_CLOSED_FOR_VERDICT}).`);
    } else if ((num(od?.avg_net) ?? 0) > 0 && (num(od?.sum_pnl_sol) ?? 0) > 0 && (odMedian ?? 0) > 0 &&
               (discMedian === null || (odMedian ?? 0) >= discMedian)) {
      console.log('  ✅ Θετικό: μέσο, διάμεσο και σύνολο > 0 μετά τα fees, διάμεσο ≥ του κανονικού gate.');
      console.log('     → LIVE_ON_DEMAND_GATE = true στο src/decision/paperTradingConfig.ts');
    } else {
      console.log('  ❌ Όχι ακόμα: το on-demand gate δεν αποδίδει καλύτερα — LIVE_ON_DEMAND_GATE μένει false.');
    }
  }
} finally {
  await closePool();
}

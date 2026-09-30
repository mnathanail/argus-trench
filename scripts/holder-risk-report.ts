import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { HOLDER_RISK_MAX_PCT } from '../src/decision/holderRiskCheck.js';

// Χρήση: railway run npm run holder-risk-report
//
// 2026-09-29: ισχύει το όριο holder risk ≥ 50% (τεκμηριωμένο στο κανάλι GMGN smart money,
// n=1136) ΚΑΙ στις πρώιμες αγορές του on-demand gate; Διαβάζει paper_trades.entry_timing_json
// ->'holder_risk', ΜΟΝΟ όσα γράφτηκαν σε mode 'record' (στο discovery το φίλτρο μπλοκάρει ήδη,
// άρα εκεί δεν υπάρχουν trades ≥ 50% να μετρηθούν). Read-only.
// Αν ✅ → HOLDER_RISK_ENTRY_MODE.on_demand = 'block' στο src/decision/paperTradingConfig.ts.

const MIN_CLOSED_HIGH_RISK = 10;

interface Row {
  bucket: string;
  mode: string;
  n: string;
  closed: string;
  winners: string;
  avg_net: string | null;
  median_net: string | null;
  sum_pnl_sol: string | null;
}

const pool = getPool();
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

const BUCKET_SQL = `
  CASE
    WHEN (pt.entry_timing_json->'holder_risk'->>'pct') IS NULL THEN 'χωρίς τιμή'
    WHEN (pt.entry_timing_json->'holder_risk'->>'pct')::numeric < 0.10 THEN '1: < 10%'
    WHEN (pt.entry_timing_json->'holder_risk'->>'pct')::numeric < 0.30 THEN '2: 10–30%'
    WHEN (pt.entry_timing_json->'holder_risk'->>'pct')::numeric < $1  THEN '3: 30–50%'
    ELSE '4: ≥ 50%'
  END`;

try {
  const { rows } = await pool.query<Row>(
    `SELECT ${BUCKET_SQL} AS bucket,
            GROUPING(pt.mode)::text || coalesce(pt.mode, '') AS mode,
            count(*)                                                                   AS n,
            count(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct IS NOT NULL) AS closed,
            count(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct > 0)        AS winners,
            avg(pt.pnl_net_pct) FILTER (WHERE pt.status = 'closed')                    AS avg_net,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pt.pnl_net_pct)
              FILTER (WHERE pt.status = 'closed' AND pt.pnl_net_pct IS NOT NULL)       AS median_net,
            sum(pt.pnl_sol) FILTER (WHERE pt.status = 'closed')                        AS sum_pnl_sol
       FROM paper_trades pt
      WHERE pt.entry_timing_json->'holder_risk'->>'mode' = 'record'
      GROUP BY GROUPING SETS ((1), (1, pt.mode))
      ORDER BY 1, 2`,
    [HOLDER_RISK_MAX_PCT],
  );
  if (rows.length === 0) {
    console.log('Κανένα trade με holder_risk σε mode record ακόμα.');
  } else {
    console.log('\n=== Holder risk → αποτέλεσμα (on-demand gate, mode record, live + paper) ===');
    console.log('  (όλα = live+paper μαζί· από κάτω ανά mode)');
    for (const r of rows) {
      const closed = Number(r.closed);
      const label = r.mode.startsWith('1') ? 'όλα' : r.mode.slice(1);
      console.log(
        `  ${r.bucket.padEnd(12)} ${label.padEnd(6)} n=${String(r.n).padEnd(4)} κλειστά ${String(closed).padEnd(4)} ` +
          `win ${pct(closed > 0 ? Number(r.winners) / closed : null).padEnd(7)} μέσο ${pct(num(r.avg_net)).padEnd(8)} ` +
          `διάμεσο ${pct(num(r.median_net)).padEnd(8)} σύνολο ${num(r.sum_pnl_sol)?.toFixed(4) ?? '—'} SOL`,
      );
    }

    const all = rows.filter((r) => r.mode.startsWith('1'));
    const high = all.find((r) => r.bucket.startsWith('4'));
    const rest = all.filter((r) => !r.bucket.startsWith('4'));
    const restClosed = rest.reduce((s, r) => s + Number(r.closed), 0);
    const restSum = rest.reduce((s, r) => s + (num(r.sum_pnl_sol) ?? 0), 0);
    const restAvgPct = restClosed > 0 ? rest.reduce((s, r) => s + (num(r.avg_net) ?? 0) * Number(r.closed), 0) / restClosed : null;
    // 2026-09-30: η σύγκριση είναι ΑΝΑ TRADE, όχι σε σύνολα — το ≥50% είναι το μεγαλύτερο
    // bucket, άρα το σύνολό του βγαίνει πάντα «χειρότερο» ακόμα κι αν κάθε trade χάνει το ίδιο.
    console.log('\n=== Ετυμηγορία (ανά trade) ===');
    if (high === undefined || Number(high.closed) < MIN_CLOSED_HIGH_RISK) {
      console.log(`  ⏳ Ανεπαρκές δείγμα: ${high?.closed ?? 0} κλειστά με risk ≥ 50% (χρειάζονται ≥ ${MIN_CLOSED_HIGH_RISK}).`);
    } else {
      const highClosed = Number(high.closed);
      const highPerTrade = (num(high.sum_pnl_sol) ?? 0) / highClosed;
      const restPerTrade = restClosed > 0 ? restSum / restClosed : null;
      const highAvgPct = num(high.avg_net);
      console.log(`  ≥ 50%:     ${highClosed} κλειστά, ${highPerTrade.toFixed(4)} SOL/trade, μέσο ${pct(highAvgPct)}`);
      console.log(`  υπόλοιπα:  ${restClosed} κλειστά, ${restPerTrade?.toFixed(4) ?? '—'} SOL/trade, μέσο ${pct(restAvgPct)}`);
      if (restPerTrade !== null && restAvgPct !== null && highAvgPct !== null && highPerTrade < restPerTrade && highAvgPct < restAvgPct) {
        console.log('  ✅ Τα ≥ 50% χάνουν περισσότερα ανά trade → HOLDER_RISK_ENTRY_MODE.on_demand = \'block\' στο src/decision/paperTradingConfig.ts');
      } else {
        console.log('  ❌ Ανά trade τα ≥ 50% ΔΕΝ είναι χειρότερα από τα υπόλοιπα — μένουμε σε record.');
      }
    }
  }
} finally {
  await closePool();
}

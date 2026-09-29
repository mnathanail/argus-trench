import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run wallet-holding-report
//
// 2026-09-29 (ρητή απόφαση χρήστη): ποιο ελάχιστο όριο στον μέσο χρόνο κρατήματος
// (`avg_holding_sec`, migration 0021, από το GMGN σε κάθε scoring) ξεχωρίζει τα wallets που
// αξίζει να αντιγράφουμε από τους snipers; Για κάθε ενεργό wallet: ο μέσος χρόνος
// κρατήματος + τι βγάλαμε ΕΜΕΙΣ αντιγράφοντάς το (realtime trades από 27/9, live + paper).
// Read-only. Το avg_holding_sec γεμίζει σταδιακά (το scoring περνάει ~40 wallets/κύκλο).

interface Row {
  address: string;
  source: string;
  avg_holding_sec: string | null;
  trades: string;
  wins: string;
  sum_pnl_sol: string | null;
  sum_pnl_pct: string | null;
}

const pool = getPool();
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const sol = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`;
const mins = (sec: number): string => (sec < 60 ? `${Math.round(sec)}″` : sec < 3600 ? `${(sec / 60).toFixed(1)}′` : `${(sec / 3600).toFixed(1)}h`);

const BUCKETS: [string, number, number][] = [
  ['< 1′', 0, 60],
  ['1–2′', 60, 120],
  ['2–5′', 120, 300],
  ['5–15′', 300, 900],
  ['15–60′', 900, 3600],
  ['≥ 1h', 3600, Infinity],
];
const THRESHOLDS_MIN = [1, 2, 5, 15, 30];

try {
  const { rows } = await pool.query<Row>(
    `WITH copies AS (
       SELECT dl.trigger_wallet_address AS wallet,
              count(*)                                   AS trades,
              count(*) FILTER (WHERE pt.pnl_net_pct > 0) AS wins,
              sum(pt.pnl_sol)                            AS sum_pnl_sol,
              sum(pt.pnl_net_pct)                        AS sum_pnl_pct
         FROM paper_trades pt
         JOIN decision_log dl ON dl.id = pt.decision_log_id
        WHERE dl.trigger_wallet_snapshot_json->>'source_channel' = 'pumpportal_websocket'
          AND pt.entry_at >= '2026-09-27 19:00+00'
          AND pt.status = 'closed'
          AND pt.pnl_net_pct IS NOT NULL
        GROUP BY 1
     )
     SELECT w.address, w.source, w.avg_holding_sec,
            COALESCE(c.trades, 0) AS trades, COALESCE(c.wins, 0) AS wins,
            c.sum_pnl_sol, c.sum_pnl_pct
       FROM watchlist_wallets w
       LEFT JOIN copies c ON c.wallet = w.address
      WHERE w.active
      ORDER BY w.avg_holding_sec NULLS LAST`,
  );

  const wallets = rows.map((r) => ({
    address: r.address,
    source: r.source,
    hold: r.avg_holding_sec === null ? null : Number(r.avg_holding_sec),
    trades: Number(r.trades),
    wins: Number(r.wins),
    sumSol: r.sum_pnl_sol === null ? 0 : Number(r.sum_pnl_sol),
    sumPct: r.sum_pnl_pct === null ? 0 : Number(r.sum_pnl_pct),
  }));
  const known = wallets.filter((w) => w.hold !== null);
  console.log(`\n=== Μέσος χρόνος κρατήματος — ${wallets.length} ενεργά wallets (${known.length} με τιμή, ${wallets.length - known.length} δεν έχουν σκοραριστεί ακόμα) ===`);

  const summary = (ws: typeof wallets): string => {
    const trades = ws.reduce((s, w) => s + w.trades, 0);
    const wins = ws.reduce((s, w) => s + w.wins, 0);
    const sumSol = ws.reduce((s, w) => s + w.sumSol, 0);
    const sumPct = ws.reduce((s, w) => s + w.sumPct, 0);
    return (
      `wallets ${String(ws.length).padEnd(4)} trades ${String(trades).padEnd(4)} ` +
      `win ${pct(trades > 0 ? wins / trades : null).padEnd(7)} μέσο ${pct(trades > 0 ? sumPct / trades : null).padEnd(8)} σύνολο ${sol(sumSol)}`
    );
  };

  console.log('\n--- Ανά ζώνη χρόνου κρατήματος (αποτέλεσμα των ΔΙΚΩΝ μας αντιγραφών) ---');
  for (const [label, lo, hi] of BUCKETS) {
    const ws = known.filter((w) => (w.hold as number) >= lo && (w.hold as number) < hi);
    console.log(`  ${label.padEnd(7)} ${summary(ws)}`);
  }
  console.log(`  ${'άγνωστο'.padEnd(7)} ${summary(wallets.filter((w) => w.hold === null))}`);

  console.log('\n--- Αν κρατούσαμε μόνο wallets με χρόνο κρατήματος ≥ όριο ---');
  for (const t of THRESHOLDS_MIN) {
    const keep = known.filter((w) => (w.hold as number) >= t * 60);
    const drop = known.filter((w) => (w.hold as number) < t * 60);
    console.log(`  ≥ ${String(t).padStart(2)}′  κρατάμε: ${summary(keep)}`);
    console.log(`        κόβουμε: ${summary(drop)}`);
  }

  const copied = known.filter((w) => w.trades > 0).sort((a, b) => b.sumSol - a.sumSol);
  if (copied.length > 0) {
    console.log('\n--- Wallets που αντιγράψαμε (κατά αποτέλεσμα) ---');
    for (const w of copied) {
      console.log(
        `  ${w.address.slice(0, 8)} ${w.source.padEnd(11)} κράτημα ${mins(w.hold as number).padEnd(6)} ` +
          `trades ${String(w.trades).padEnd(3)} σύνολο ${sol(w.sumSol)}`,
      );
    }
  }
} finally {
  await closePool();
}

import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run entry-speed-report
//
// 2026-09-28 (ρητό αίτημα χρήστη): πού πάει ο χρόνος από τη στιγμή που βλέπουμε την αγορά
// του wallet μας μέχρι να ανοίξει το trade, και πόσο πληρώνουμε σε τιμή γι' αυτόν. Διαβάζει
// το paper_trades.entry_timing_json (migration 0019, γράφεται από realtimeEntryHandler.ts).
// Read-only. Απαντά στο: «αξίζει να ανεβάσουμε priority/tip fee;» και «μπορεί να βγει το
// pre-swap portfolio info από τη διαδρομή της αγοράς;».

interface Row {
  id: string;
  mode: string;
  entry_at: Date;
  status: string;
  pnl_net_pct: string | null;
  t: Timing;
}

interface Timing {
  gate_source?: string;
  graduated?: boolean;
  mode?: string;
  fallback_reason?: string | null;
  signal?: { price?: number; mcap_sol?: number | null };
  executed_price?: number | null;
  slippage_vs_signal?: number | null;
  ms?: { lookup?: number; on_demand_gate?: number | null; claim?: number; live_attempt?: number; event_to_insert?: number };
  live?: {
    walletQueueMs?: number | null;
    walletExecMs?: number | null;
    riskGateMs?: number | null;
    reserveMs?: number | null;
    swap?: { submitQueueMs?: number; submitExecMs?: number; confirmMs?: number; initialStatus?: string } | null;
    postSwapMs?: number | null;
    totalMs?: number;
    reportInputSol?: number | null;
    reportGasSol?: number | null;
    balanceDiffSol?: number | null;
    priorityFeeSol?: number;
    tipFeeSol?: number;
  } | null;
}

const pool = getPool();

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}
const nums = (xs: readonly (number | null | undefined)[]): number[] =>
  xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const ms = (v: number | null): string => (v === null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
function stat(label: string, xs: readonly (number | null | undefined)[], fmt: (v: number | null) => string = ms): void {
  const v = nums(xs);
  console.log(`  ${label.padEnd(34)} n=${String(v.length).padEnd(4)} διάμεσο ${fmt(quantile(v, 0.5)).padEnd(8)} p90 ${fmt(quantile(v, 0.9))}`);
}

try {
  const { rows } = await pool.query<Row>(
    `SELECT id, mode, entry_at, status, pnl_net_pct, entry_timing_json AS t
       FROM paper_trades
      WHERE entry_timing_json IS NOT NULL
      ORDER BY entry_at`,
  );
  if (rows.length === 0) {
    console.log('Κανένα trade με entry_timing_json ακόμα (χρειάζεται το deploy με migration 0019).');
  } else {
    const first = rows[0]?.entry_at;
    console.log(`\n=== Ταχύτητα εισόδου — ${rows.length} realtime trades από ${first?.toISOString().replace('T', ' ').slice(0, 16)} UTC ===`);

    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = `${r.mode} / ${r.t.gate_source ?? '?'}${r.t.graduated ? ' / graduated' : ''}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    console.log('\n--- Σήμα → INSERT του trade (όλη η διαδρομή), ανά mode / gate ---');
    for (const [key, rs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      stat(key, rs.map((r) => r.t.ms?.event_to_insert));
    }

    const reasons = new Map<string, number>();
    for (const r of rows) if (r.mode !== 'live') reasons.set(r.t.fallback_reason ?? '(κενό)', (reasons.get(r.t.fallback_reason ?? '(κενό)') ?? 0) + 1);
    console.log('\n--- Γιατί ΔΕΝ έγινε live (paper) ---');
    for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${reason.padEnd(34)} ${n}`);

    console.log('\n--- Βήματα πριν τη live απόπειρα (όλα τα trades) ---');
    stat('DB lookup (wallet/gate/cap)', rows.map((r) => r.t.ms?.lookup));
    stat('on-demand gate (όπου έτρεξε)', rows.map((r) => r.t.ms?.on_demand_gate));
    stat('claim decision_log', rows.map((r) => r.t.ms?.claim));

    const live = rows.filter((r) => r.mode === 'live' && r.t.live);
    const attempted = rows.filter((r) => r.t.live?.swap);
    console.log(`\n--- LIVE: πού πάει ο χρόνος (${live.length} live, ${attempted.length} με απόπειρα swap) ---`);
    stat('portfolio info — ουρά limiter', live.map((r) => r.t.live?.walletQueueMs));
    stat('portfolio info — εκτέλεση', live.map((r) => r.t.live?.walletExecMs));
    stat('risk gate (DB)', live.map((r) => r.t.live?.riskGateMs));
    stat('κράτηση κεφαλαίου (DB)', live.map((r) => r.t.live?.reserveMs));
    stat('swap — ουρά limiter', attempted.map((r) => r.t.live?.swap?.submitQueueMs));
    stat('swap — εκτέλεση (1ο response)', attempted.map((r) => r.t.live?.swap?.submitExecMs));
    stat('swap — επιβεβαίωση (polling)', attempted.map((r) => r.t.live?.swap?.confirmMs));
    stat('μετά το swap (balance+native verify)', live.map((r) => r.t.live?.postSwapMs));
    const preSwap = live.map((r) => {
      const t = r.t;
      const parts = [t.ms?.lookup, t.ms?.on_demand_gate ?? 0, t.ms?.claim, t.live?.walletQueueMs, t.live?.walletExecMs,
        t.live?.riskGateMs, t.live?.reserveMs, t.live?.swap?.submitQueueMs, t.live?.swap?.submitExecMs];
      return parts.every((p) => typeof p === 'number') ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
    });
    stat('ΣΗΜΑ → swap απαντήθηκε (σύνολο)', preSwap);
    const initial = new Map<string, number>();
    for (const r of attempted) initial.set(r.t.live?.swap?.initialStatus ?? '?', (initial.get(r.t.live?.swap?.initialStatus ?? '?') ?? 0) + 1);
    console.log(`  status 1ου swap response: ${[...initial.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || '—'}`);

    console.log('\n--- LIVE: τιμή εκτέλεσης vs τιμή σήματος (την αγορά του wallet) ---');
    const slips = live.map((r) => r.t.slippage_vs_signal);
    stat('slippage vs σήμα', slips, pct);
    const mean = nums(slips);
    console.log(`  μέσος όρος: ${pct(mean.length ? mean.reduce((a, b) => a + b, 0) / mean.length : null)}`);
    if ((quantile(nums(slips), 0.5) ?? 0) > 5) {
      console.log('  ⚠️ Διάμεσο > +500%: πιθανή διαφορά μονάδων τιμής (SOL vs USD) — έλεγξε πριν βγάλεις συμπέρασμα.');
    }
    const buckets: [string, number, number][] = [['< 2s', 0, 2000], ['2–4s', 2000, 4000], ['4–8s', 4000, 8000], ['≥ 8s', 8000, Infinity]];
    console.log('  slippage ανά καθυστέρηση σήμα → swap:');
    for (const [label, lo, hi] of buckets) {
      const s = live.filter((_, i) => { const d = preSwap[i]; return d != null && d >= lo && d < hi; }).map((r) => r.t.slippage_vs_signal);
      const v = nums(s);
      console.log(`    ${label.padEnd(6)} n=${String(v.length).padEnd(4)} διάμεσο ${pct(quantile(v, 0.5))}`);
    }

    console.log('\n--- LIVE: κόστος από GMGN report vs balance-diff ---');
    const diffs = live
      .map((r) => {
        const l = r.t.live;
        return l?.balanceDiffSol != null && l.reportInputSol != null ? l.balanceDiffSol - (l.reportInputSol + (l.reportGasSol ?? 0)) : null;
      });
    stat('balance-diff − (input + gas) [SOL]', diffs, (v) => (v === null ? '—' : v.toFixed(5)));
    const withReport = nums(diffs).length;
    console.log(`  report διαθέσιμο σε ${withReport}/${live.length} live trades`);
    const fees = live.map((r) => (r.t.live?.priorityFeeSol ?? 0) + (r.t.live?.tipFeeSol ?? 0));
    const sizes = live.map((r) => r.t.live?.reportInputSol ?? null);
    const feePct = fees.map((f, i) => (sizes[i] ? f / (sizes[i] as number) : null));
    stat('priority+tip fee ως % της θέσης', feePct, pct);

    console.log('\n=== Τι να κοιτάξεις ===');
    console.log('  • «ουρά limiter» ≈ 0 → η αλλαγή προτεραιότητας δούλεψε.');
    console.log('  • Μεγάλο slippage που ΜΕΓΑΛΩΝΕΙ με την καθυστέρηση → ταχύτερη εκτέλεση (fees) αξίζει.');
    console.log('  • balance-diff ≈ input+gas (διαφορά ~0, εκτός από ~0.002 rent λογαριασμού) → το pre-swap');
    console.log('    portfolio info μπορεί να βγει από τη διαδρομή (κόστος από το report).');
    console.log('  • «μετά το swap» μεγάλο → το trade μένει εκτός realtime παρακολούθησης όλο αυτό το διάστημα.');
  }
} finally {
  await closePool();
}

import 'dotenv/config';
import fs from 'node:fs';
import {
  CHECKPOINTS_MIN,
  MINUTE_MS,
  pathStats,
  simPnlSol,
  simulateExit,
  windowCandles,
  type ExitMode,
  type ExitParams,
  type PathStats,
} from '../src/analysis/exitPath.js';
import { anchorCandlesToEntryPrice } from '../src/collectors/exitResolver.js';
import { closePool, getPool } from '../src/db/pool.js';
import { PAPER_ASSUMED_FEES_PCT } from '../src/decision/paperTradingConfig.js';
import { rethrowIfRateLimited } from '../src/gmgn/errors.js';
import { fetchKline, type Candle } from '../src/gmgn/kline.js';
import { delay } from '../src/util/delay.js';

/**
 * 2026-10-04 (αίτημα χρήστη) — «πού χάνουμε και τι θα άλλαζε με άλλες εξόδους / φίλτρα;»
 *
 *   railway run npm run exit-path-analysis [-- --since 2026-09-30T08:00Z] [--no-cache]
 *
 * Read-only. Για κάθε realtime paper trade (με ≥25h ζωής, ώστε να έχει κλείσει το 24ωρο)
 * παίρνει 1m candles του GMGN για τις 24h μετά την είσοδο (αγκυρωμένα στην τιμή εισόδου σε
 * SOL, όπως ο exit-resolver) και:
 *   A. ελέγχει ότι η προσομοίωση με τους σημερινούς κανόνες βγάζει ό,τι και το paper,
 *   B. δείχνει την πορεία: πόσο βυθίζονται οι νικητές πριν το +50%, πόσο γρήγορα το πιάνουν,
 *      τι γίνεται με όσα δεν έχουν πιάσει τίποτα σε 15/30/60/120′,
 *   C. grid εξόδων (stop × χρονικό όριο × τρόπος) με ΠΡΑΓΜΑΤΙΚΑ fees (4.5% ανά γύρο):
 *      διαλέγουμε στις μέρες 1–2 (train), ελέγχουμε στις 3+ (test),
 *   D. φίλτρα εισόδου: gate, mcap, μέγεθος αγοράς του wallet, ώρα, holder risk, και τα
 *      χαρακτηριστικά του wallet (αριθμός trades, χρόνος κράτησης, win rate),
 *   E. ανά wallet που έδωσε το σήμα — ποια μας κοστίζουν σταθερά (υποψήφια για /unwatch).
 *
 * Candles αποθηκεύονται σε cache (/tmp/argus-exit-path-cache.json): δεύτερη εκτέλεση = 0 GMGN calls.
 * Προσοχή: σε candle 1 λεπτού δεν ξέρουμε τη σειρά low/high — υποθέτουμε πάντα το χειρότερο.
 */

const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const SINCE = new Date(sinceIdx >= 0 ? args[sinceIdx + 1]! : '2026-09-30T08:00:00Z');
const USE_CACHE = !args.includes('--no-cache');
/** Μόνο trades από wallets που είναι ΑΚΟΜΑ ενεργά στη watchlist — «πώς θα πήγαινε η σημερινή λίστα». */
const ACTIVE_ONLY = args.includes('--active-only');
const WSOL = 'So11111111111111111111111111111111111111112';
/** Η πρώτη ώρα με candles 30″ (η λεπτότερη ανάλυση του GMGN): οι νικητές κινούνται στα πρώτα λεπτά. */
const FINE_MS = 3600_000;
const CACHE_FILE = '/tmp/argus-exit-path-cache.json';
/** Πραγματικό κόστος ανά γύρο: pump.fun 1.25% × 2 + GMGN 1% × 2 (το paper βάζει 2%). */
const REAL_FEES_PCT = 0.045;
const DAY_MS = 24 * 3600_000;
const TRAIN_MAX_DAY = 2;

const STOPS = [0.2, 0.25, 0.3, 0.4, 0.5];
const LIMITS: (number | null)[] = [15, 30, 60, 120, null];
const MODES: ExitMode[] = ['trail', 'half_tp', 'ladder'];
const BASELINE: ExitParams = { stopPct: 0.5, timeLimitMin: null, mode: 'trail' };

interface Row {
  id: string;
  token_address: string;
  entry_at: Date;
  status: string;
  exit_reason: string | null;
  pnl_sol: string | null;
  simulated_entry_price: string;
  simulated_entry_amount_sol: string | null;
  entry_timing_json: Record<string, any> | null;
  trigger_wallet_address: string | null;
  name: string | null;
  source: string | null;
  trade_count: number | null;
  avg_holding_sec: string | null;
  win_rate: string | null;
  active: boolean | null;
}

interface Trade {
  row: Row;
  day: number;
  train: boolean;
  entry: number;
  entryAtMs: number;
  size: number;
  /** Πραγματικό paper pnl διορθωμένο σε πραγματικά fees. null αν δεν έχει κλείσει. */
  actualReal: number | null;
  candles: Candle[] | null;
  stats: PathStats | null;
}

const pool = getPool();
const f = (v: number, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const pc = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const paramLabel = (p: ExitParams) => `stop −${Math.round(p.stopPct * 100)}% · όριο ${p.timeLimitMin === null ? '24h' : `${p.timeLimitMin}′`} · ${p.mode}`;

function loadCache(): Record<string, Candle[]> {
  if (!USE_CACHE) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Record<string, Candle[]>;
  } catch {
    return {};
  }
}

try {
  const { rows } = await pool.query<Row>(
    `SELECT t.id, t.token_address, t.entry_at, t.status, t.exit_reason, t.pnl_sol,
            t.simulated_entry_price, t.simulated_entry_amount_sol, t.entry_timing_json,
            d.trigger_wallet_address, w.name, w.source, w.trade_count, w.avg_holding_sec, w.win_rate, w.active
       FROM paper_trades t
       JOIN decision_log d ON d.id = t.decision_log_id
       LEFT JOIN watchlist_wallets w ON w.address = d.trigger_wallet_address
      WHERE t.entry_at >= $1
        AND t.entry_at < now() - interval '25 hours'
        AND t.entry_timing_json IS NOT NULL
        AND t.simulated_entry_price > 0
      ORDER BY t.entry_at`,
    [SINCE],
  );
  const selected = ACTIVE_ONLY ? rows.filter((r) => r.active === true) : rows;
  console.log(
    `\n${selected.length} realtime paper trades από ${SINCE.toISOString().slice(0, 16)} (μόνο όσα έχουν ήδη ≥25h ζωής)` +
      (ACTIVE_ONLY ? ` — ΜΟΝΟ από wallets ακόμα ενεργά (${rows.length - selected.length} εκτός)` : '') + '.',
  );

  // ── Candles ──────────────────────────────────────────────────────────────────
  // 2026-10-04, διόρθωση μετά την 1η εκτέλεση: το «δέσιμο» των USD candles στο close του
  // λεπτού της εισόδου υποτιμούσε κάθε pump που ξεκινούσε μέσα σε εκείνο το λεπτό (έλεγχος A:
  // −8.2 vs −1.5 SOL). Τώρα: τιμή token σε SOL = USD τιμή token / USD τιμή SOL την ίδια στιγμή
  // (candles wSOL 5′), χωρίς καμία υπόθεση για τη στιγμή της εισόδου, και 30″ candles την 1η ώρα.
  const cache = loadCache();
  let fetched = 0;
  let failed = 0;
  const kline = async (key: string, tokenAddress: string, fromMs: number, toMs: number, resolution: string): Promise<Candle[] | undefined> => {
    if (cache[key] !== undefined) return cache[key];
    try {
      const c = await fetchKline({ chain: 'sol', tokenAddress, from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000), resolution });
      cache[key] = c;
      fetched += 1;
      await delay(400);
      if (fetched % 50 === 0 && USE_CACHE) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      return c;
    } catch (error) {
      rethrowIfRateLimited(error);
      failed += 1;
      return undefined;
    }
  };
  // SOL/USD: candles 5′ ανά μέρα, από την πρώτη είσοδο ως 24h μετά την τελευταία.
  const solCandles: Candle[] = [];
  if (selected.length > 0) {
    const first = selected[0]!.entry_at.getTime() - 3600_000;
    const last = selected.at(-1)!.entry_at.getTime() + DAY_MS + 3600_000;
    for (let t = Math.floor(first / DAY_MS) * DAY_MS; t < last; t += DAY_MS) {
      const c = await kline(`sol5m:${t}`, WSOL, t, t + DAY_MS, '5m');
      if (c !== undefined) solCandles.push(...c);
    }
    solCandles.sort((a, b) => a.timestamp - b.timestamp);
  }
  const solUsdAt = (t: number): number | null => {
    let lo = 0;
    let hi = solCandles.length - 1;
    let best: Candle | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (solCandles[mid]!.timestamp <= t) { best = solCandles[mid]!; lo = mid + 1; } else hi = mid - 1;
    }
    return best?.close ?? solCandles[0]?.open ?? null;
  };
  console.log(`  SOL/USD: ${solCandles.length} candles 5′${solCandles.length === 0 ? ' — ΔΕΝ βρέθηκαν, πέφτω στο παλιό δέσιμο στην είσοδο' : ''}`);
  const toSol = (cs: Candle[]): Candle[] =>
    cs.flatMap((c) => {
      const s = solUsdAt(c.timestamp);
      return s === null || !(s > 0) ? [] : [{ ...c, open: c.open / s, high: c.high / s, low: c.low / s, close: c.close / s }];
    });
  /** τιμή στην είσοδο κατά τα candles / τιμή του σήματος (η αγορά του wallet) — πρέπει να είναι ~1. */
  const calibration: number[] = [];
  const trades: Trade[] = [];
  for (const [i, r] of selected.entries()) {
    const entryAtMs = r.entry_at.getTime();
    const day = Math.floor((entryAtMs - SINCE.getTime()) / DAY_MS) + 1;
    const entry = Number(r.simulated_entry_price);
    const size = Number(r.simulated_entry_amount_sol ?? 0) > 0 ? Number(r.simulated_entry_amount_sol) : 0.1;
    const actualReal = r.status === 'closed' && r.pnl_sol !== null ? Number(r.pnl_sol) - size * (REAL_FEES_PCT - PAPER_ASSUMED_FEES_PCT) : null;
    const coarse = await kline(r.id, r.token_address, entryAtMs - 120_000, entryAtMs + DAY_MS, '1m'); // ίδιο κλειδί με την 1η εκτέλεση
    const fine = await kline(`${r.id}:30s`, r.token_address, entryAtMs - 60_000, entryAtMs + FINE_MS, '30s');
    if (i > 0 && i % 50 === 0) console.log(`  … candles ${i}/${selected.length}`);
    let candles: Candle[] | null = null;
    let stats: PathStats | null = null;
    const fineSorted = [...(fine ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    const fineEnd = fineSorted.length > 0 ? fineSorted.at(-1)!.timestamp + 30_000 : entryAtMs;
    // 30″ όπου υπάρχουν, 1′ μετά (χωρίς επικάλυψη).
    const merged = [...fineSorted, ...[...(coarse ?? [])].filter((c) => c.timestamp >= fineEnd)].sort((a, b) => a.timestamp - b.timestamp);
    if (merged.length > 0) {
      let priced: Candle[];
      if (solCandles.length > 0) {
        priced = toSol(merged);
        const signal = Number(r.entry_timing_json?.signal?.price ?? 0);
        const at = priced.filter((c) => c.timestamp <= entryAtMs).at(-1) ?? priced.find((c) => c.timestamp > entryAtMs);
        if (signal > 0 && at !== undefined) calibration.push(at.close / signal);
      } else {
        priced = anchorCandlesToEntryPrice(merged, entry, r.entry_at);
      }
      const w = windowCandles(priced, entryAtMs);
      if (w.length > 0) {
        candles = w;
        stats = pathStats(w, entry, entryAtMs);
      }
    }
    trades.push({ row: r, day, train: day <= TRAIN_MAX_DAY, entry, entryAtMs, size, actualReal, candles, stats });
  }
  if (USE_CACHE) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const withData = trades.filter((t) => t.candles !== null);
  console.log(`  candles: ${withData.length} με δεδομένα · ${trades.length - withData.length} χωρίς (σφάλματα GMGN ${failed}) · νέα GMGN calls ${fetched}`);
  if (calibration.length > 0) {
    console.log(
      `  βαθμονόμηση (τιμή candles στην είσοδο ÷ τιμή αγοράς του wallet): διάμεσο ${median(calibration)!.toFixed(2)} · ` +
        `p10 ${quantile(calibration, 0.1)!.toFixed(2)} · p90 ${quantile(calibration, 0.9)!.toFixed(2)}  (≈1.00 = σωστή μετατροπή)`,
    );
  }

  // ── A. Έλεγχος: η προσομοίωση με τους σημερινούς κανόνες ≈ το paper; ──────────
  const closedWithData = withData.filter((t) => t.row.status === 'closed' && t.row.pnl_sol !== null);
  let simBase = 0;
  let actualBase = 0;
  let sameReason = 0;
  const reasonMap: Record<string, string> = { stop: 'stop_loss', trail: 'trailing_stop', horizon: 'timeout' };
  for (const t of closedWithData) {
    const s = simulateExit(t.candles!, t.entry, t.entryAtMs, BASELINE);
    simBase += simPnlSol(s.multiple, t.size, PAPER_ASSUMED_FEES_PCT);
    actualBase += Number(t.row.pnl_sol);
    if (reasonMap[s.reason] === t.row.exit_reason) sameReason += 1;
  }
  console.log('\n=== A. Έλεγχος προσομοίωσης (σημερινοί κανόνες, fees paper 2%) ===');
  console.log(`  ${closedWithData.length} κλειστά: paper ${f(actualBase)} SOL · προσομοίωση ${f(simBase)} SOL · ίδιος λόγος εξόδου ${Math.round((100 * sameReason) / Math.max(1, closedWithData.length))}%`);
  console.log('  (η προσομοίωση είναι συντηρητική — low πριν από high — άρα αναμένεται λίγο χειρότερη από το paper)');

  // ── B. Πορεία τιμής ──────────────────────────────────────────────────────────
  const reached = withData.filter((t) => t.stats!.minutesToTrail !== null);
  const notReached = withData.filter((t) => t.stats!.minutesToTrail === null);
  console.log(`\n=== B. Πορεία τιμής (${withData.length} trades) ===`);
  console.log(`  Έφτασαν +50% μέσα σε 24h: ${reached.length} (${Math.round((100 * reached.length) / withData.length)}%) · δεν έφτασαν: ${notReached.length}`);
  const mins = reached.map((t) => t.stats!.minutesToTrail!);
  console.log(
    `  Πόσο γρήγορα έπιασαν +50%: διάμεσο ${median(mins)?.toFixed(0)}′ · p75 ${quantile(mins, 0.75)?.toFixed(0)}′ · p90 ${quantile(mins, 0.9)?.toFixed(0)}′ · ` +
      CHECKPOINTS_MIN.map((m) => `≤${m}′ ${Math.round((100 * mins.filter((x) => x <= m).length) / Math.max(1, mins.length))}%`).join(' · '),
  );
  console.log('  Πόσο βυθίστηκαν οι νικητές ΠΡΙΝ το +50% (ποσοστό νικητών που θα έκοβε κάθε stop):');
  for (const s of STOPS) {
    const cut = reached.filter((t) => t.stats!.minBeforeTrail! <= 1 - s).length;
    console.log(`    stop −${Math.round(s * 100)}%: θα έκοβε ${cut}/${reached.length} νικητές (${Math.round((100 * cut) / Math.max(1, reached.length))}%)`);
  }
  console.log('  Τα trades που ΔΕΝ έχουν πιάσει +50% ούτε −50% στο λεπτό Ν — τι γίνεται μετά;');
  console.log('    Ν      πλήθος  τιμή στο Ν (διάμεσο/μέσο)  πόσα πιάνουν αργότερα +50%  τελικό με σημερινούς κανόνες (μέσο)');
  for (const m of CHECKPOINTS_MIN) {
    const cutoff = (t: Trade) => t.entryAtMs + m * MINUTE_MS;
    const alive = withData.filter((t) => {
      const until = t.candles!.filter((c) => c.timestamp < cutoff(t));
      if (until.length === 0) return false;
      const lowest = Math.min(...until.map((c) => c.low));
      const highest = Math.max(...until.map((c) => c.high));
      return lowest > t.entry * 0.5 && highest < t.entry * 1.5 && t.stats!.at[m] !== null;
    });
    const atN = alive.map((t) => t.stats!.at[m]!);
    const later = alive.filter((t) => t.stats!.minutesToTrail !== null).length;
    const finals = alive.map((t) => simulateExit(t.candles!, t.entry, t.entryAtMs, BASELINE).multiple);
    console.log(
      `    ${String(m).padStart(3)}′  ${String(alive.length).padStart(6)}   ${pc((median(atN) ?? 1) - 1).padStart(5)} / ${pc((mean(atN) ?? 1) - 1).padStart(5)}` +
        `              ${String(later).padStart(4)} (${Math.round((100 * later) / Math.max(1, alive.length))}%)` +
        `                  ${pc((mean(finals) ?? 1) - 1)}`,
    );
  }

  // ── C. Grid εξόδων ───────────────────────────────────────────────────────────
  interface GridRow { p: ExitParams; train: number; test: number; all: number; nTrain: number; nTest: number; wins: number; perTrade: Map<string, number> }
  const grid: GridRow[] = [];
  for (const mode of MODES)
    for (const stopPct of STOPS)
      for (const timeLimitMin of LIMITS) {
        const p: ExitParams = { stopPct, timeLimitMin, mode };
        const g: GridRow = { p, train: 0, test: 0, all: 0, nTrain: 0, nTest: 0, wins: 0, perTrade: new Map() };
        for (const t of withData) {
          const pnl = simPnlSol(simulateExit(t.candles!, t.entry, t.entryAtMs, p).multiple, t.size, REAL_FEES_PCT);
          g.perTrade.set(t.row.id, pnl);
          g.all += pnl;
          if (pnl > 0) g.wins += 1;
          if (t.train) { g.train += pnl; g.nTrain += 1; } else { g.test += pnl; g.nTest += 1; }
        }
        grid.push(g);
      }
  const base = grid.find((g) => g.p.stopPct === BASELINE.stopPct && g.p.timeLimitMin === BASELINE.timeLimitMin && g.p.mode === BASELINE.mode)!;
  const byTrain = [...grid].sort((a, b) => b.train - a.train);
  const gLine = (g: GridRow) =>
    `  ${paramLabel(g.p).padEnd(36)} train ${f(g.train).padStart(7)} (${g.nTrain}) | test ${f(g.test).padStart(7)} (${g.nTest}) | όλα ${f(g.all).padStart(7)} · wins ${Math.round((100 * g.wins) / Math.max(1, withData.length))}%`;
  console.log(`\n=== C. Grid εξόδων — πραγματικά fees ${REAL_FEES_PCT * 100}% ανά γύρο · train = μέρες 1–${TRAIN_MAX_DAY}, test = μέρες ${TRAIN_MAX_DAY + 1}+ ===`);
  console.log('  ΣΗΜΕΡΙΝΟ:');
  console.log(gLine(base));
  console.log('  Τα 15 καλύτερα στο train (το test λέει αν κρατάει σε μέρες που δεν «είδαμε»):');
  for (const g of byTrain.slice(0, 15)) console.log(gLine(g));
  console.log('  Το καλύτερο ανά τρόπο εξόδου (στο train):');
  for (const mode of MODES) console.log(gLine(byTrain.find((g) => g.p.mode === mode)!));
  const best = byTrain[0]!;
  const gates = [...new Set(withData.map((t) => String(t.row.entry_timing_json?.gate_source ?? '?')))];
  console.log('  Ανά gate (σημερινό → καλύτερο του train):');
  for (const gate of gates) {
    const ids = withData.filter((t) => String(t.row.entry_timing_json?.gate_source ?? '?') === gate);
    const sum = (g: GridRow) => ids.reduce((s, t) => s + g.perTrade.get(t.row.id)!, 0);
    console.log(`    ${gate.padEnd(10)} ${String(ids.length).padStart(4)} trades: ${f(sum(base))} → ${f(sum(best))} SOL`);
  }

  // ── D. Φίλτρα εισόδου ────────────────────────────────────────────────────────
  // Μετράμε με δύο τρόπους: πραγματικό paper (διορθωμένο σε πραγματικά fees) και με το
  // καλύτερο σετ εξόδων του train — ένα φίλτρο αξίζει αν βοηθάει ΚΑΙ μετά τη διόρθωση εξόδων.
  const bestPnl = (t: Trade) => best.perTrade.get(t.row.id) ?? null;
  type Bucketer = (t: Trade) => string | null;
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const bucket = (v: number | null, edges: number[], labels: string[]) => {
    if (v === null || !Number.isFinite(v)) return null;
    for (let i = 0; i < edges.length; i += 1) if (v < edges[i]!) return labels[i]!;
    return labels[edges.length]!;
  };
  const dims: [string, Bucketer][] = [
    ['gate', (t) => String(t.row.entry_timing_json?.gate_source ?? '?') + (t.row.entry_timing_json?.graduated ? ' (graduated)' : '')],
    ['mcap εισόδου (SOL)', (t) => bucket(num(t.row.entry_timing_json?.signal?.mcap_sol), [50, 100, 200, 400], ['<50', '50–100', '100–200', '200–400', '400+'])],
    ['αγορά του wallet (SOL)', (t) => bucket(num(t.row.entry_timing_json?.signal?.sol_amount), [0.3, 1, 3], ['<0.3', '0.3–1', '1–3', '3+'])],
    ['ώρα εισόδου (UTC)', (t) => { const h = t.row.entry_at.getUTCHours(); return `${String(h - (h % 4)).padStart(2, '0')}–${String(h - (h % 4) + 4).padStart(2, '0')}`; }],
    ['holder risk', (t) => bucket(num(t.row.entry_timing_json?.holder_risk?.pct), [0.25, 0.5], ['<25%', '25–50%', '50%+'])],
    ['wallet: αριθμός trades', (t) => bucket(t.row.trade_count, [300, 2000], ['<300', '300–2000', '2000+'])],
    ['wallet: μέσος χρόνος κράτησης', (t) => bucket(num(t.row.avg_holding_sec), [60, 600, 3600, 86400], ['<1′', '1–10′', '10–60′', '1–24h', '1 μέρα+'])],
    ['wallet: win rate', (t) => bucket(num(t.row.win_rate), [0.3, 0.5, 0.7], ['<30%', '30–50%', '50–70%', '70%+'])],
    ['wallet: πηγή', (t) => t.row.source ?? '(εκτός watchlist)'],
  ];
  console.log('\n=== D. Φίλτρα εισόδου — ανά trade, SOL (paper με πραγματικά fees | με το καλύτερο σετ εξόδων) ===');
  console.log('  κουβάς              trades  paper/trade  train  test  | καλύτερες έξοδοι/trade  train  test');
  for (const [title, fn] of dims) {
    const groups = new Map<string, Trade[]>();
    for (const t of trades) {
      const k = fn(t);
      if (k === null) continue;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    if (groups.size === 0) continue;
    console.log(`  ${title}:`);
    // Σειρά κουβάδων: με το αριθμητικό τους όριο ('<50' πρώτο), αλλιώς αλφαβητικά.
    const rank = (k: string) => (k.startsWith('<') ? -1 : Number.parseFloat(k.replace(',', '.')));
    const order = (a: string, b: string) => {
      const ra = rank(a);
      const rb = rank(b);
      return Number.isFinite(ra) && Number.isFinite(rb) ? ra - rb || a.localeCompare(b) : a.localeCompare(b);
    };
    for (const [k, ts] of [...groups.entries()].sort((a, b) => order(a[0], b[0]))) {
      const avg = (list: Trade[], g: (t: Trade) => number | null) => mean(list.map(g).filter((v): v is number => v !== null));
      const a = avg(ts, (t) => t.actualReal);
      const at = avg(ts.filter((t) => t.train), (t) => t.actualReal);
      const ae = avg(ts.filter((t) => !t.train), (t) => t.actualReal);
      const b = avg(ts, bestPnl);
      const bt = avg(ts.filter((t) => t.train), bestPnl);
      const be = avg(ts.filter((t) => !t.train), bestPnl);
      const s = (v: number | null) => (v === null ? '     —' : f(v, 4).padStart(7));
      console.log(`    ${k.padEnd(18)} ${String(ts.length).padStart(5)}  ${s(a)} ${s(at)} ${s(ae)}  | ${s(b)} ${s(bt)} ${s(be)}`);
    }
  }

  // ── E. Ανά wallet ────────────────────────────────────────────────────────────
  const byWallet = new Map<string, Trade[]>();
  for (const t of trades) {
    const w = t.row.trigger_wallet_address ?? '(χωρίς wallet)';
    byWallet.set(w, [...(byWallet.get(w) ?? []), t]);
  }
  const sumOf = (ts: Trade[]) => ts.reduce((s, t) => s + (t.actualReal ?? 0), 0);
  const walletRows = [...byWallet.entries()]
    .map(([address, ts]) => ({ address, ts, sum: sumOf(ts), train: sumOf(ts.filter((t) => t.train)), test: sumOf(ts.filter((t) => !t.train)), nTrain: ts.filter((t) => t.train).length, nTest: ts.filter((t) => !t.train).length }))
    .filter((w) => w.ts.length >= 3)
    .sort((a, b) => a.sum - b.sum);
  const holdLabel = (s: string | null) => {
    if (s === null) return '—';
    const v = Number(s);
    return v < 60 ? `${v.toFixed(0)}s` : v < 3600 ? `${(v / 60).toFixed(0)}′` : `${(v / 3600).toFixed(1)}h`;
  };
  console.log(`\n=== E. Ανά wallet που έδωσε το σήμα (≥3 trades, paper με πραγματικά fees) — ${walletRows.length} wallets ===`);
  console.log('  wallet     όνομα           trades  σύνολο   train(n)        test(n)        | trades GMGN  κράτηση  win   ενεργό');
  for (const w of walletRows) {
    const r = w.ts[0]!.row;
    console.log(
      `  ${w.address.slice(0, 8)}  ${(r.name ?? '—').slice(0, 14).padEnd(14)}  ${String(w.ts.length).padStart(5)}  ${f(w.sum).padStart(7)}  ${f(w.train).padStart(7)}(${String(w.nTrain).padStart(2)})  ${f(w.test).padStart(7)}(${String(w.nTest).padStart(2)})` +
        `  | ${String(r.trade_count ?? '—').padStart(6)}  ${holdLabel(r.avg_holding_sec).padStart(7)}  ${r.win_rate === null ? '  —' : pc(Number(r.win_rate)).padStart(4)}  ${r.active === null ? '—' : r.active ? 'ναι' : 'όχι'}`,
    );
  }
  // Σταθερά αρνητικά: αρνητικά ΚΑΙ στο train ΚΑΙ στο test (όπου υπάρχουν και τα δύο), ή ≥5 trades
  // με σύνολο ≤ −0.05 SOL όταν υπάρχει μόνο το ένα κομμάτι.
  const losers = walletRows.filter((w) => {
    if (w.address === '(χωρίς wallet)' || w.ts[0]!.row.active === false) return false;
    if (w.nTrain >= 2 && w.nTest >= 2) return w.train < 0 && w.test < 0;
    return w.ts.length >= 5 && w.sum <= -0.05;
  });
  const winners = walletRows.filter((w) => w.nTrain >= 2 && w.nTest >= 2 && w.train > 0 && w.test > 0);
  console.log(`\n  Σταθερά αρνητικά (ενεργά): ${losers.length} wallets, σύνολο ${f(losers.reduce((s, w) => s + w.sum, 0))} SOL σε ${losers.reduce((s, w) => s + w.ts.length, 0)} trades`);
  for (const w of losers) console.log(`    /unwatch ${w.address}   # ${w.ts[0]!.row.name ?? ''} ${f(w.sum)} SOL σε ${w.ts.length}`);
  console.log(`  Σταθερά θετικά: ${winners.length} wallets, σύνολο ${f(winners.reduce((s, w) => s + w.sum, 0))} SOL σε ${winners.reduce((s, w) => s + w.ts.length, 0)} trades`);
  for (const w of winners) console.log(`    ${w.address}   # ${w.ts[0]!.row.name ?? ''} ${f(w.sum)} SOL σε ${w.ts.length}`);
  console.log('\n  Σημ.: ΤΙΠΟΤΑ δεν αλλάζει αυτόματα — οι /unwatch εντολές είναι προτάσεις για το Telegram.');
} finally {
  await closePool();
}
process.exit(0);

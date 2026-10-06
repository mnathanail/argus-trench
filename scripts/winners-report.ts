import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { GmgnRateLimitError } from '../src/gmgn/errors.js';
import { runCli } from '../src/gmgn/exec.js';
import type { RouteKey } from '../src/gmgn/routes.js';
import { delay } from '../src/util/delay.js';

/**
 * 2026-10-06 (αίτημα χρήστη): «ποια coins έκαναν τη διαφορά, ποιος τα έφτιαξε, ποιοι
 * έβγαλαν πολλά ×» — read-only report από το GMGN.
 *
 *   railway run npm run winners-report [-- --hours 48 --top 20 --min-ath 300000 --traders 15]
 *
 * 1. Τα Pump.fun tokens που δημιουργήθηκαν τις τελευταίες N ώρες, ταξινομημένα κατά ATH
 *    market cap (market trending 24h, ATH ≥ min). Κρατάμε τα top Ν.
 * 2. Για καθένα: ο dev (πόσα tokens έχει φτιάξει, πόσα έκαναν graduation, καλύτερο ATH) και
 *    οι top traders κατά κέρδος — ×, $ κέρδος, πότε μπήκαν (λεπτά μετά τη δημιουργία), σε τι
 *    market cap, αν κρατάνε ακόμα, ετικέτες GMGN, από πού χρηματοδοτήθηκε το wallet.
 * 3. Διασταύρωση: wallets σε ≥2 νικητές, κοινές πηγές χρηματοδότησης, devs με ≥2 νικητές,
 *    και ποια είναι ΗΔΗ στη watchlist μας.
 *
 * GMGN calls: 1 + top×2 (traders weight 5, created-tokens weight 2). Αργό βήμα (1.5″) και σε
 * ban περιμένει τη λήξη του — μοιράζεται το IP με το bot.
 */

const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const HOURS = arg('hours', 48);
const TOP = arg('top', 20);
const MIN_ATH = arg('min-ath', 300_000);
const TRADERS_SHOWN = arg('traders', 15);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const short = (a: string | null) => (a === null ? '—' : a.slice(0, 8));
const usd = (v: number | null) =>
  v === null ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`;

/** Βρίσκει τον πρώτο πίνακα κάτω από data/list/rank/tokens (τα σχήματα του CLI διαφέρουν). */
function findList(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  const data = raw['data'];
  if (Array.isArray(data)) return data;
  for (const c of [isObj(data) ? data : null, raw]) {
    if (c === null) continue;
    for (const k of keys) if (Array.isArray(c[k])) return c[k] as unknown[];
  }
  return [];
}

async function gmgn(label: RouteKey, cliArgs: string[]): Promise<unknown | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const raw = await runCli(label, cliArgs);
      await delay(1_500);
      return raw;
    } catch (error) {
      if (error instanceof GmgnRateLimitError) {
        const m = /resets at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(error.output);
        const until = error.retryAt?.getTime() ?? (m ? Date.parse(`${m[1]!.replace(' ', 'T')}Z`) : Number.NaN);
        const wait = Math.min(Math.max(Number.isFinite(until) ? until - Date.now() + 5_000 : 60_000, 10_000), 5 * 60_000);
        console.log(`  GMGN rate limit — περιμένω ${Math.round(wait / 1000)}″`);
        await delay(wait);
        continue;
      }
      console.log(`  ${label} απέτυχε: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
      return null;
    }
  }
  return null;
}

interface Winner {
  address: string;
  symbol: string;
  name: string;
  creator: string | null;
  createdAt: number | null;
  ath: number | null;
  mcap: number | null;
  supply: number;
}
interface Trader {
  token: Winner;
  wallet: string;
  multiple: number | null;
  profit: number | null;
  cost: number | null;
  entryMin: number | null;
  entryMcap: number | null;
  soldPct: number | null;
  tags: string[];
  funder: string | null;
}

const pool = getPool();
try {
  // ── 1. Νικητές ─────────────────────────────────────────────────────────────
  const raw = await gmgn('market trending', [
    'market', 'trending', '--chain', 'sol', '--interval', '24h',
    '--platform', 'Pump.fun',
    '--max-created', `${HOURS}h`,
    '--min-history-highest-marketcap', String(MIN_ATH),
    '--order-by', 'history_highest_market_cap', '--direction', 'desc',
    '--limit', '100',
  ]);
  const winners: Winner[] = findList(raw, ['rank', 'list'])
    .filter(isObj)
    .map((r) => ({
      address: str(r['address']) ?? '',
      symbol: str(r['symbol']) ?? '?',
      name: str(r['name']) ?? '',
      creator: str(r['creator']),
      createdAt: num(r['creation_timestamp']),
      ath: num(r['history_highest_market_cap']),
      mcap: num(r['market_cap']),
      supply: num(r['total_supply']) ?? 1e9,
    }))
    .filter((w) => w.address !== '')
    .sort((a, b) => (b.ath ?? 0) - (a.ath ?? 0))
    .slice(0, TOP);
  const nowSec = Date.now() / 1000;
  console.log(`\n=== Νικητές: Pump.fun, δημιουργία τις τελευταίες ${HOURS}h, ATH ≥ ${usd(MIN_ATH)} — top ${winners.length} ===`);
  if (winners.length === 0) {
    console.log('  Κανένα token (ή το GMGN δεν απάντησε).');
  }

  // Watchlist για διασταύρωση.
  const { rows: wl } = await pool.query<{ address: string; name: string | null; active: boolean; copy_mode: string | null }>(
    `SELECT address, name, active, copy_mode FROM watchlist_wallets`,
  );
  const watch = new Map(wl.map((w) => [w.address, w]));
  const watchLabel = (a: string) => {
    const w = watch.get(a);
    if (!w) return '';
    return ` ★WATCHLIST${w.name ? `:${w.name}` : ''}${w.active ? '' : '(ανενεργό)'}${w.copy_mode === 'mirror' ? '(mirror)' : ''}`;
  };

  // ── 2. Ανά νικητή: dev + top traders ──────────────────────────────────────
  const allTraders: Trader[] = [];
  const devInfo = new Map<string, { total: number | null; migrated: number | null; bestAth: number | null; bestSymbol: string | null }>();
  for (const [i, w] of winners.entries()) {
    const age = w.createdAt === null ? '—' : `${((nowSec - w.createdAt) / 3600).toFixed(1)}h`;
    console.log(
      `\n#${i + 1} ${w.symbol} (${w.name.slice(0, 24)}) ${w.address}\n` +
        `   ATH ${usd(w.ath)} · τώρα ${usd(w.mcap)} (${w.ath && w.mcap ? `${Math.round((100 * w.mcap) / w.ath)}% του ATH` : '—'}) · ηλικία ${age}`,
    );

    if (w.creator !== null && !devInfo.has(w.creator)) {
      const d = await gmgn('portfolio created-tokens', ['portfolio', 'created-tokens', '--chain', 'sol', '--wallet', w.creator]);
      const data = isObj(d) && isObj(d['data']) ? (d['data'] as Obj) : isObj(d) ? d : {};
      const inner = num(data['inner_count']);
      const open = num(data['open_count']);
      const ath = isObj(data['creator_ath_info']) ? (data['creator_ath_info'] as Obj) : {};
      devInfo.set(w.creator, {
        total: inner === null && open === null ? null : (inner ?? 0) + (open ?? 0),
        migrated: open,
        bestAth: num(ath['ath_mc']),
        bestSymbol: str(ath['token_symbol']),
      });
    }
    const dev = w.creator === null ? undefined : devInfo.get(w.creator);
    console.log(
      `   dev ${w.creator ?? '—'}${w.creator ? watchLabel(w.creator) : ''}: ` +
        (dev ? `${dev.total ?? '?'} tokens, ${dev.migrated ?? '?'} graduated, καλύτερο ATH ${usd(dev.bestAth)} (${dev.bestSymbol ?? '?'})` : '—'),
    );

    const t = await gmgn('token traders', [
      'token', 'traders', '--chain', 'sol', '--address', w.address, '--order-by', 'profit', '--direction', 'desc', '--limit', '100',
    ]);
    const traders: Trader[] = findList(t, ['list'])
      .filter(isObj)
      .filter((r) => num(r['addr_type']) !== 2) // όχι pools/exchanges
      .map((r) => {
        const cost = num(r['total_cost']) ?? num(r['history_bought_cost']);
        const pc = num(r['profit_change']);
        const start = num(r['start_holding_at']);
        const avgCost = num(r['avg_cost']);
        const nt = isObj(r['native_transfer']) ? (r['native_transfer'] as Obj) : {};
        return {
          token: w,
          wallet: str(r['address']) ?? '',
          multiple: pc === null ? null : 1 + pc,
          profit: num(r['profit']),
          cost,
          entryMin: start !== null && w.createdAt !== null ? (start - w.createdAt) / 60 : null,
          entryMcap: avgCost !== null ? avgCost * w.supply : null,
          soldPct: num(r['sell_amount_percentage']),
          tags: [...new Set([...strs(r['tags']), ...strs(r['maker_token_tags'])])],
          funder: str(nt['address']),
        };
      })
      .filter((x) => x.wallet !== '');
    allTraders.push(...traders);
    console.log(`   top traders κατά κέρδος (${traders.length} συνολικά):`);
    console.log('     wallet     ×       κέρδος    μπήκε με   μπήκε (μετά τη δημιουργία, mcap)   πούλησε  ετικέτες / χρηματοδότηση');
    for (const x of traders.slice(0, TRADERS_SHOWN)) {
      const entry = x.entryMin === null ? '—' : x.entryMin < 1 ? `${Math.round(x.entryMin * 60)}″` : x.entryMin < 120 ? `${x.entryMin.toFixed(0)}′` : `${(x.entryMin / 60).toFixed(1)}h`;
      console.log(
        `     ${short(x.wallet)}  ${x.multiple === null ? '  —  ' : `${x.multiple.toFixed(1)}×`.padStart(6)}  ${usd(x.profit).padStart(8)}  ${usd(x.cost).padStart(8)}   ` +
          `${entry.padStart(6)}, ${usd(x.entryMcap).padStart(7)}                 ${x.soldPct === null ? '—' : `${Math.round(x.soldPct * 100)}%`.padStart(4)}   ` +
          `${x.tags.join(',') || '—'} · από ${short(x.funder)}${watchLabel(x.wallet)}`,
      );
    }
  }

  // ── 3. Διασταύρωση ───────────────────────────────────────────────────────
  // «Κερδισμένος» trader = ≥2× και ≥ $100 κέρδος (όχι σκόνη).
  const good = allTraders.filter((x) => (x.multiple ?? 0) >= 2 && (x.profit ?? 0) >= 100);
  const byWallet = new Map<string, Trader[]>();
  for (const x of good) byWallet.set(x.wallet, [...(byWallet.get(x.wallet) ?? []), x]);
  const repeat = [...byWallet.entries()].filter(([, xs]) => new Set(xs.map((x) => x.token.address)).size >= 2)
    .sort((a, b) => b[1].length - a[1].length || b[1].reduce((s, x) => s + (x.profit ?? 0), 0) - a[1].reduce((s, x) => s + (x.profit ?? 0), 0));
  console.log(`\n=== Wallets με ≥2× σε 2+ από αυτούς τους νικητές (${repeat.length}) ===`);
  for (const [wallet, xs] of repeat.slice(0, 40)) {
    const tags = [...new Set(xs.flatMap((x) => x.tags))];
    const entries = xs.map((x) => `${x.token.symbol} ${x.multiple?.toFixed(1)}× (${x.entryMin === null ? '—' : `${x.entryMin.toFixed(0)}′`}, ${usd(x.entryMcap)})`).join(' · ');
    console.log(`  ${wallet}  σε ${xs.length}: ${entries} · κέρδος ${usd(xs.reduce((s, x) => s + (x.profit ?? 0), 0))} · ${tags.join(',') || '—'}${watchLabel(wallet)}`);
  }

  const byFunder = new Map<string, Set<string>>();
  const funderTokens = new Map<string, Set<string>>();
  for (const x of good) {
    if (x.funder === null) continue;
    byFunder.set(x.funder, (byFunder.get(x.funder) ?? new Set()).add(x.wallet));
    funderTokens.set(x.funder, (funderTokens.get(x.funder) ?? new Set()).add(x.token.symbol));
  }
  const groups = [...byFunder.entries()].filter(([, ws]) => ws.size >= 2).sort((a, b) => b[1].size - a[1].size);
  console.log(`\n=== Κοινή χρηματοδότηση: ≥2 κερδισμένα wallets από την ίδια πηγή (${groups.length}) ===`);
  console.log('  (πολλές «πηγές» είναι ανταλλακτήρια — μεγάλες ομάδες σε πολλά tokens = πιθανό CEX, όχι ομάδα)');
  for (const [funder, ws] of groups.slice(0, 25)) {
    console.log(`  ${funder}: ${ws.size} wallets σε ${[...funderTokens.get(funder)!].join(', ')}${watchLabel(funder)}`);
  }

  const byDev = new Map<string, Winner[]>();
  for (const w of winners) if (w.creator) byDev.set(w.creator, [...(byDev.get(w.creator) ?? []), w]);
  const multiDev = [...byDev.entries()].filter(([, ws]) => ws.length >= 2);
  console.log(`\n=== Devs με 2+ από αυτούς τους νικητές (${multiDev.length}) ===`);
  for (const [dev, ws] of multiDev) console.log(`  ${dev}: ${ws.map((w) => `${w.symbol} ${usd(w.ath)}`).join(', ')}`);

  const ours = [...new Set(allTraders.filter((x) => watch.has(x.wallet)).map((x) => x.wallet))];
  console.log(`\n=== Wallets της watchlist μας ανάμεσα στους traders αυτών των νικητών (${ours.length}) ===`);
  for (const wallet of ours) {
    const xs = allTraders.filter((x) => x.wallet === wallet);
    console.log(`  ${wallet}${watchLabel(wallet)}: ${xs.map((x) => `${x.token.symbol} ${x.multiple === null ? '—' : `${x.multiple.toFixed(1)}×`} (μπήκε ${x.entryMin === null ? '—' : `${x.entryMin.toFixed(0)}′`})`).join(' · ')}`);
  }

  // Πόσο «πιάσιμοι» ήταν: σε τι mcap και πότε μπήκαν όσοι έβγαλαν ≥10×.
  const tenX = good.filter((x) => (x.multiple ?? 0) >= 10 && x.entryMin !== null);
  if (tenX.length > 0) {
    const sortedMin = tenX.map((x) => x.entryMin!).sort((a, b) => a - b);
    const sortedMc = tenX.map((x) => x.entryMcap).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
    console.log(`\n=== Όσοι έβγαλαν ≥10× (${tenX.length}): πότε και σε τι mcap μπήκαν ===`);
    console.log(`  λεπτά μετά τη δημιουργία: διάμεσο ${q(sortedMin, 0.5).toFixed(1)}′ · p25 ${q(sortedMin, 0.25).toFixed(1)}′ · p75 ${q(sortedMin, 0.75).toFixed(1)}′`);
    if (sortedMc.length > 0) console.log(`  mcap εισόδου: διάμεσο ${usd(q(sortedMc, 0.5))} · p25 ${usd(q(sortedMc, 0.25))} · p75 ${usd(q(sortedMc, 0.75))}`);
    const tagCount = new Map<string, number>();
    for (const x of tenX) for (const tag of x.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    console.log(`  ετικέτες: ${[...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
  }
  console.log('\nΣημ.: × = (κέρδος + κόστος) / κόστος κατά GMGN (μαζί με μη πραγματοποιημένο). mcap εισόδου = μέση τιμή αγοράς × supply.');
} finally {
  await closePool();
}
process.exit(0);

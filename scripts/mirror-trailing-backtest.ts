import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { anchorCandlesToEntryPrice, resolveExit } from '../src/collectors/exitResolver.js';
import { PAPER_ASSUMED_FEES_PCT } from '../src/decision/paperTradingConfig.js';
import { rethrowIfRateLimited } from '../src/gmgn/errors.js';
import { fetchKline } from '../src/gmgn/kline.js';
import { mirrorPnl } from '../src/mirror/mirrorDecision.js';
import { delay } from '../src/util/delay.js';

/**
 * MIRROR — «τι θα έβγαινε με trailing;» (2026-09-30, αίτημα χρήστη).
 *
 *   railway run npx tsx scripts/mirror-trailing-backtest.ts [days=7]
 *
 * Για κάθε mirror θέση: είσοδος στην τιμή της ΠΡΩΤΗΣ αγοράς (0.1 SOL, χωρίς τις επόμενες
 * αγορές), έξοδος με τους κανόνες του κανονικού argus (trailing +50%/−25%, floor +10%,
 * stop-loss −50%, 24h timeout) πάνω σε 1m candles του GMGN (USD, αγκυρωμένα στην τιμή
 * εισόδου — ίδια μέθοδος με τον exit-resolver). Δίπλα: τι βγήκε ακολουθώντας το wallet.
 * Προσοχή: candles 1 λεπτού — μέσα στο λεπτό δεν ξέρουμε τη σειρά high/low.
 */

const days = Number(process.argv[2] ?? 7);
const BASE_SOL = 0.1;
const pool = getPool();

interface Row {
  id: string;
  name: string | null;
  token_address: string;
  status: string;
  opened_at: Date;
  closed_at: Date | null;
  sol_in: string;
  pnl_sol: string | null;
  pnl_pct: string | null;
  buy_count: number;
  entry_price: string | null;
}

try {
  const { rows } = await pool.query<Row>(
    `SELECT p.id, w.name, p.token_address, p.status, p.opened_at, p.closed_at, p.sol_in, p.pnl_sol, p.pnl_pct, p.buy_count,
            (SELECT COALESCE((e.detail_json->>'fill_price')::numeric, e.price_sol)
               FROM mirror_events e
              WHERE e.position_id = p.id AND e.action = 'buy_open'
              ORDER BY e.id LIMIT 1) AS entry_price
       FROM mirror_positions p
       LEFT JOIN watchlist_wallets w ON w.address = p.wallet_address
      WHERE p.opened_at >= now() - make_interval(days => $1)
      ORDER BY p.opened_at`,
    [days],
  );
  console.log(`\n=== Mirror θέσεις ${days} ημερών: ακολουθώντας το wallet vs trailing (1η αγορά, ${BASE_SOL} SOL) ===`);
  let sumActual = 0;
  let sumTrail = 0;
  let nTrail = 0;
  let trailWins = 0;
  let actualWins = 0;
  let nActual = 0;
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const entry = r.entry_price === null ? null : Number(r.entry_price);
    const label = `${(r.name ?? '?').padEnd(12)} ${r.token_address.slice(0, 8)} ${r.opened_at.toISOString().slice(5, 16).replace('T', ' ')}`;
    const actual =
      r.status === 'closed' && r.pnl_sol !== null
        ? `wallet: ${Number(r.pnl_sol) >= 0 ? '+' : ''}${Number(r.pnl_sol).toFixed(4)} SOL (${(Number(r.pnl_pct ?? 0) * 100).toFixed(1)}%, αγορές ${r.buy_count}, μέσα ${Number(r.sol_in).toFixed(2)})`
        : 'wallet: ανοιχτή';
    if (entry === null || !(entry > 0)) {
      console.log(`  ${label}  ${actual}  | trailing: — (χωρίς τιμή εισόδου)`);
      continue;
    }
    const now = new Date();
    const entryAt = r.opened_at;
    const to = Math.min(entryAt.getTime() + 24 * 3600_000, now.getTime());
    let candles;
    try {
      candles = await fetchKline({ chain: 'sol', tokenAddress: r.token_address, from: Math.floor(entryAt.getTime() / 1000) - 120, to: Math.floor(to / 1000), resolution: '1m' });
    } catch (error) {
      rethrowIfRateLimited(error);
      console.log(`  ${label}  ${actual}  | trailing: — (kline: ${error instanceof Error ? error.message.slice(0, 80) : String(error)})`);
      continue;
    }
    await delay(400);
    const anchored = anchorCandlesToEntryPrice([...candles].sort((a, b) => a.timestamp - b.timestamp), entry, entryAt);
    if (anchored.length === 0) {
      console.log(`  ${label}  ${actual}  | trailing: — (χωρίς candles)`);
      continue;
    }
    const exit = resolveExit({ entryPrice: entry, entryAt, candles: anchored, walletSellAt: null, now });
    let exitPrice: number;
    let reason: string;
    if (exit === null) {
      const last = anchored.filter((c) => c.timestamp >= entryAt.getTime() - 60_000).at(-1) ?? anchored.at(-1)!;
      exitPrice = last.close;
      reason = 'ακόμα μέσα (τρέχουσα)';
    } else {
      exitPrice = exit.exitPrice;
      reason = exit.exitReason;
    }
    const { pnlSol } = mirrorPnl(BASE_SOL, (BASE_SOL * exitPrice) / entry, PAPER_ASSUMED_FEES_PCT);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    nTrail += 1;
    sumTrail += pnlSol;
    if (pnlSol > 0) trailWins += 1;
    if (r.status === 'closed' && r.pnl_sol !== null) {
      nActual += 1;
      sumActual += Number(r.pnl_sol);
      if (Number(r.pnl_sol) > 0) actualWins += 1;
    }
    console.log(
      `  ${label}  ${actual}  | trailing: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${((exitPrice / entry - 1) * 100).toFixed(1)}%, ${reason})`,
    );
  }
  console.log('\n--- Σύνοψη ---');
  console.log(`  ακολουθώντας το wallet: ${nActual} κλειστές, wins ${actualWins}, σύνολο ${sumActual >= 0 ? '+' : ''}${sumActual.toFixed(4)} SOL (με όλες τις αγορές του)`);
  console.log(`  trailing (1η αγορά):    ${nTrail} θέσεις, wins ${trailWins}, σύνολο ${sumTrail >= 0 ? '+' : ''}${sumTrail.toFixed(4)} SOL (${BASE_SOL} SOL η καθεμία)`);
  console.log(`  έξοδοι trailing: ${JSON.stringify(Object.fromEntries(reasons))}`);
  console.log('  (Τα ποσά δεν είναι ίδιου μεγέθους: το wallet-mirror βάζει 0.1 SOL σε ΚΑΘΕ αγορά του.)');
} finally {
  await closePool();
}

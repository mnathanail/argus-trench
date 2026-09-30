import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση: railway run npm run mirror-report [-- <μέρες=7>]
//
// 2026-09-30 — MIRROR route (paper): αποτελέσματα ανά mirror wallet, τι έγινε με κάθε event
// του (αγορές/πωλήσεις που αντιγράψαμε, τι αγνοήθηκε και γιατί) και οι ανοιχτές θέσεις.
// Read-only.

const days = Number(process.argv[2] ?? 7);
const pool = getPool();
const sol = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`;
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

try {
  const since = `now() - make_interval(days => $1)`;
  const { rows: wallets } = await pool.query<{
    address: string; name: string | null; copy_mode: string; closed: string; wins: string; open: string;
    pnl: string | null; sol_in: string | null; avg_pct: string | null;
  }>(
    `SELECT p.wallet_address AS address, w.name, COALESCE(w.copy_mode, '?') AS copy_mode,
            count(*) FILTER (WHERE p.status = 'closed')                    AS closed,
            count(*) FILTER (WHERE p.status = 'closed' AND p.pnl_sol > 0)   AS wins,
            count(*) FILTER (WHERE p.status = 'open')                      AS open,
            sum(p.pnl_sol) FILTER (WHERE p.status = 'closed')              AS pnl,
            sum(p.sol_in) FILTER (WHERE p.status = 'closed')               AS sol_in,
            avg(p.pnl_pct) FILTER (WHERE p.status = 'closed')              AS avg_pct
       FROM mirror_positions p
       LEFT JOIN watchlist_wallets w ON w.address = p.wallet_address
      WHERE p.opened_at >= ${since}
      GROUP BY 1, 2, 3
      ORDER BY 1`,
    [days],
  );
  console.log(`\n=== MIRROR (paper) — θέσεις των τελευταίων ${days} ημερών ===`);
  if (wallets.length === 0) console.log('  Καμία θέση ακόμα.');
  for (const w of wallets) {
    const closed = Number(w.closed);
    console.log(
      `  ${(w.name ?? w.address.slice(0, 8)).padEnd(16)} [${w.copy_mode}] κλειστές ${String(closed).padEnd(4)} ` +
        `win ${closed > 0 ? `${Math.round((Number(w.wins) / closed) * 100)}%` : '—'}  μέσο ${pct(w.avg_pct === null ? null : Number(w.avg_pct))}  ` +
        `σύνολο ${sol(w.pnl === null ? 0 : Number(w.pnl))} (επένδυση ${Number(w.sol_in ?? 0).toFixed(2)} SOL)  ανοιχτές ${w.open}`,
    );
  }

  const { rows: actions } = await pool.query<{ name: string | null; address: string; action: string; n: string }>(
    `SELECT w.name, e.wallet_address AS address, e.action, count(*) AS n
       FROM mirror_events e
       LEFT JOIN watchlist_wallets w ON w.address = e.wallet_address
      WHERE e.received_at >= ${since}
      GROUP BY 1, 2, 3
      ORDER BY 2, 4 DESC`,
    [days],
  );
  console.log('\n=== Events ανά wallet: τι κάναμε ===');
  let current = '';
  for (const a of actions) {
    if (a.address !== current) {
      current = a.address;
      console.log(`  ${a.name ?? a.address.slice(0, 8)}:`);
    }
    console.log(`    ${String(a.n).padStart(5)}  ${a.action}`);
  }

  const { rows: open } = await pool.query<{
    name: string | null; token_address: string; opened_at: Date; sol_in: string; sol_out: string; buy_count: number; sell_count: number;
    tokens_held: string; last_price_sol: string | null;
  }>(
    `SELECT w.name, p.token_address, p.opened_at, p.sol_in, p.sol_out, p.buy_count, p.sell_count, p.tokens_held, p.last_price_sol
       FROM mirror_positions p
       LEFT JOIN watchlist_wallets w ON w.address = p.wallet_address
      WHERE p.status = 'open'
      ORDER BY p.opened_at`,
  );
  if (open.length > 0) {
    console.log(`\n=== Ανοιχτές θέσεις (${open.length}) — τρέχουσα αξία με την τελευταία τιμή που είδαμε ===`);
    for (const o of open) {
      const value = Number(o.tokens_held) * Number(o.last_price_sol ?? 0);
      const unreal = Number(o.sol_out) + value - Number(o.sol_in);
      console.log(
        `  ${(o.name ?? '?').padEnd(14)} ${o.token_address.slice(0, 8)} από ${o.opened_at.toISOString().slice(5, 16).replace('T', ' ')} ` +
          `αγορές ${o.buy_count} πωλήσεις ${o.sell_count}  μέσα ${Number(o.sol_in).toFixed(2)} SOL  ≈ ${sol(unreal)}`,
      );
    }
  }
} finally {
  await closePool();
}

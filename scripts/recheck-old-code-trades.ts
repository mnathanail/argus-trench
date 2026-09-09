import 'dotenv/config';
import { Client } from 'pg';
import { fetchKline } from '../src/gmgn/kline.js';
import { fetchWalletSells } from '../src/gmgn/activity.js';
import { resolveExit } from '../src/collectors/exitResolver.js';

const TRADE_IDS = [868, 869, 872, 877, 878, 881, 882, 883];

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set it in the shell or .env before running this script.');
}

const client = new Client({ connectionString: DATABASE_URL });

interface Row {
  id: number;
  token_address: string;
  entry_at: Date;
  simulated_entry_price: string;
  exit_reason: string | null;
  pnl_pct: string | null;
  trigger_wallet_address: string | null;
}

try {
  await client.connect();

  const { rows } = await client.query<Row>(
    `SELECT pt.id, pt.token_address, pt.entry_at, pt.simulated_entry_price,
            pt.exit_reason, pt.pnl_pct, dl.trigger_wallet_address
       FROM paper_trades pt
       JOIN decision_log dl ON dl.id = pt.decision_log_id
      WHERE pt.id = ANY($1)
      ORDER BY pt.id`,
    [TRADE_IDS],
  );

  console.log(`Βρέθηκαν ${rows.length}/${TRADE_IDS.length} από τα ζητούμενα IDs.\n`);

  for (const row of rows) {
    const entryPrice = Number(row.simulated_entry_price);
    const fromSeconds = Math.floor(row.entry_at.getTime() / 1000);

    const rawCandles = await fetchKline({ tokenAddress: row.token_address, from: fromSeconds });
    const candles = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

    let walletSellAt: Date | null = null;
    if (row.trigger_wallet_address !== null) {
      const sells = await fetchWalletSells(row.trigger_wallet_address, {
        stopAtTimestamp: row.entry_at.getTime(),
      });
      const afterEntry = sells.activities
        .filter((s) => s.tokenAddress === row.token_address)
        .find((s) => s.timestamp * 1000 >= row.entry_at.getTime());
      walletSellAt = afterEntry ? new Date(afterEntry.timestamp * 1000) : null;
    }

    const recomputed = resolveExit({
      entryPrice,
      entryAt: row.entry_at,
      candles,
      walletSellAt,
      now: new Date(),
    });

    const oldPnl = row.pnl_pct === null ? 'NULL' : `${(Number(row.pnl_pct) * 100).toFixed(2)}%`;
    const newPnl =
      recomputed === null
        ? '(θα έμενε ανοιχτό?!)'
        : recomputed.exitReason === 'no_market_data'
          ? 'NULL'
          : `${(((recomputed.exitPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%`;

    const changed = row.exit_reason !== (recomputed?.exitReason ?? null) || oldPnl !== newPnl;
    console.log(
      `#${row.id} ${row.token_address}\n` +
        `  ΠΑΛΙΟ:  ${row.exit_reason ?? '—'} — pnl ${oldPnl}\n` +
        `  ΝΕΟ:    ${recomputed?.exitReason ?? '—'} — pnl ${newPnl}\n` +
        `  ${changed ? '⚠️  ΔΙΑΦΕΡΕΙ' : '✅ ίδιο'}\n`,
    );
  }
} finally {
  await client.end();
}

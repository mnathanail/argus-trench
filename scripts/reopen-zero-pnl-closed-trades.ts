import 'dotenv/config';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Set it in the shell or .env before running this script.');
}

const client = new Client({ connectionString: DATABASE_URL });

try {
  await client.connect();
  await client.query('BEGIN');

  const result = await client.query(
    `
      UPDATE paper_trades
         SET status = 'open',
             exit_reason = NULL,
             exit_trigger_detail_json = NULL,
             simulated_exit_price = NULL,
             exit_at = NULL,
             pnl_sol = NULL,
             pnl_pct = NULL,
             pnl_net_pct = NULL,
             assumed_fees_pct = NULL
       WHERE status = 'closed'
         AND pnl_pct = 0
       RETURNING id, token_address, pnl_pct;
    `,
  );

  await client.query('COMMIT');
  console.log(`reopened ${result.rowCount ?? 0} zero-PnL closed paper_trades back to open`);
  if (result.rows.length > 0) {
    console.log(JSON.stringify(result.rows, null, 2));
  }
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

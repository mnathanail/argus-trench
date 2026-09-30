import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';

// Χρήση:
//   railway run npm run repair-usd-priced-exits            (dry run — μόνο λίστα)
//   railway run npm run repair-usd-priced-exits -- --apply (εφαρμογή)
//
// 2026-09-28 — καθαρισμός για το bug του exit-resolver (βλ. exitResolver.ts, trade 6451):
// realtime paper trades (τιμές σε SOL) που τα έκλεισε το resolver με GMGN USD candles.
// Η τιμή εξόδου τους είναι σε USD → pnl ~×(τιμή SOL σε USD), π.χ. "+7429%".
//
// Ανίχνευση: σε trade που έκλεισε από το tick path η τιμή εξόδου δεν μπορεί να ξεπεράσει
// το peak (trailing ≤ stop ≤ peak, stop_loss ≤ entry, exit_signal = τιμή ενός sell tick).
// Έξοδος > 2 × max(peak, entry) είναι αδύνατη εκτός από το USD bug. (Χάνει μόνο trades
// όπου η πραγματική τιμή είχε πέσει > ~97% από το peak — εκεί η USD τιμή δεν ξεχωρίζει.)
//
// Επιδιόρθωση: το αποτέλεσμα είναι ΑΓΝΩΣΤΟ (δεν ξέρουμε την ισοτιμία εκείνη τη στιγμή) →
// ίδια σύμβαση με το no_market_data: exit_reason='no_market_data', τιμή εξόδου και pnl
// NULL. Οι αρχικές τιμές κρατιούνται στο exit_trigger_detail_json.usd_price_bug — τίποτα
// δεν χάνεται. Live trades δεν αγγίζονται (το resolver δεν τα κλείνει ποτέ).

const MAX_EXIT_OVER_PEAK = 2;
const apply = process.argv.includes('--apply');
const pool = getPool();

interface Row {
  id: string;
  token_address: string;
  exit_reason: string | null;
  simulated_entry_price: string;
  peak_price_since_entry: string | null;
  simulated_exit_price: string;
  pnl_net_pct: string | null;
  pnl_sol: string | null;
}

const SELECT_SUSPECTS = `
  SELECT pt.id, pt.token_address, pt.exit_reason, pt.simulated_entry_price, pt.peak_price_since_entry,
         pt.simulated_exit_price, pt.pnl_net_pct, pt.pnl_sol
    FROM paper_trades pt
    JOIN decision_log d ON d.id = pt.decision_log_id
   WHERE pt.mode = 'paper'
     AND pt.status = 'closed'
     AND (d.trigger_wallet_snapshot_json->>'source_channel' = 'pumpportal_websocket'
          OR pt.entry_timing_json IS NOT NULL)  -- 2026-09-30: #6779, σβησμένο source_channel
     AND pt.simulated_entry_price > 0
     AND pt.simulated_exit_price IS NOT NULL
     AND pt.simulated_exit_price >
         $1 * GREATEST(COALESCE(pt.peak_price_since_entry, pt.simulated_entry_price), pt.simulated_entry_price)
   ORDER BY pt.id`;

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Row>(`${SELECT_SUSPECTS} FOR UPDATE OF pt`, [MAX_EXIT_OVER_PEAK]);

    const pct = (v: string | null): string => (v === null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
    console.log(`\nRealtime paper trades με τιμή εξόδου σε USD (bug του exit-resolver): ${rows.length}`);
    let sumSol = 0;
    for (const r of rows) {
      sumSol += r.pnl_sol === null ? 0 : Number(r.pnl_sol);
      const ratio = Number(r.simulated_exit_price) / Number(r.simulated_entry_price);
      console.log(
        `  #${r.id} ${r.token_address.slice(0, 8)} ${String(r.exit_reason).padEnd(14)} ` +
          `έξοδος/είσοδος ×${ratio.toFixed(1).padEnd(7)} pnl ${pct(r.pnl_net_pct).padEnd(9)} ${r.pnl_sol ?? '—'} SOL`,
      );
    }
    console.log(`  Ψεύτικο συνολικό pnl που αφαιρείται: ${sumSol >= 0 ? '+' : ''}${sumSol.toFixed(4)} SOL`);

    if (!apply || rows.length === 0) {
      await client.query('ROLLBACK');
      if (!apply && rows.length > 0) console.log('\nDry run — τίποτα δεν άλλαξε. Ξανατρέξε με -- --apply.');
    } else {
      const { rowCount } = await client.query(
        `UPDATE paper_trades
            SET exit_trigger_detail_json = COALESCE(exit_trigger_detail_json, '{}'::jsonb) ||
                  jsonb_build_object('usd_price_bug', jsonb_build_object(
                    'original_exit_reason', exit_reason,
                    'original_exit_price', simulated_exit_price,
                    'original_pnl_pct', pnl_pct,
                    'original_pnl_net_pct', pnl_net_pct,
                    'original_pnl_sol', pnl_sol,
                    'repaired_at', now())),
                exit_reason = 'no_market_data',
                simulated_exit_price = NULL,
                pnl_sol = NULL,
                pnl_pct = NULL,
                pnl_net_pct = NULL
          WHERE id = ANY($1::bigint[])`,
        [rows.map((r) => r.id)],
      );
      await client.query('COMMIT');
      console.log(`\n✅ Διορθώθηκαν ${rowCount} trades (αποτέλεσμα: άγνωστο, όχι ψεύτικο κέρδος).`);
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await closePool();
}

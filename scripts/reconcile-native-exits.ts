import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { setNativeOrderState } from '../src/db/repositories/paperTrades.js';
import { closeFromOwnSell } from '../src/collectors/liveStrategyReconciler.js';
import { fetchLiveSolWallet } from '../src/gmgn/portfolio.js';
import { findStrategyForToken, soldByStrategy, exitReasonFromStrategy } from '../src/gmgn/strategyOrders.js';
import { findOwnSellRatio } from '../src/live/ownSellRatio.js';
import { delay } from '../src/util/delay.js';

// Χρήση:
//   npm run reconcile-native-exits            (dry run — τι βρέθηκε, τίποτα δεν αλλάζει)
//   npm run reconcile-native-exits -- --apply (κλείνει ό,τι πουλήθηκε, με το πραγματικό αποτέλεσμα)
//
// 2026-09-29: live trades που είναι «ανοιχτά» στη βάση ενώ on-chain έχουν πουληθεί — κυρίως
// από το native GMGN stop-loss, που δεν βλέπαμε ποτέ (το swap δεν επέστρεφε strategy_order_id,
// βλ. live/nativeStrategyAttach.ts). Για κάθε ανοιχτό live trade:
//   - native strategy στο `order strategy list` (place_action, success_sell_num),
//   - πώληση του token από το ΔΙΚΟ ΜΑΣ wallet στο `portfolio activity` → πραγματικό ratio.
// --apply: πουλήθηκε → closeTrade με το on-chain ratio. Δεν πουλήθηκε αλλά υπάρχει ανοιχτό
// strategy → συνδέεται (native_order_active) ώστε να το παρακολουθεί ο reconciler.

interface Row {
  id: string;
  token_address: string;
  entry_at: Date;
  actual_entry_amount_sol: string | null;
  simulated_entry_price: string | null;
}

const apply = process.argv.includes('--apply');
const pool = getPool();

try {
  const { rows } = await pool.query<Row>(
    `SELECT id, token_address, entry_at, actual_entry_amount_sol, simulated_entry_price
       FROM paper_trades
      WHERE status = 'open' AND mode = 'live'
      ORDER BY entry_at`,
  );
  console.log(`\nΑνοιχτά live trades στη βάση: ${rows.length}${apply ? '' : ' (dry run)'}\n`);
  if (rows.length > 0) {
    const wallet = (await fetchLiveSolWallet()).address;
    for (const r of rows) {
      const trade = {
        id: Number(r.id),
        tokenAddress: r.token_address,
        actualEntryAmountSol: r.actual_entry_amount_sol === null ? null : Number(r.actual_entry_amount_sol),
        simulatedEntryPrice: r.simulated_entry_price === null ? null : Number(r.simulated_entry_price),
      };
      const since = r.entry_at.getTime();
      const strategy = await findStrategyForToken(wallet, r.token_address, since).catch(() => null);
      const ownSell = await findOwnSellRatio(wallet, r.token_address, r.entry_at).catch(() => null);

      const strat = strategy === null
        ? 'κανένα strategy'
        : `strategy ${strategy.status}/${strategy.reasonBy || '-'}` +
          (soldByStrategy(strategy) ? ` → ΠΟΥΛΗΣΕ (${exitReasonFromStrategy(strategy)})` : '');
      const sell = ownSell === null
        ? 'καμία πώληση στο wallet'
        : `πώληση ${ownSell.sellAt.toISOString().slice(5, 16).replace('T', ' ')} ratio ${ownSell.ratio.toFixed(3)} ` +
          `(${((ownSell.ratio - 1) * 100).toFixed(1)}%, ${ownSell.source})`;
      console.log(`  #${r.id} ${r.token_address.slice(0, 8)} | ${strat} | ${sell}`);

      if (apply) {
        if (ownSell !== null) {
          const res = await closeFromOwnSell(trade, strategy, ownSell, undefined);
          console.log(`      → ${res.outcome === 'closed' ? 'ΕΚΛΕΙΣΕ' : 'δεν άλλαξε (ήδη κλειστό;)'}`);
        } else if (strategy !== null && strategy.status === 'open') {
          await setNativeOrderState(trade.id, { liveStrategyOrderId: strategy.orderId, nativeOrderActive: true });
          console.log('      → συνδέθηκε με το ανοιχτό native strategy (το παρακολουθεί ο reconciler)');
        } else {
          console.log('      → τίποτα: ίσως κρατάς ακόμα το token — έλεγξε στο GMGN');
        }
      }
      await delay(1_500); // κοινό GMGN budget
    }
  }
} finally {
  await closePool();
}

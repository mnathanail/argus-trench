import 'dotenv/config';
import { activateTradeProxyIfConfigured } from '../src/util/tradeProxy.js';
import { fetchLiveSolWallet, getLiveSolBalance } from '../src/gmgn/portfolio.js';
import { executeLiveSell, SwapFailedError, AutomatedTradesDisabledError, INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE } from '../src/gmgn/swap.js';
import { GmgnCliError } from '../src/gmgn/errors.js';
import { getTrade, closeTrade } from '../src/db/repositories/paperTrades.js';
import { recordExecutionError } from '../src/db/repositories/tradeExecutionErrors.js';

activateTradeProxyIfConfigured();

// Χρήση: npm run close-manual-exit -- <trade_id>
//
// Για trades που είναι needs_manual_exit=true (μια αυτόματη πώληση απέτυχε, βλ. το
// alert που πήρες στο Telegram). Προσπαθεί ΤΩΡΑ την πώληση, και ΜΟΝΟ αν πετύχει,
// κλείνει σωστά το trade στη βάση με τα πραγματικά νούμερα — δεν χρειάζεται να τα
// υπολογίσεις/καταγράψεις χειροκίνητα.

const tradeId = Number(process.argv[2]);
if (!Number.isInteger(tradeId) || tradeId <= 0) {
  console.error('Χρήση: npm run close-manual-exit -- <trade_id>');
  process.exit(1);
}

const trade = await getTrade(tradeId);
if (trade === null) {
  console.error(`Δεν βρέθηκε trade με id=${tradeId}.`);
  process.exit(1);
}
if (!trade.needsManualExit) {
  console.error(`Το trade #${tradeId} δεν είναι σημαδεμένο needs_manual_exit — δεν χρειάζεται αυτό το script.`);
  process.exit(1);
}
if (trade.status !== 'open') {
  console.error(`Το trade #${tradeId} δεν είναι πια open (status=${trade.status}).`);
  process.exit(1);
}

console.log(`Trade #${tradeId} — ${trade.tokenAddress}`);
console.log(`Αρχικό, πραγματικό ποσό εισόδου: ${trade.actualEntryAmountSol ?? '(άγνωστο)'} SOL\n`);

const wallet = await fetchLiveSolWallet();
const balanceBefore = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;

console.log(`Πώληση ΟΛΟΚΛΗΡΗΣ της θέσης σε ${trade.tokenAddress} ...\n`);

try {
  const result = await executeLiveSell(wallet.address, trade.tokenAddress);
  const balanceAfter = await getLiveSolBalance();
  const actualExitAmountSol = balanceAfter - balanceBefore;
  const actualEntryAmountSol = trade.actualEntryAmountSol ?? 0;
  const pnlSol = actualExitAmountSol - actualEntryAmountSol;
  const pnlPct = actualEntryAmountSol > 0 ? pnlSol / actualEntryAmountSol : null;

  await closeTrade(tradeId, {
    exitReason: 'manual',
    simulatedExitPrice: result.executedPrice ?? trade.simulatedEntryPrice ?? 0,
    pnlSol,
    pnlPct,
    assumedFeesPct: 0,
    pnlNetPct: pnlPct,
    actualExitAmountSol,
  });

  console.log('✅ Επιβεβαιωμένο on-chain, και το trade έκλεισε σωστά στη βάση.');
  console.log(`Πραγματικό ποσό εξόδου: ${actualExitAmountSol.toFixed(9)} SOL`);
  console.log(`Πραγματικό pnl: ${pnlSol.toFixed(9)} SOL (${pnlPct !== null ? (pnlPct * 100).toFixed(2) : '?'}%)`);
  console.log(`Tx: https://solscan.io/tx/${result.txHash ?? "(άγνωστο)"}`);
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  await recordExecutionError({
    paperTradeId: tradeId,
    tokenAddress: trade.tokenAddress,
    action: 'sell',
    amountSol: trade.actualEntryAmountSol,
    errorMessage,
    errorDetail: error,
  });
  console.error(`\n❌ Απέτυχε ξανά: ${errorMessage}`);
  console.error('Το trade παραμένει needs_manual_exit=true — δοκίμασε ξανά αργότερα.');
  if (error instanceof SwapFailedError && error.errorCode === INSUFFICIENT_TOKEN_BALANCE_ERROR_CODE) {
    // 2026-09-28: δεν υπάρχει τίποτα να πουληθεί — η θέση έκλεισε ήδη αλλού (συνήθως από
    // το native GMGN trailing/stop-loss). Νέα προσπάθεια θα αποτύχει πάντα με το ίδιο.
    console.error('\nℹ️  Το wallet δεν έχει πια αυτό το token (40003701 — insufficient token balance).');
    console.error('Η θέση πουλήθηκε ήδη, πιθανότατα από το native GMGN order. Έλεγξε το πραγματικό exit');
    console.error('στο GMGN/Solscan· για κλείσιμο στη βάση χωρίς πώληση: npm run close-stale-live-trades');
  }
  // Ολόκληρο το ωμό output του gmgn-cli (το GmgnCliError είναι είτε το ίδιο το error είτε το cause).
  const cliError = error instanceof GmgnCliError ? error : error instanceof Error && error.cause instanceof GmgnCliError ? error.cause : null;
  if (cliError !== null) {
    console.error('\n--- Πλήρες, ωμό output του gmgn-cli ---');
    console.error(cliError.output);
    console.error('--- τέλος ---');
  } else if (error instanceof SwapFailedError) {
    console.error('\n--- Σφάλμα swap ---');
    console.error(error.message);
    console.error('--- τέλος ---');
  } else if (error instanceof AutomatedTradesDisabledError) {
    console.error('GMGN_ALLOW_AUTOMATED_TRADES δεν είναι 1.');
  }
  process.exit(1);
}

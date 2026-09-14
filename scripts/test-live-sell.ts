import 'dotenv/config';
import { activateTradeProxyIfConfigured } from '../src/util/tradeProxy.js';
import { fetchLiveSolWallet, getLiveSolBalance } from '../src/gmgn/portfolio.js';
import { executeLiveSell, SwapFailedError, AutomatedTradesDisabledError } from '../src/gmgn/swap.js';

activateTradeProxyIfConfigured();

// Χρήση: npm run test-live-sell -- <token_address>
//
// Πουλάει ΟΛΟΚΛΗΡΗ τη θέση (--percent 100) σε αυτό το token, μέσω GMGN swap. ΠΡΑΓΜΑΤΙΚΟ,
// ΑΝΕΚΚΛΗΤΟ swap. Δεν καταγράφει τίποτα στη βάση μας. Ίδιο try/catch-όλο-μαζί μοτίβο με
// το test-live-buy.ts.

function printError(error: unknown): void {
  if (error instanceof AutomatedTradesDisabledError) {
    console.error(`\n🚫 ${error.message}\nΘέσε GMGN_ALLOW_AUTOMATED_TRADES=1 στο περιβάλλον για να συνεχίσεις.`);
  } else if (error instanceof SwapFailedError) {
    console.error(`\n❌ Το swap απέτυχε ρητά (status: ${error.status}): ${error.message}`);
  } else {
    console.error(`\n❌ Σφάλμα: ${error instanceof Error ? error.message : String(error)}`);
    if (error !== null && typeof error === 'object' && 'output' in error) {
      console.error('\n--- Πλήρες, ωμό output ---');
      console.error((error as { output: unknown }).output);
      console.error('--- τέλος ---');
    }
  }
}

const tokenAddress = process.argv[2];

if (tokenAddress === undefined) {
  console.error('Χρήση: npm run test-live-sell -- <token_address>');
  process.exit(1);
}

try {
  const wallet = await fetchLiveSolWallet({ priority: 1000 });
  console.log(`Wallet: ${wallet.address}`);
  const balanceBefore = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;
  console.log(`Υπόλοιπο πριν: ${balanceBefore} SOL`);

  console.log(`\nΠώληση ΟΛΟΚΛΗΡΗΣ της θέσης σε ${tokenAddress} ...\n`);

  const result = await executeLiveSell(wallet.address, tokenAddress);
  console.log('Αποτέλεσμα:');
  console.log(JSON.stringify(result, null, 2));

  if (result.filled) {
    console.log(`\n✅ Εκτελέστηκε. Τιμή: ${result.executedPrice ?? '(άγνωστη)'}`);
    if (result.txHash) console.log(`Tx: https://solscan.io/tx/${result.txHash}`);
  } else {
    console.log(`\n⚠️  Ακόμα σε εξέλιξη μετά το polling (status: ${result.status}) — έλεγξε χειροκίνητα:`);
    if (result.orderId) console.log(`gmgn-cli order get --chain sol --order-id ${result.orderId} --raw`);
  }

  const balanceAfter = await getLiveSolBalance({ priority: 1000 });
  console.log(`\nΥπόλοιπο μετά: ${balanceAfter} SOL (διαφορά: ${(balanceAfter - balanceBefore).toFixed(9)})`);
} catch (error) {
  printError(error);
  process.exit(1);
}

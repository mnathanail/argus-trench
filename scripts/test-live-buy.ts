import 'dotenv/config';
import { fetchLiveSolWallet, getLiveSolBalance } from '../src/gmgn/portfolio.js';
import { executeLiveBuy, SwapFailedError, AutomatedTradesDisabledError } from '../src/gmgn/swap.js';

// Χρήση: npm run test-live-buy -- <token_address> [amount_sol]
//   π.χ.  npm run test-live-buy -- 8CD94taK17MdP2A2GdBdgcAJWW5sxyHoYLUtqkripump 0.005
//
// ΠΡΑΓΜΑΤΙΚΟ, ΑΝΕΚΚΛΗΤΟ swap — πραγματικά χρήματα, πραγματική on-chain συναλλαγή.
// Δεν καταγράφει τίποτα στη βάση μας, δεν πουλάει αυτόματα μετά — μόνο το ελάχιστο
// δυνατό, χειροκίνητο πρώτο τεστ. Μετά την αγορά, έλεγξε το wallet σου στο
// https://solscan.io πριν αποφασίσεις το επόμενο βήμα.
//
// ΟΛΟΚΛΗΡΟ το script είναι τώρα μέσα σε ΕΝΑ try/catch (πραγματικό incident 2026-09-13:
// οι αρχικές/τελικές κλήσεις portfolio-info ήταν ΕΚΤΟΣ try/catch, άρα ένα rate-limit
// σφάλμα εκεί έριχνε ωμό, ασύλληπτο crash αντί για το καθαρό, μορφοποιημένο μήνυμα).

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
const amountSol = process.argv[3] ? Number(process.argv[3]) : 0.005;

if (tokenAddress === undefined) {
  console.error('Χρήση: npm run test-live-buy -- <token_address> [amount_sol=0.005]');
  process.exit(1);
}
if (!Number.isFinite(amountSol) || amountSol <= 0) {
  console.error(`Μη έγκυρο ποσό: ${process.argv[3]}`);
  process.exit(1);
}
if (amountSol > 0.02) {
  console.error(`Το ${amountSol} SOL είναι πολύ μεγάλο για δοκιμαστικό script — μέγιστο 0.02.`);
  process.exit(1);
}

try {
  const wallet = await fetchLiveSolWallet({ priority: 1000 });
  console.log(`Wallet: ${wallet.address}`);
  const balanceBefore = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;
  console.log(`Υπόλοιπο πριν: ${balanceBefore} SOL`);

  if (balanceBefore < amountSol) {
    console.error(`Ανεπαρκές υπόλοιπο: έχεις ${balanceBefore} SOL, ζητάς αγορά ${amountSol} SOL.`);
    process.exit(1);
  }

  console.log(`\nΑγορά ${amountSol} SOL → ${tokenAddress} ...\n`);

  const result = await executeLiveBuy(wallet.address, tokenAddress, amountSol);
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

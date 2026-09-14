import 'dotenv/config';
import { config } from '../src/config.js';
import { pumpPortalSellAll, PumpPortalTradeError, PumpPortalTradeFailedError } from '../src/pumpportal/trading.js';

// Χρήση: npm run test-pumpportal-sell -- <token_address>
//
// Πουλάει ΟΛΟΚΛΗΡΗ τη θέση (--percent 100%) σε αυτό το token, μέσω του ίδιου
// PUMPPORTAL_API_KEY. ΠΡΑΓΜΑΤΙΚΟ, ΑΝΕΚΚΛΗΤΟ swap. Δεν καταγράφει τίποτα στη βάση μας.

const tokenAddress = process.argv[2];

if (tokenAddress === undefined) {
  console.error('Χρήση: npm run test-pumpportal-sell -- <token_address>');
  process.exit(1);
}

const apiKey = config.pumpportalApiKey();
if (apiKey === undefined) {
  console.error('PUMPPORTAL_API_KEY δεν είναι ρυθμισμένο.');
  process.exit(1);
}

console.log(`Πώληση ΟΛΟΚΛΗΡΗΣ της θέσης σε ${tokenAddress} μέσω PumpPortal Lightning API ...\n`);

try {
  const result = await pumpPortalSellAll(apiKey, tokenAddress);
  console.log('✅ Επιβεβαιωμένο on-chain (confirmed, όχι μόνο υποβλήθηκε).');
  console.log(`Signature: ${result.signature}`);
  console.log(`Tx: https://solscan.io/tx/${result.signature}`);
} catch (error) {
  if (error instanceof PumpPortalTradeFailedError) {
    console.error(`❌ Η συναλλαγή απέτυχε ΣΤΟ CHAIN (επιβεβαιωμένο, όχι απλά αναφορά API): ${error.message}`);
    console.error(`Tx: https://solscan.io/tx/${error.signature}`);
  } else if (error instanceof PumpPortalTradeError) {
    console.error(`❌ Απέτυχε: HTTP ${error.status} — ${error.message}`);
    console.error('\n--- Πλήρες, ωμό output ---');
    console.error(error.body);
    console.error('--- τέλος ---');
  } else {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

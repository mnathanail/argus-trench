import 'dotenv/config';
import { config } from '../src/config.js';
import { pumpPortalBuy, PumpPortalTradeError } from '../src/pumpportal/trading.js';

// Χρήση: npm run test-pumpportal-buy -- <token_address> [amount_sol]
//   π.χ.  npm run test-pumpportal-buy -- 8CD94taK17MdP2A2GdBdgcAJWW5sxyHoYLUtqkripump 0.005
//
// Δοκιμάζει το ΗΔΗ ΥΠΑΡΧΟΝ PUMPPORTAL_API_KEY (το wallet του websocket data feed) —
// ελέγχει αν το ίδιο key έχει ΚΑΙ δικαιώματα trading, όχι μόνο data. ΠΡΑΓΜΑΤΙΚΟ,
// ΑΝΕΚΚΛΗΤΟ swap αν πετύχει. Δεν καταγράφει τίποτα στη βάση μας.

const tokenAddress = process.argv[2];
const amountSol = process.argv[3] ? Number(process.argv[3]) : 0.005;

if (tokenAddress === undefined) {
  console.error('Χρήση: npm run test-pumpportal-buy -- <token_address> [amount_sol=0.005]');
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

const apiKey = config.pumpportalApiKey();
if (apiKey === undefined) {
  console.error('PUMPPORTAL_API_KEY δεν είναι ρυθμισμένο.');
  process.exit(1);
}

console.log(`Αγορά ${amountSol} SOL → ${tokenAddress} μέσω PumpPortal Lightning API ...\n`);

try {
  const result = await pumpPortalBuy(apiKey, tokenAddress, amountSol);
  console.log('✅ Εκτελέστηκε.');
  console.log(`Signature: ${result.signature}`);
  console.log(`Tx: https://solscan.io/tx/${result.signature}`);
} catch (error) {
  if (error instanceof PumpPortalTradeError) {
    console.error(`❌ Απέτυχε: HTTP ${error.status} — ${error.message}`);
    console.error('\n--- Πλήρες, ωμό output ---');
    console.error(error.body);
    console.error('--- τέλος ---');
  } else {
    console.error(`❌ Σφάλμα: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

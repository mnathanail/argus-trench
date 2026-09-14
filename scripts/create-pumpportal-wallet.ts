import { createPumpPortalWallet } from '../src/pumpportal/trading.js';

// Χρήση: npm run create-pumpportal-wallet
//
// Δημιουργεί ΕΝΑ ΝΕΟ PumpPortal trading wallet + api key — ΤΕΛΕΙΩΣ ΞΕΧΩΡΙΣΤΟ από:
//   - το μικρό PumpPortal wallet που ήδη έχουμε για το websocket data feed
//   - το GMGN trading wallet (yFb3v4wfoc7fSrxXXJ9YTM6JwMVZdnus5fmKe2A6gH5)
//
// Τρέξε το ΜΙΑ φορά. Το private key εμφανίζεται ΜΟΝΟ αυτή τη φορά — αποθήκευσέ το
// αμέσως κάπου ασφαλές (π.χ. Railway env vars) πριν κλείσεις το terminal.

const wallet = await createPumpPortalWallet();
console.log('Νέο PumpPortal trading wallet δημιουργήθηκε:\n');
console.log(`  Public key (χρηματοδότησε ΑΥΤΟ):  ${wallet.walletPublicKey}`);
console.log(`  API key (χρειάζεται για trades):  ${wallet.apiKey}`);
console.log(`  Private key (ΚΡΑΤΑ ΤΟ ΑΣΦΑΛΕΣ):    ${wallet.privateKey}`);
console.log('\n⚠️  Αυτό το private key δεν θα ξαναεμφανιστεί — αποθήκευσέ το τώρα.');
console.log('Στείλε ένα πολύ μικρό δοκιμαστικό ποσό (π.χ. 0.01 SOL) στο public key πριν συνεχίσουμε.');

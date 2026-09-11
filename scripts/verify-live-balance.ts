import 'dotenv/config';
import { runCli } from '../src/gmgn/exec.js';

// Χρήση: npm run verify-live-balance
//
// Στόχος: δούμε το ΠΡΑΓΜΑΤΙΚΟ σχήμα του `portfolio info` πριν γράψουμε οποιονδήποτε
// parsing κώδικα πάνω σε υποθέσεις — ίδιο σκεπτικό με κάθε GMGN/PumpPortal verification
// που κάναμε μέχρι τώρα. Χρειάζεται GMGN_API_KEY + GMGN_PRIVATE_KEY στο περιβάλλον
// (ήδη έπρεπε να υπάρχουν από το αρχικό setup — βλ. environment στο project).
//
// ΔΕΝ γράφει τίποτα, ΔΕΝ κάνει καμία συναλλαγή — μόνο διαβάζει.

const result = await runCli('portfolio info', ['portfolio', 'info']);
console.log(JSON.stringify(result, null, 2));

import 'dotenv/config';
import { listAllOpenLiveTrades, closeTrade } from '../src/db/repositories/paperTrades.js';

// Χρήση: npm run close-stale-live-trades
//
// One-off εργαλείο, 2026-09-23 πραγματικό incident: 29 mode='live' trades δείχνουν ακόμα
// `status='open'` στη βάση μας, όλα ήδη σημαδεμένα `needs_manual_exit=true` από τον
// live-trade-watchdog (on-chain token balance=0 όταν ελέγχθηκαν) — αλλά ο χρήστης
// επιβεβαίωσε ότι στο ίδιο το GMGN δεν υπάρχει ΚΑΜΙΑ ανοιχτή θέση πια. Δηλαδή οι θέσεις
// έκλεισαν αλλού (κάποιες πιθανόν χειροκίνητα από τον χρήστη, κάποιες για άλλο λόγο) ΧΩΡΙΣ
// να καταγραφεί ποτέ εδώ η πραγματική τιμή εξόδου.
//
// Το `close-manual-exit.ts` (per-trade script) ΔΕΝ ταιριάζει εδώ: αυτό δοκιμάζει μια ΝΕΑ
// πώληση ΤΩΡΑ, δηλαδή προϋποθέτει ότι η θέση υπάρχει ΑΚΟΜΑ on-chain — εδώ δεν υπάρχει
// τίποτα να πουληθεί, θα απέτυχε σε κάθε μία.
//
// Δεν μαντεύουμε το πραγματικό pnl (θα ήταν ψευδές δεδομένο σε κάθε μελλοντική
// ανάλυση/στατιστικό) — κλείνουμε με exit_reason='no_market_data', pnl_sol/pnl_pct=NULL,
// ΙΔΙΟ pattern με το ήδη υπάρχον 'no_market_data' (βλ. paperTrades.ts: "null όταν
// exitReason='no_market_data' — άγνωστο αποτέλεσμα, όχι μηδενικό"· τα στατιστικά ήδη
// εξαιρούν σωστά αυτά τα trades μέσω COALESCE(pt.pnl_pct, -1) στο dailyDigest). Το ήδη
// καταγεγραμμένο `actual_entry_amount_sol` ΔΕΝ αγγίζεται — μένει για μελλοντική Solscan
// συμφιλίωση (ρητό αίτημα χρήστη: μηχανισμός που θα φέρνει τις ακριβείς τιμές πώλησης
// μέσω on-chain ιστορικού, ΔΕΝ υλοποιείται ακόμα εδώ — αυτό το script είναι μόνο η άμεση
// εκκαθάριση των stale rows).
//
// Ασφαλές να ξανατρέξει: `closeTrade()` έχει ήδη `WHERE status = 'open'`, άρα ένα trade
// που έκλεισε ήδη (από αυτό ή άλλο μηχανισμό) απλά προσπερνιέται (rowCount=0), όχι διπλό
// κλείσιμο.

const trades = await listAllOpenLiveTrades();
const staleTrades = trades.filter((t) => t.needsManualExit);

if (staleTrades.length === 0) {
  console.log('Κανένα needs_manual_exit=true live trade δεν βρέθηκε ανοιχτό — τίποτα να κλείσει.');
  process.exit(0);
}

console.log(`Βρέθηκαν ${staleTrades.length} needs_manual_exit=true ανοιχτά live trades (από ${trades.length} σύνολο open live).\n`);

let closed = 0;
for (const trade of staleTrades) {
  const ok = await closeTrade(trade.id, {
    exitReason: 'no_market_data',
    simulatedExitPrice: 0,
    pnlSol: null,
    pnlPct: null,
    assumedFeesPct: 0,
    pnlNetPct: null,
  });
  console.log(
    `${ok ? '✅' : '⏭️ '} #${trade.id} ${trade.tokenAddress} ` +
      `(entry ${trade.actualEntryAmountSol ?? '?'} SOL, ${trade.entryAt.toISOString()})` +
      (ok ? '' : ' — ήδη κλειστό, παραλείπεται'),
  );
  if (ok) closed += 1;
}

console.log(`\nΈκλεισαν ${closed}/${staleTrades.length} trades με exit_reason=no_market_data (pnl άγνωστο).`);
console.log('Το actual_entry_amount_sol παρέμεινε άθικτο για μελλοντική Solscan συμφιλίωση.');

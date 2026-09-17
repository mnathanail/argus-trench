import { PAPER_ASSUMED_FEES_PCT } from './paperTradingConfig.js';

export interface PnlResult {
  pnlPct: number;
  pnlSol: number;
  pnlNetPct: number;
}

/**
 * ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #3): πριν, το PAPER_ASSUMED_SLIPPAGE_PCT γραφόταν
 * στη στήλη `assumed_slippage_pct` αλλά ΔΕΝ επηρέαζε ΚΑΝΕΝΑ υπολογισμό τιμής — ήταν
 * νεκρός κώδικας (grep επιβεβαίωσε: μόνο τα δύο INSERT sites το διάβαζαν). Το paper
 * entry ήταν πάντα η καλύτερη φυσικά διαθέσιμη τιμή (η bonding-curve τιμή ΑΜΕΣΩΣ μετά
 * την ίδια την αγορά του trigger wallet) — καμία πραγματική εκτέλεση δε θα την έφτανε.
 *
 * Πλήρης διόρθωση ("πάρε την τιμή του πρώτου tick ≥ PAPER_ASSUMED_LATENCY_MS μετά το
 * σήμα") θα απαιτούσε plumbing ενός post-signal tick-stream μέσα στο entry handler
 * (websocket buffering, timer, tests για race/timeout) — εκτός εμβέλειας αυτού του
 * περάσματος. Αντ' αυτού εφαρμόζουμε το ΗΔΗ αποθηκευμένο ποσοστό σαν άμεσο haircut στην
 * τιμή που έχουμε: η είσοδος καταγράφεται ΧΕΙΡΟΤΕΡΗ (πληρώνεις παραπάνω) κατά
 * PAPER_ASSUMED_SLIPPAGE_PCT σε σχέση με την παρατηρημένη τιμή — προσομοιώνει ρεαλιστικό
 * market-buy fill αντί για το θεωρητικό, προ-αγοράς σημείο της bonding curve.
 */
export function applyEntrySlippage(observedEntryPrice: number, slippagePct: number): number {
  return observedEntryPrice * (1 + slippagePct);
}

/**
 * Μία, κοινή υλοποίηση — χρησιμοποιείται και από το periodic exit-resolver (candle-based)
 * και από το realtime exit handler (tick-based). Πριν την εξαγωγή εδώ, ο ίδιος τύπος
 * ζούσε μόνο inline μέσα στο exitResolver.ts — δύο ανεξάρτητες υλοποιήσεις του ίδιου
 * υπολογισμού θα ρίσκαραν να αποκλίνουν με τον καιρό (π.χ. κάποιος να ξεχάσει το
 * PAPER_ASSUMED_FEES_PCT στη μία από τις δύο).
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #5): πριν, το `pnlSol` υπολογιζόταν από το ΜΙΚΤΟ
 * `pnlPct` — το `pnlNetPct` (μετά fees) υπήρχε ξεχωριστά αλλά ΔΕΝ έφτανε ποτέ σε κανένα
 * SOL-based aggregate (π.χ. το leaderboard κάνει SUM(pnl_sol)). Αποτέλεσμα: κάθε SOL
 * νούμερο που έβλεπε ο χρήστης δεν είχε ΚΑΘΟΛΟΥ fees μέσα του. Τώρα το `pnlSol` παράγεται
 * από το `pnlNetPct`, ώστε τα δύο να συμφωνούν πάντα και τα SOL aggregates να αντανακλούν
 * το πραγματικό, μετά-εξόδων αποτέλεσμα.
 *
 * Το `PAPER_ASSUMED_FEES_PCT` ανέβηκε επίσης (βλ. paperTradingConfig.ts) — το 1% ήταν
 * χαμηλό: το pump.fun από μόνο του παίρνει ~1% ανά πλευρά (είσοδος+έξοδος), πάνω από αυτό
 * υπάρχει και το GMGN routing/`--auto-slippage`/priority-tip fees. Δεν προκύπτει ακόμα
 * αξιόπιστα μετρημένο νούμερο από πραγματικά live fills (πολύ μικρό δείγμα κλεισμένων
 * live trades μέχρι στιγμής ώστε να αντικατασταθεί η σταθερά με κάτι δυναμικό), οπότε
 * παραμένει συντηρητικός, τεκμηριωμένος υπολογισμός αντί για μαντεμένο fine-tuning.
 */
export function computePnl(
  entryPrice: number,
  exitPrice: number,
  bankrollAtEntry: number | null,
  intendedSizePct: number | null,
): PnlResult {
  const pnlPct = (exitPrice - entryPrice) / entryPrice;
  const pnlNetPct = pnlPct - PAPER_ASSUMED_FEES_PCT;
  const pnlSol = (bankrollAtEntry ?? 0) * (intendedSizePct ?? 0) * pnlNetPct;
  return { pnlPct, pnlSol, pnlNetPct };
}

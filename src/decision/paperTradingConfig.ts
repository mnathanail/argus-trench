/**
 * Φάση 1 log-only paper trading (CLAUDE.md: mode='log_only' είναι ήδη μέρος της Φάσης 1,
 * όχι Φάση 3) — σταθερές που χρειάζεται το entry/exit simulation.
 */

/**
 * Placeholder bankroll σε SOL για το log_only sizing. Δεν επηρεάζει τίποτα πραγματικό
 * (καμία συναλλαγή γίνεται) — απλά κάνει το `intended_size_pct` (1%, ήδη επιβεβαιωμένο)
 * να μεταφράζεται σε απόλυτο ποσό, ώστε το `assumed_slippage_pct` να έχει νόημα σε σχέση
 * με το μέγεθος της pool liquidity. Άλλαξέ το όποτε υπάρχει πραγματικός αριθμός.
 */
export const PAPER_BANKROLL_SOL = 10;

export const PAPER_POSITION_SIZE_PCT = 0.01;

export const PAPER_ASSUMED_SLIPPAGE_PCT = 0.03;
export const PAPER_ASSUMED_LATENCY_MS = 3_000;

/**
 * ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #5): ανέβηκε από 1% σε 2%. Το 1% δεν κάλυπτε καν το
 * pump.fun's δικό του ~1% ανά πλευρά (είσοδος+έξοδος οπότε ~2% μόνο απ' αυτό), πόσο
 * μάλλον το GMGN routing fee, το `--auto-slippage` και τα priority/tip fees στο swap.ts.
 * Σε μια μικρή θέση (π.χ. 0.05 SOL) τα fixed κόστη (tip/priority) είναι ένα σημαντικό
 * ποσοστό. Το 2% παραμένει συντηρητική εκτίμηση, ΟΧΙ μετρημένο νούμερο — δεν υπάρχει
 * ακόμα αρκετό δείγμα κλεισμένων live trades ώστε να παραχθεί αξιόπιστα ένα πραγματικό
 * round-trip fee από `actual_entry_amount_sol` έναντι του ονομαστικού μεγέθους θέσης.
 * Να αναθεωρηθεί όταν υπάρχουν αρκετά live δεδομένα.
 */
export const PAPER_ASSUMED_FEES_PCT = 0.02;

/**
 * Exit plan, ίδιο με το `condition_orders_json` που αποθηκεύεται στο entry — δύο
 * μηχανισμοί μαζί (CLAUDE.md, layer "Exit decision"):
 *   - Tier 1: fixed take-profit στο +50%, πουλάει το μισό.
 *   - Tier 2: trailing, ενεργοποιείται στο +100%, closes στο -40% από το peak μετά την
 *     ενεργοποίηση.
 * Το exit-resolver αντιμετωπίζει όποιο από τα δύο (ή wallet-exit-signal, ή timeout)
 * συμβεί ΠΡΩΤΟ χρονικά ως πλήρες κλείσιμο της (απλοποιημένης, ενιαίας) simulated θέσης —
 * δε μοντελοποιούμε split 50/50 θέσεις σε ξεχωριστά rows στο v1.
 */
export const EXIT_TIER_1_PRICE_SCALE = 1.5; // +50%
export const EXIT_TIER_2_ACTIVATION_SCALE = 2.0; // +100%
export const EXIT_TIER_2_DRAWDOWN_PCT = 0.4; // -40% από το peak μετά την ενεργοποίηση

/**
 * Νέο 2026-09-11, πρώτη φορά πραγματικό κεφάλαιο. -50% από το ENTRY (όχι από peak,
 * διαφορετικό από το EXIT_TIER_2_DRAWDOWN_PCT) — καθαρή προστασία downside, ελέγχεται
 * πρώτο απ' όλα στο checkTick. Το GMGN CLI υποστηρίζει ήδη native `stop_loss` order
 * type (`order strategy create --sub-order-type stop_loss`) που θα εκτελούνταν από τη
 * ΔΙΚΗ ΤΟΥΣ υποδομή, ανεξάρτητα από το αν το δικό μας process είναι ζωντανό — πιο
 * robust μακροπρόθεσμα, αλλά εντελώς ανεπιβεβαίωτο ακόμα στην πράξη. Ξεκινάμε με τον
 * δικό μας, ήδη δοκιμασμένο μηχανισμό (checkTick) — το native GMGN stop_loss είναι
 * σκόπιμα ένα ΕΠΟΜΕΝΟ, ξεχωριστό βήμα, όχι κάτι που τρέχουμε να προλάβουμε τώρα.
 */
export const STOP_LOSS_PCT = 0.5;

export const EXIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Πρώτη φορά πραγματικό κεφάλαιο (2026-09-11) — ξεκινάμε με 1 SOL, 5% ανά trade,
 * ΣΤΑΘΕΡΟ ποσό (όχι % του τρέχοντος διαθέσιμου, που θα συρρικνωνόταν με κάθε trade) —
 * απλούστερο να σκεφτείς, ίδιο πνεύμα με το PAPER_BANKROLL_SOL/PAPER_POSITION_SIZE_PCT.
 * ΞΕΧΩΡΙΣΤΕΣ σταθερές από τις PAPER_* — σκόπιμα, ώστε να μπορούν να αλλάξουν ανεξάρτητα
 * στο μέλλον (π.χ. αν αυξηθεί το πραγματικό bankroll χωρίς να αλλάξει η παραδοχή
 * μεγέθους για τα ιστορικά/hypothetical trades).
 */
export const LIVE_BANKROLL_SOL = 1;
export const LIVE_POSITION_SIZE_PCT = 0.05;
export const LIVE_POSITION_SIZE_SOL = LIVE_BANKROLL_SOL * LIVE_POSITION_SIZE_PCT;

/**
 * Από το GMGN's δικό τους reference "AI Trader" demo (gmgn-demos/aitrader, εξετάστηκε
 * 2026-09-11) — δικές τους, ήδη σκεπτόμενες επιλογές για ρίσκο σε live trading:
 *   kill_switch_consec_losses: 3, daily_loss_cap_sol: 0.5 (πάνω σε 10 SOL equity — 5%)
 * Το `daily_loss_cap` εδώ ΔΕΝ είναι απλή αναλογία (0.05 SOL θα ήταν πολύ σφιχτό —
 * μία μόνο ζημιά stop-loss στο μισό μιας θέσης θα το έφτανε) — υπολογισμένο ώστε να
 * αφήνει περιθώριο για ~5 stop-lossed trades πριν σταματήσει, όχι 2.
 * kill-switch: ΣΤΑΘΕΡΟ μέχρι χειροκίνητο reset, ΟΧΙ αυτόματη επαναφορά — ρητή απόφαση
 * χρήστη 2026-09-11, βλ. liveRiskGate.ts + migration 0010.
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-18: ανέβηκε 3→10, ρητό αίτημα χρήστη μετά το real incident 2026-09-17
 * (τρεις μικρές, ανεξάρτητες, μη ασυνήθιστες ζημιές — 1194 stop_loss -0.0286, 1195/1196
 * exit_signal -0.0133/-0.0027 SOL, σύνολο -0.045 SOL, πολύ κάτω από το daily cap — έκλεισαν
 * το live trading sticky μέχρι χειροκίνητο /resume_live). Με το ~98.6% collapse base rate
 * (CLAUDE.md), 3 συνεχόμενες ζημιές είναι στατιστικά αναμενόμενες πολύ συχνά και δεν
 * υποδεικνύουν από μόνες τους σπασμένη στρατηγική — το 3 ήταν πολύ ευαίσθητο για το
 * πραγματικό προφίλ ρίσκου εδώ. Το `LIVE_DAILY_LOSS_CAP_SOL` παραμένει το κύριο, πιο
 * αξιόπιστο guardrail (μετράει πραγματικό μέγεθος ζημιάς, όχι απλά αριθμό trades στη
 * σειρά) — ΔΕΝ άλλαξε.
 */
export const LIVE_KILL_SWITCH_CONSEC_LOSSES = 10;
export const LIVE_DAILY_LOSS_CAP_SOL = 0.15;

export function conditionOrdersJson(): Record<string, unknown>[] {
  return [
    { order_type: 'profit_stop', price_scale: '50', sell_ratio: '50' },
    {
      order_type: 'profit_stop_trace',
      price_scale: '100',
      sell_ratio: '100',
      drawdown_rate: '40',
    },
  ];
}

/**
 * Το ΠΡΑΓΜΑΤΙΚΟ exit plan που περνάει στο `swap --condition-orders` για `mode='live'`
 * trades (2026-09-17, incident #1193 — βλ. migration 0013). ΣΚΟΠΙΜΑ ΔΙΑΦΟΡΕΤΙΚΟ από το
 * `conditionOrdersJson()` πιο πάνω: εκείνο περιγράφει ένα scale-out (50% στο tier1 +
 * trailing στο υπόλοιπο) — καλή στρατηγική αφ' εαυτής, αλλά ΔΕΝ ταιριάζει με το πώς
 * μοντελοποιούμε μια θέση αλλού (ΕΝΑ paper_trades row, ΕΝΑ pnl_sol/pnl_pct, κλείνει
 * ΜΙΑ φορά — βλ. checkTick/resolveExit's ρητή σύμβαση "tier2 πάντα υπερισχύει, ποτέ
 * partial fill"). Ένα partial tier1-sell θα άφηνε τη θέση "μισοκλειστή" με τρόπο που το
 * σημερινό schema δεν αναπαριστά καθόλου.
 *
 * Αντ' αυτού: ΜΟΝΟ trailing (ενεργοποίηση +100%, 40% drawdown από peak, ΟΛΟΚΛΗΡΗ η θέση)
 * + stop_loss (-50% από entry, ΟΛΟΚΛΗΡΗ η θέση) — ακριβώς οι ίδιες τιμές/σημασιολογία με
 * το δικό μας checkTick, ώστε το native order και το δικό μας watchdog να συμφωνούν
 * πάντα για το ΠΟΤΕ θα έκλεινε η θέση, ακόμα κι όταν αναλαμβάνει το ένα από τα δύο.
 */
export function liveExitConditionOrders(): Record<string, unknown>[] {
  return [
    {
      order_type: 'profit_stop_trace',
      side: 'sell',
      price_scale: String(Math.round((EXIT_TIER_2_ACTIVATION_SCALE - 1) * 100)), // '100' = +100%
      drawdown_rate: String(Math.round(EXIT_TIER_2_DRAWDOWN_PCT * 100)), // '40' = -40% από peak
      sell_ratio: '100',
    },
    {
      order_type: 'loss_stop',
      side: 'sell',
      price_scale: String(Math.round(STOP_LOSS_PCT * 100)), // '50' = -50% από entry
      sell_ratio: '100',
    },
  ];
}

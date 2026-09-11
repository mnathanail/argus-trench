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
export const PAPER_ASSUMED_FEES_PCT = 0.01;

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
 */
export const LIVE_KILL_SWITCH_CONSEC_LOSSES = 3;
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

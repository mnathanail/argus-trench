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

export const EXIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

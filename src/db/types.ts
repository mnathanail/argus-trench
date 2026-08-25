/**
 * Domain types. Οι string unions αντιστοιχούν 1:1 στα CHECK constraints και στα σχόλια
 * του schema — αν αλλάξει το ένα, πρέπει να αλλάξει και το άλλο.
 */

export type Chain = 'sol' | 'bsc' | 'base' | 'eth';

export type WalletSource = 'smart_money' | 'kol' | 'manual';

/**
 * Πώς παρατηρήθηκε ο candidate. Βλ. migration 0003 και layer 1 στο CLAUDE.md — τα δύο
 * calls δεν έχουν την ίδια στατιστική σημασία και ΔΕΝ πρέπει να αναμειχθούν στην ανάλυση.
 */
export type CandidateSource = 'gated_pool' | 'sample_window';

export type Decision =
  | 'entered'
  | 'skipped_gate'
  | 'skipped_no_trigger'
  | 'skipped_bankroll_limit'
  /**
   * Φάση 1 μόνο: το gate πέρασε ΚΑΙ trusted wallet αγόρασε — δηλαδή ο κανόνας εισόδου
   * ενεργοποιήθηκε — αλλά η Φάση 1 είναι read-only, άρα δεν έγινε trade.
   *
   * Χρειάζεται ξεχωριστή τιμή γιατί το `skipped_no_trigger` γίνεται ψευδές μόλις υπάρχει
   * trigger, και το `entered` θα υπονοούσε θέση που δεν άνοιξε ποτέ. Στη Φάση 3 αυτά τα
   * rows είναι ακριβώς το σύνολο που θα γινόταν `entered` με paper trade.
   * Το `decision` δεν έχει CHECK constraint, άρα δε χρειάστηκε migration.
   */
  | 'signal_logged';

/** `kol_call` reserved για v2 — ανενεργό στο v1. */
export type TriggerType = 'smart_money_buy' | 'kol_call' | 'none';

export type TradeMode = 'log_only' | 'paper' | 'live';

export type TradeStatus = 'open' | 'closed';

export type ExitReason =
  | 'tp_tier_1'
  | 'tp_tier_2'
  | 'trailing_stop'
  | 'exit_signal'
  | 'timeout';

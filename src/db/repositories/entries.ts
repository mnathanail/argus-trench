import type pg from 'pg';
import { withTransaction } from '../tx.js';
import { insertDecision, type NewDecisionLog } from './decisionLog.js';
import { openTrade, type NewPaperTrade } from './paperTrades.js';

export interface RecordedEntry {
  decisionLogId: number;
  tradeId: number;
}

/**
 * Γράφει ένα `entered` decision μαζί με το trade του, ατομικά.
 *
 * Γιατί χρειάζεται helper: η FK είναι κυκλική (`decision_log.linked_trade_id` →
 * `paper_trades.id` και `paper_trades.decision_log_id` → `decision_log.id`), άρα δε
 * γίνεται σε ένα statement. Η σειρά είναι υποχρεωτικά τριών βημάτων:
 *   1. insert στο `decision_log` (με `linked_trade_id` NULL)
 *   2. insert στο `paper_trades` με το id του βήματος 1
 *   3. UPDATE του βήματος 1 ώστε να δείχνει στο trade
 *
 * Χωρίς transaction, μια αποτυχία στο βήμα 2 ή 3 αφήνει `entered` decision με
 * `linked_trade_id = NULL` — δηλαδή trade που «έγινε» αλλά δεν υπάρχει, και ένα
 * `decision_log` που δε συμφωνεί με τον εαυτό του.
 *
 * Το `decision` δεν είναι παράμετρος επίτηδες: κλειδώνεται σε `'entered'`, ώστε να μη
 * μπορεί να γραφτεί trade κάτω από `skipped_*`.
 */
export async function recordEntry(
  decision: Omit<NewDecisionLog, 'decision'>,
  trade: Omit<NewPaperTrade, 'decisionLogId'>,
  conn?: pg.PoolClient,
): Promise<RecordedEntry> {
  // Invariant του hard-gate cascade: δεν μπαίνει θέση σε token που δεν πέρασε το gate.
  // Δεν είναι στρατηγική — είναι συνέπεια των δεδομένων· ένα τέτοιο row θα δηλητηρίαζε
  // το backtesting της Φάσης 2.
  if (!decision.gatePassed) {
    throw new Error('recordEntry: cannot enter a candidate with gatePassed = false');
  }

  const run = async (client: pg.PoolClient): Promise<RecordedEntry> => {
    const decisionLogId = await insertDecision({ ...decision, decision: 'entered' }, client);
    const tradeId = await openTrade({ ...trade, decisionLogId }, client);
    await client.query('UPDATE decision_log SET linked_trade_id = $2 WHERE id = $1', [
      decisionLogId,
      tradeId,
    ]);
    return { decisionLogId, tradeId };
  };

  // Αν ο caller κρατά ήδη transaction, γίνεται μέρος του — αλλιώς ανοίγουμε δικό μας.
  return conn ? run(conn) : withTransaction(run);
}

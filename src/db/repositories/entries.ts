import type pg from 'pg';
import { withTransaction } from '../tx.js';
import { insertDecision, recordTrigger, type NewDecisionLog, type TriggerRecord } from './decisionLog.js';
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

export interface RecordedSignal {
  decisionLogId: number;
  tradeId: number;
}

/**
 * Σφραγίζει trigger σε υπάρχον gated row ΚΑΙ ανοίγει `mode='log_only'` trade, ατομικά —
 * το αντίστοιχο του `recordEntry` για τη Φάση 1 (CLAUDE.md: log_only ΕΙΝΑΙ ήδη μέρος της
 * Φάσης 1, όχι Φάση 3 — καταγράφουμε τι ΘΑ κάναμε).
 *
 * Ίδιος λόγος για transaction με το `recordEntry`: χωρίς αυτήν, μια αποτυχία μετά το
 * `recordTrigger` αφήνει `decision='signal_logged'` με `linked_trade_id = NULL` — trade
 * που "καταγράφηκε" αλλά δεν υπάρχει.
 *
 * Επιστρέφει `null` όταν το `recordTrigger` δεν ταίριαξε τίποτα (π.χ. race: το row έγινε
 * ήδη `entered` στο μεσοδιάστημα, ή έπαψε πλέον να είναι gated) — ο caller δεν πρέπει να
 * ανοίξει trade χωρίς decision_log row να δείχνει πάνω του.
 */
export async function recordSignal(
  trigger: TriggerRecord,
  trade: Omit<NewPaperTrade, 'decisionLogId' | 'mode'>,
  conn?: pg.PoolClient,
): Promise<RecordedSignal | null> {
  const run = async (client: pg.PoolClient): Promise<RecordedSignal | null> => {
    const decisionLogId = await recordTrigger(trigger, client);
    if (decisionLogId === null) return null;
    const tradeId = await openTrade({ ...trade, decisionLogId, mode: 'log_only' }, client);
    await client.query('UPDATE decision_log SET linked_trade_id = $2 WHERE id = $1', [
      decisionLogId,
      tradeId,
    ]);
    return { decisionLogId, tradeId };
  };

  return conn ? run(conn) : withTransaction(run);
}

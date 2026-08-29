import { db, type Queryable } from '../tx.js';
import { requireRow, toNum } from '../rows.js';
import type { CandidateSource, Chain, Decision, TriggerType } from '../types.js';

/**
 * Κάθε candidate που αξιολογήθηκε γράφεται εδώ — trade ή όχι. Βλ. CLAUDE.md: αν γράφαμε
 * μόνο τα entered, το tuning της Φάσης 2 δε θα μπορούσε ποτέ να μετρήσει αν τα gates
 * είναι πολύ αυστηρά (χαμένοι winners) ή πολύ χαλαρά.
 */
export interface NewDecisionLog {
  tokenAddress: string;
  chain?: Chain;
  logicVersion: string;
  /** Υποχρεωτικό: χωρίς αυτό η ανάλυση αναμειγνύει δύο διαφορετικά sampling frames. */
  candidateSource: CandidateSource;
  /** Το raw snapshot των gate fields ΤΗ ΣΤΙΓΜΗ της αξιολόγησης. */
  gateSnapshot: Record<string, unknown>;
  gatePassed: boolean;
  /** π.χ. "rug_ratio 0.34 > max 0.2". null όταν πέρασε. */
  gateFailReason?: string | null;
  triggerType?: TriggerType | null;
  triggerWalletAddress?: string | null;
  /** Τα scores του wallet ΤΟΤΕ, όχι σήμερα — αλλιώς το backtest είναι μεροληπτικό. */
  triggerWalletSnapshot?: Record<string, unknown> | null;
  decision: Decision;
  decisionReasonText?: string | null;
}

const INSERT_SQL = `
  INSERT INTO decision_log (
    token_address, chain, logic_version, candidate_source,
    gate_snapshot_json, gate_passed, gate_fail_reason,
    trigger_type, trigger_wallet_address, trigger_wallet_snapshot_json,
    decision, decision_reason_text
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  RETURNING id
`;

export async function insertDecision(
  input: NewDecisionLog,
  conn?: Queryable,
): Promise<number> {
  const { rows } = await db(conn).query<{ id: string }>(INSERT_SQL, [
    input.tokenAddress,
    input.chain ?? 'sol',
    input.logicVersion,
    input.candidateSource,
    input.gateSnapshot,
    input.gatePassed,
    input.gateFailReason ?? null,
    input.triggerType ?? null,
    input.triggerWalletAddress ?? null,
    input.triggerWalletSnapshot ?? null,
    input.decision,
    input.decisionReasonText ?? null,
  ]);
  return toNum(requireRow(rows, 'insertDecision').id);
}

/**
 * Bulk insert για τον ungated κύκλο: ~60 rows ανά poll, ένα round-trip αντί για 60.
 * Το `UNNEST` κρατά ένα μόνο statement ανεξάρτητα από το πλήθος.
 */
export async function insertDecisions(
  inputs: readonly NewDecisionLog[],
  conn?: Queryable,
): Promise<number[]> {
  if (inputs.length === 0) return [];
  const { rows } = await db(conn).query<{ id: string }>(
    `
    INSERT INTO decision_log (
      token_address, chain, logic_version, candidate_source,
      gate_snapshot_json, gate_passed, gate_fail_reason,
      trigger_type, trigger_wallet_address, trigger_wallet_snapshot_json,
      decision, decision_reason_text
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::text[],
      $5::jsonb[], $6::boolean[], $7::text[],
      $8::text[], $9::text[], $10::jsonb[],
      $11::text[], $12::text[]
    )
    RETURNING id
    `,
    [
      inputs.map((i) => i.tokenAddress),
      inputs.map((i) => i.chain ?? 'sol'),
      inputs.map((i) => i.logicVersion),
      inputs.map((i) => i.candidateSource),
      inputs.map((i) => JSON.stringify(i.gateSnapshot)),
      inputs.map((i) => i.gatePassed),
      inputs.map((i) => i.gateFailReason ?? null),
      inputs.map((i) => i.triggerType ?? null),
      inputs.map((i) => i.triggerWalletAddress ?? null),
      inputs.map((i) => (i.triggerWalletSnapshot ? JSON.stringify(i.triggerWalletSnapshot) : null)),
      inputs.map((i) => i.decision),
      inputs.map((i) => i.decisionReasonText ?? null),
    ],
  );
  return rows.map((r) => toNum(r.id));
}

export interface UpsertedDecision {
  id: number;
  tokenAddress: string;
  /** 1 = πρώτη φορά που το είδαμε. >1 = το ξανα-αξιολογήσαμε. */
  evaluationCount: number;
}

/**
 * Bulk upsert για τους collector κύκλους: ένα row ανά (token, logic_version,
 * candidate_source), όχι ανά poll tick.
 *
 * Τρία πράγματα αξίζουν προσοχή:
 *
 * 1. Το `WHERE decision_log.decision <> 'entered'` προστατεύει ιστορικό. Μόλις ένα
 *    candidate γίνει `entered`, το row είναι δεμένο με πραγματικό trade μέσω
 *    `linked_trade_id`· ένας επόμενος κύκλος δε πρέπει να το γυρίσει σε `skipped_*` και
 *    να αφήσει ορφανό trade.
 * 2. Τα rows που προστατεύτηκαν έτσι ΔΕΝ επιστρέφονται από το RETURNING — γι' αυτό ο
 *    caller δε πρέπει να υποθέτει `result.length === inputs.length`.
 * 3. Το `SET` γράφει ΚΑΙ τα τρία trigger πεδία σε κάθε evaluation — ο caller (πάντα ο
 *    discovery collector) δεν ξέρει ποτέ για πραγματικό trigger, άρα κάθε input εδώ
 *    έχει ήδη `triggerType: 'none'`/`triggerWalletAddress: null`. Χωρίς αυτό, ένα row
 *    που το `recordTrigger()` είχε προηγουμένως σφραγίσει σε `signal_logged` με
 *    πραγματικό wallet θα κρατούσε το ΙΔΙΟ wallet_address για πάντα, ακόμα κι όταν ο
 *    επόμενος discovery κύκλος το ξαναγυρίσει σε `skipped_gate` — decision και trigger
 *    θα διαφωνούσαν (επιβεβαιωμένο σε production row, 2026-08-26: candidate_source
 *    'sample_window', gate_passed=false, decision='skipped_gate', αλλά trigger_type
 *    ακόμα 'smart_money_buy' με wallet από παλιότερο, ξεχωριστό cycle).
 */
export async function upsertDecisions(
  inputs: readonly NewDecisionLog[],
  conn?: Queryable,
): Promise<UpsertedDecision[]> {
  if (inputs.length === 0) return [];
  const { rows } = await db(conn).query<{
    id: string;
    token_address: string;
    evaluation_count: number;
  }>(
    `
    INSERT INTO decision_log (
      token_address, chain, logic_version, candidate_source,
      gate_snapshot_json, gate_passed, gate_fail_reason,
      trigger_type, trigger_wallet_address, trigger_wallet_snapshot_json,
      decision, decision_reason_text
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::text[],
      $5::jsonb[], $6::boolean[], $7::text[],
      $8::text[], $9::text[], $10::jsonb[],
      $11::text[], $12::text[]
    )
    ON CONFLICT (token_address, logic_version, candidate_source) DO UPDATE SET
      gate_snapshot_json           = EXCLUDED.gate_snapshot_json,
      gate_passed                  = EXCLUDED.gate_passed,
      gate_fail_reason             = EXCLUDED.gate_fail_reason,
      trigger_type                 = EXCLUDED.trigger_type,
      trigger_wallet_address       = EXCLUDED.trigger_wallet_address,
      trigger_wallet_snapshot_json = EXCLUDED.trigger_wallet_snapshot_json,
      decision                     = EXCLUDED.decision,
      decision_reason_text         = EXCLUDED.decision_reason_text,
      last_evaluated_at            = now(),
      evaluation_count             = decision_log.evaluation_count + 1
    WHERE decision_log.decision <> 'entered'
    RETURNING id, token_address, evaluation_count
    `,
    [
      inputs.map((i) => i.tokenAddress),
      inputs.map((i) => i.chain ?? 'sol'),
      inputs.map((i) => i.logicVersion),
      inputs.map((i) => i.candidateSource),
      inputs.map((i) => JSON.stringify(i.gateSnapshot)),
      inputs.map((i) => i.gatePassed),
      inputs.map((i) => i.gateFailReason ?? null),
      inputs.map((i) => i.triggerType ?? null),
      inputs.map((i) => i.triggerWalletAddress ?? null),
      inputs.map((i) => (i.triggerWalletSnapshot ? JSON.stringify(i.triggerWalletSnapshot) : null)),
      inputs.map((i) => i.decision),
      inputs.map((i) => i.decisionReasonText ?? null),
    ],
  );
  return rows.map((row) => ({
    id: toNum(row.id),
    tokenAddress: row.token_address,
    evaluationCount: row.evaluation_count,
  }));
}

/**
 * Ποια από αυτά τα tokens έχουν περάσει το gate κάτω από το τρέχον σετ κανόνων, ΜΑΖΙ με
 * το gate_snapshot_json της αξιολόγησης — χρειάζεται για simulated_entry_price στο
 * paper trading (CLAUDE.md: "simulated_entry_price: το 'price' από το gate_snapshot_json",
 * ΟΧΙ φρέσκο call· η τιμή που ήδη έχουμε είναι αρκετή και δε ρισκάρει επιπλέον weight).
 *
 * Ο trigger του layer 3 είναι η ΤΟΜΗ δύο ρευμάτων, και το gate είναι η μία πλευρά της.
 * Ρωτάμε ανά `logic_version` επίτηδες: ένα token που πέρασε με παλιά thresholds δεν
 * μετράει ως gated σήμερα.
 */
export async function findPassedTokens(
  tokenAddresses: readonly string[],
  logicVersion: string,
  conn?: Queryable,
): Promise<Map<string, Record<string, unknown>>> {
  if (tokenAddresses.length === 0) return new Map();
  const { rows } = await db(conn).query<{ token_address: string; gate_snapshot_json: Record<string, unknown> }>(
    `SELECT DISTINCT ON (token_address) token_address, gate_snapshot_json
       FROM decision_log
      WHERE logic_version = $2 AND gate_passed AND token_address = ANY($1::text[])
      ORDER BY token_address, last_evaluated_at DESC`,
    [[...tokenAddresses], logicVersion],
  );
  return new Map(rows.map((row) => [row.token_address, row.gate_snapshot_json]));
}

export interface TriggerRecord {
  tokenAddress: string;
  logicVersion: string;
  triggerType: TriggerType;
  triggerWalletAddress: string;
  triggerWalletSnapshot: Record<string, unknown>;
  decision: Decision;
  decisionReasonText: string;
}

/**
 * Σφραγίζει τον trigger πάνω στο υπάρχον gated row του token.
 *
 * Δεν φτιάχνει νέο row: το candidate ήταν ήδη καταγεγραμμένο από τον discovery κύκλο, και
 * ένα δεύτερο row θα διπλομέτραγε το ίδιο token στα pass-rate stats.
 *
 * Το `decision <> 'entered'` προστατεύει ιστορικό, ενώ το `linked_trade_id IS NULL`
 * διασφαλίζει ότι ένα candidate δε δημιουργεί δεύτερο paper trade μετά το πρώτο signal.
 * Το `gate_passed` στο WHERE είναι η δεύτερη μισή του κανόνα εισόδου: trigger σε token που
 * δεν πέρασε το gate ΔΕΝ είναι signal.
 *
 * Επιστρέφει το `id` (όχι μόνο rowCount) ώστε ο caller να μπορεί να συνδέσει ατομικά ένα
 * paper_trades row — βλ. `recordSignal` στο entries.ts. `null` όταν δεν ταίριαξε τίποτα
 * (π.χ. το row συνδέθηκε ήδη με trade στο μεσοδιάστημα).
 */
export async function recordTrigger(
  input: TriggerRecord,
  conn?: Queryable,
): Promise<number | null> {
  const { rows } = await db(conn).query<{ id: string }>(
    `UPDATE decision_log
        SET trigger_type = $3,
            trigger_wallet_address = $4,
            trigger_wallet_snapshot_json = $5,
            decision = $6,
            decision_reason_text = $7,
            last_evaluated_at = now()
      WHERE token_address = $1
        AND logic_version = $2
        AND gate_passed
        AND decision <> 'entered'
        AND linked_trade_id IS NULL
      RETURNING id`,
    [
      input.tokenAddress,
      input.logicVersion,
      input.triggerType,
      input.triggerWalletAddress,
      JSON.stringify(input.triggerWalletSnapshot),
      input.decision,
      input.decisionReasonText,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : toNum(row.id);
}

/** Το βασικό ερώτημα του tuning: pass-rate ανά provenance, ΠΟΤΕ αναμεμιγμένο. */
export async function gatePassRate(
  logicVersion: string,
  candidateSource: CandidateSource,
  conn?: Queryable,
): Promise<{ evaluated: number; passed: number }> {
  const { rows } = await db(conn).query<{ evaluated: string; passed: string }>(
    `SELECT count(*) AS evaluated, count(*) FILTER (WHERE gate_passed) AS passed
       FROM decision_log
      WHERE logic_version = $1 AND candidate_source = $2`,
    [logicVersion, candidateSource],
  );
  const row = requireRow(rows, 'gatePassRate');
  return { evaluated: toNum(row.evaluated), passed: toNum(row.passed) };
}

export interface DecisionSummary {
  id: number;
  tokenAddress: string;
  triggerType: TriggerType | null;
  triggerWalletAddress: string | null;
}

/**
 * Το exit-resolver χρειάζεται το trigger wallet ενός open trade για να ελέγξει αν
 * ΠΟΥΛΗΣΕ (exit_signal) — αυτό ζει στο `decision_log`, ΟΧΙ στο `paper_trades` (το
 * `paper_trades.decision_log_id` είναι το μόνο link). Δεν αντιγράφουμε το wallet address
 * στο `paper_trades` επίτηδες: μία πηγή αλήθειας, όχι διπλή συντήρηση.
 */
export async function getDecisionById(id: number, conn?: Queryable): Promise<DecisionSummary | null> {
  const { rows } = await db(conn).query<{
    id: string;
    token_address: string;
    trigger_type: TriggerType | null;
    trigger_wallet_address: string | null;
  }>(
    `SELECT id, token_address, trigger_type, trigger_wallet_address
       FROM decision_log WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: toNum(row.id),
    tokenAddress: row.token_address,
    triggerType: row.trigger_type,
    triggerWalletAddress: row.trigger_wallet_address,
  };
}

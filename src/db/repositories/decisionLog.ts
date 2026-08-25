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

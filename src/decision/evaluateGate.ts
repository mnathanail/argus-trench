import {
  GATE_FIELD_BY_FLAG,
  type GateThresholds,
  type TrenchCandidate,
} from '../gmgn/trenches.js';

export interface GateEvaluation {
  passed: boolean;
  /** null όταν πέρασε. Αλλιώς όλοι οι λόγοι, χωρισμένοι με `; `. */
  failReason: string | null;
  /** Πόσα κριτήρια απέτυχαν λόγω απόντος πεδίου — το μετράει η Φάση 2 ξεχωριστά. */
  missingFieldCount: number;
}

/**
 * Το client-side σκέλος του hard-gate.
 *
 * Εφαρμόζει τα ΙΔΙΑ thresholds που στέλνουμε server-side, μέσω του `GATE_FIELD_BY_FLAG`
 * ώστε flag και field να μη ξεφύγουν ποτέ. Χρειάζεται μόνο για τον ungated κύκλο: το
 * gated response επιστρέφει αποκλειστικά survivors, άρα τα `skipped_gate` rows δεν
 * υπάρχει άλλος τρόπος να παραχθούν.
 *
 * **Fail closed στα null.** Ένα hard-gate δεν περνά με απούσα απόδειξη. Το είδαμε να
 * συμβαίνει στην πράξη (`private_vault_hold_rate` κενό σε όλα τα results), και ένα
 * fail-open θα περνούσε σιωπηλά tokens που ποτέ δεν ελέγχθηκαν. Ο λόγος αποτυχίας
 * καταγράφεται διακριτά ως "missing", ώστε η Φάση 2 να μπορεί να μετρήσει πόσο συχνά
 * συμβαίνει και αν μας κόβει winners.
 */
export function evaluateGate(
  candidate: TrenchCandidate,
  thresholds: GateThresholds,
): GateEvaluation {
  const reasons: string[] = [];
  let missingFieldCount = 0;

  for (const [key, limit] of Object.entries(thresholds) as [keyof GateThresholds, number | undefined][]) {
    if (limit === undefined) continue;
    const field = GATE_FIELD_BY_FLAG[key];
    const value = readNumber(candidate, field);

    if (value === null) {
      missingFieldCount += 1;
      reasons.push(`${field} missing (fail-closed)`);
      continue;
    }
    if (key.startsWith('max') && value > limit) {
      reasons.push(`${field} ${format(value)} > max ${format(limit)}`);
    } else if (key.startsWith('min') && value < limit) {
      reasons.push(`${field} ${format(value)} < min ${format(limit)}`);
    }
  }

  return {
    passed: reasons.length === 0,
    failReason: reasons.length === 0 ? null : reasons.join('; '),
    missingFieldCount,
  };
}

/**
 * Διαβάζει από το `raw`, όχι από το parsed `gate`: το raw καλύπτει και πεδία που δεν
 * έχουν θέση στο `GateMetrics`, και ο αριθμός των fields δεν είναι σταθερός (μετρήσαμε
 * 89 και 97 στο ίδιο endpoint).
 */
function readNumber(candidate: TrenchCandidate, field: string): number | null {
  const value = candidate.raw[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

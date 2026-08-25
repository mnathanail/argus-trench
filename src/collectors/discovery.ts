import { upsertDecisions, type NewDecisionLog } from '../db/repositories/decisionLog.js';
import { evaluateGate } from '../decision/evaluateGate.js';
import { LAUNCHPAD_PLATFORMS, PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import { fetchTrenches, type TrenchCandidate } from '../gmgn/trenches.js';
import type { GateThresholds, TrenchCategory } from '../gmgn/trenches.js';

/**
 * Discovery κύκλος — layer 1. **Δύο calls, όχι ένα** (βλ. CLAUDE.md):
 *
 * - *gated*: τα actionable candidates. Το server-side filtering φτάνει πολύ βαθύτερα στο
 *   pool (μετρημένο: 60 survivors έναντι 15 στο ungated window).
 * - *ungated*: η ΜΟΝΗ πηγή `skipped_gate` rows, αφού το gated response επιστρέφει
 *   αποκλειστικά survivors. Εφαρμόζουμε τα ίδια thresholds client-side.
 *
 * Καμία συναλλαγή, καμία απόφαση εισόδου. Ο trigger (layer 3) είναι ξεχωριστός collector·
 * εδώ όλα τα rows είναι `skipped_no_trigger` ή `skipped_gate`.
 */
export interface DiscoveryOptions {
  category?: TrenchCategory;
  thresholds?: GateThresholds;
  platforms?: readonly string[];
  chain?: string;
}

export interface DiscoveryResult {
  version: string;
  gatedCandidates: number;
  sampledCandidates: number;
  sampledPassed: number;
  sampledFailed: number;
  /** Πόσα rows γράφτηκαν· μικρότερο από το σύνολο όταν προστατεύτηκαν `entered` rows. */
  rowsWritten: number;
}

export async function runDiscoveryCycle(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const thresholds = options.thresholds ?? PHASE1_THRESHOLDS;
  const version = logicVersion(thresholds);
  const category = options.category ?? 'near_completion';
  const platforms = options.platforms ?? LAUNCHPAD_PLATFORMS;
  const base = { category, launchpadPlatforms: platforms, ...(options.chain ? { chain: options.chain } : {}) };

  // Σειριακά και όχι παράλληλα: ο rate limiter είναι κοινός, οπότε το παράλληλο δε
  // κερδίζει χρόνο — απλώς κάνει τη σειρά των logs μη ντετερμινιστική.
  const gated = await fetchTrenches({ ...base, thresholds });
  const sampled = await fetchTrenches(base);

  const rows: NewDecisionLog[] = [];

  // Το gated set έχει ήδη περάσει server-side. Δεν το ξανα-κρίνουμε: αν το client-side
  // διαφωνούσε, θα ήταν bug στο mapping και θέλουμε να φαίνεται, όχι να διορθώνεται σιωπηλά.
  for (const candidate of gated) {
    rows.push(toRow(candidate, version, 'gated_pool', true, null));
  }

  let sampledPassed = 0;
  for (const candidate of sampled) {
    const evaluation = evaluateGate(candidate, thresholds);
    if (evaluation.passed) sampledPassed += 1;
    rows.push(toRow(candidate, version, 'sample_window', evaluation.passed, evaluation.failReason));
  }

  const written = await upsertDecisions(rows);

  return {
    version,
    gatedCandidates: gated.length,
    sampledCandidates: sampled.length,
    sampledPassed,
    sampledFailed: sampled.length - sampledPassed,
    rowsWritten: written.length,
  };
}

function toRow(
  candidate: TrenchCandidate,
  logicVersionTag: string,
  candidateSource: 'gated_pool' | 'sample_window',
  gatePassed: boolean,
  gateFailReason: string | null,
): NewDecisionLog {
  return {
    tokenAddress: candidate.tokenAddress,
    logicVersion: logicVersionTag,
    candidateSource,
    // Το raw αυτούσιο: ο αριθμός των fields δεν είναι σταθερός (89 και 97 στο ίδιο
    // endpoint), άρα οποιαδήποτε επιλογή πεδίων θα έχανε δεδομένα που θα θέλαμε στη Φάση 2.
    gateSnapshot: candidate.raw,
    gatePassed,
    gateFailReason,
    triggerType: 'none',
    decision: gatePassed ? 'skipped_no_trigger' : 'skipped_gate',
    decisionReasonText: gatePassed
      ? 'πέρασε το gate, κανένα trusted wallet δεν αγόρασε ακόμα'
      : (gateFailReason ?? 'κόπηκε στο gate'),
  };
}

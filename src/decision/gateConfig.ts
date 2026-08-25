import { createHash } from 'node:crypto';
import type { GateThresholds } from '../gmgn/trenches.js';

/**
 * Τα thresholds του hard-gate, Φάση 1. Ίδιες τιμές με το CLAUDE.md.
 *
 * Επειδή η Φάση 1 είναι log-only, ένα λάθος εδώ κοστίζει μόνο λιγότερα/περισσότερα labels·
 * η Φάση 2 τα συντονίζει πάνω σε πραγματικά logged outcomes. Ό,τι αλλάξει εδώ αλλάζει
 * ΑΥΤΟΜΑΤΑ το `logicVersion()`.
 */
export const PHASE1_THRESHOLDS: GateThresholds = {
  maxRugRatio: 0.2,
  maxBundlerRate: 0.3,
  maxInsiderRatio: 0.3,
  maxTopHolderRate: 0.5,
  minSmartDegenCount: 1,
};

export const LAUNCHPAD_PLATFORMS = ['Pump.fun'] as const;

/** Bump το prefix όταν αλλάζει η *δομή* των κανόνων, όχι απλώς μια τιμή. */
const VERSION_PREFIX = 'gate-v1';

/**
 * `logic_version` = prefix + content hash των thresholds, π.χ. `gate-v1-3f9a2c`.
 *
 * Γιατί hash και όχι χειροκίνητο tag: το `logic_version` είναι το πεδίο πάνω στο οποίο
 * κλειδώνει ΟΛΗ η ανάλυση της Φάσης 2. Με χειροκίνητο bump, μια ξεχασμένη αλλαγή σε ένα
 * threshold συγχωνεύει σιωπηλά δύο διαφορετικά σετ κανόνων κάτω από την ίδια ετικέτα, και
 * το αποτέλεσμα είναι αριθμοί που μοιάζουν έγκυροι αλλά συγκρίνουν ανόμοια πράγματα.
 * Έτσι είναι αδύνατο να ξεχαστεί.
 */
export function logicVersion(thresholds: GateThresholds = PHASE1_THRESHOLDS): string {
  const canonical = Object.entries(thresholds)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',');
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 6);
  return `${VERSION_PREFIX}-${hash}`;
}

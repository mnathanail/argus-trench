import { createHash } from 'node:crypto';
import type { GateThresholds } from '../gmgn/trenches.js';

/**
 * Τα thresholds του hard-gate, Φάση 1. Ίδιες τιμές με το CLAUDE.md.
 *
 * Επειδή η Φάση 1 είναι log-only, ένα λάθος εδώ κοστίζει μόνο λιγότερα/περισσότερα labels·
 * η Φάση 2 τα συντονίζει πάνω σε πραγματικά logged outcomes. Ό,τι αλλάξει εδώ αλλάζει
 * ΑΥΤΟΜΑΤΑ το `logicVersion()`.
 *
 * `maxEntrapmentRatio: 0.3` — ΝΕΟ 2026-09-23, ρητό αίτημα χρήστη, βάσει ανάλυσης
 * πραγματικών δεδομένων (ΟΧΙ μαντεψιάς): πάνω σε 2681 ήδη κλεισμένα trades με γνωστό
 * `entrapment_ratio` (raw πεδίο, ήδη πάντα παρόν — 0% missing σε 17369 candidates/7 μέρες,
 * επιβεβαιωμένο πριν την ενεργοποίηση ακριβώς επειδή το gate είναι fail-closed στα null),
 * η κατανομή ήταν: [0-10%) → avg pnl +63.5% (n=2468, η συντριπτική πλειοψηφία), [10-20%) →
 * -17.8% (n=83), [20-30%) → -66.4% (n=20), [30%+) → θετικό αλλά ΠΟΛΥ μικρό δείγμα (n=12
 * συνολικά, με ένα ακραίο outlier +2864% pnl σε ένα μόνο bucket) — όχι αρκετό δείγμα ακόμα
 * για συμπέρασμα εκεί. 0.3 αποκλείει μόνο το καθαρά αρνητικό [20-30%) bucket (20 candidates
 * στο ιστορικό δείγμα), αφήνοντας το ασαφές πάνω άκρο ανέγγιχτο μέχρι να μαζευτεί
 * μεγαλύτερο δείγμα εκεί — ίδιο συντηρητικό, δεδομενοβασισμένο μοτίβο με το
 * HOLDER_RISK_MAX_PCT. Το CLI flag (`--max-entrapment-ratio`) και το field mapping
 * (`entrapment_ratio`) υπήρχαν ΗΔΗ πλήρως wired στο `trenches.ts` πριν από αυτή την αλλαγή
 * — απλά ανενεργά, χωρίς τιμή εδώ.
 */
export const PHASE1_THRESHOLDS: GateThresholds = {
  maxRugRatio: 0.2,
  maxBundlerRate: 0.3,
  maxInsiderRatio: 0.3,
  maxTopHolderRate: 0.5,
  minSmartDegenCount: 1,
  maxEntrapmentRatio: 0.3,
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

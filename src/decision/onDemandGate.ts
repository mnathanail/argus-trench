import type { TokenInfo, TokenSecurity } from '../gmgn/tokenInfo.js';
import type { GateThresholds } from '../gmgn/trenches.js';
import { LAUNCHPAD_PLATFORMS, PHASE1_THRESHOLDS } from './gateConfig.js';

/**
 * On-demand gate (2026-09-28, ρητή απόφαση χρήστη).
 *
 * Πρόβλημα (μετρημένο 2026-09-28, 119 realtime trades/24h): μπαίναμε κατά διάμεσο 20–26
 * λεπτά μετά τη δημιουργία του token. Ένα σήμα (αγορά από wallet μας) γινόταν trade ΜΟΝΟ
 * αν το token είχε ΗΔΗ περάσει το gate του discovery (GMGN trenches, κάθε 2/5 λεπτά, και
 * μόνο αφού το GMGN μετρήσει ≥1 smart wallet). Η πρώτη, φτηνή αγορά του wallet χανόταν
 * (`gate_not_passed`) και μπαίναμε σε μεταγενέστερη, ακριβότερη.
 *
 * Λύση: όταν ένα wallet μας αγοράζει token ΧΩΡΙΣ καμία αξιολόγηση gate, το ελέγχουμε
 * εκείνη τη στιγμή με `token info` + `token security`, με τα ΙΔΙΑ όρια (PHASE1_THRESHOLDS).
 *
 * Αντιστοίχιση κριτηρίων (όσο πιστά επιτρέπει το API — βλ. gmgn/tokenInfo.ts):
 *  - top_10_holder_rate   → ακριβώς το ίδιο πεδίο.
 *  - bundler              → security.bundler_trader_amount_rate (ίδιο πεδίο με το trenches)
 *                           αν υπάρχει, αλλιώς info.stat.top_bundler_trader_percentage.
 *  - entrapment           → info.stat.top_entrapment_trader_percentage.
 *  - rug_ratio, insider   → security, ΑΝ υπάρχουν· στο πραγματικό output για νέο token
 *                           ΔΕΝ υπήρχαν → καταγράφονται ως `unavailable`, δεν κόβουν.
 *  - smart degen ≥ 1      → το ίδιο το wallet μας που μόλις αγόρασε (smart wallet από
 *                           ορισμού) — δεν περιμένουμε να το μετρήσει το GMGN.
 *  - launchpad            → μόνο Pump.fun, ίδιο με το discovery.
 * Όσα ελέγχονται είναι fail-closed σε null (ίδιο με το κανονικό gate).
 *
 * Επειδή δύο κριτήρια μπορεί να λείπουν, οι είσοδοι αυτές πάνε ΜΟΝΟ paper
 * (LIVE_ON_DEMAND_GATE=false) μέχρι να δείξει το `npm run on-demand-gate-report` ότι
 * αποδίδουν.
 */

export interface OnDemandGateResult {
  passed: boolean;
  failReason: string | null;
  /** Κριτήρια που δεν μπορέσαμε να ελέγξουμε (δεν ήρθαν από το API). */
  unavailable: string[];
  /** Οι τιμές που χρησιμοποιήθηκαν — γράφονται στο gate_snapshot_json. */
  metrics: Record<string, number | string | null>;
}

export function evaluateOnDemandGate(
  info: TokenInfo,
  security: TokenSecurity | null,
  thresholds: GateThresholds = PHASE1_THRESHOLDS,
): OnDemandGateResult {
  const topHolderRate = info.topHolderRate ?? security?.topHolderRate ?? null;
  const bundlerRate = security?.bundlerTraderAmountRate ?? info.bundlerVolumeRate;
  const bundlerSource = security?.bundlerTraderAmountRate != null ? 'security.bundler_trader_amount_rate' : 'info.stat.top_bundler_trader_percentage';
  const metrics: OnDemandGateResult['metrics'] = {
    launchpad_platform: info.launchpadPlatform,
    top_10_holder_rate: topHolderRate,
    bundler_rate: bundlerRate,
    bundler_rate_source: bundlerSource,
    entrapment_rate: info.entrapmentVolumeRate,
    rug_ratio: security?.rugRatio ?? null,
    suspected_insider_hold_rate: security?.insiderHoldRate ?? null,
    smart_wallets_gmgn: info.smartWallets,
  };
  const unavailable: string[] = [];

  const fail = (reason: string): OnDemandGateResult => ({ passed: false, failReason: reason, unavailable, metrics });

  if (!(LAUNCHPAD_PLATFORMS as readonly string[]).includes(info.launchpadPlatform ?? '')) {
    return fail(`launchpad ${info.launchpadPlatform ?? 'άγνωστο'} ∉ ${LAUNCHPAD_PLATFORMS.join(',')}`);
  }

  const required: [string, number | null, number | undefined][] = [
    ['top_10_holder_rate', topHolderRate, thresholds.maxTopHolderRate],
    ['bundler_rate', bundlerRate, thresholds.maxBundlerRate],
    ['entrapment_rate', info.entrapmentVolumeRate, thresholds.maxEntrapmentRatio],
  ];
  for (const [name, value, max] of required) {
    if (max === undefined) continue;
    if (value === null) return fail(`${name} άγνωστο (fail-closed)`);
    if (value > max) return fail(`${name} ${value} > max ${max}`);
  }

  const optional: [string, number | null, number | undefined][] = [
    ['rug_ratio', security?.rugRatio ?? null, thresholds.maxRugRatio],
    ['suspected_insider_hold_rate', security?.insiderHoldRate ?? null, thresholds.maxInsiderRatio],
  ];
  for (const [name, value, max] of optional) {
    if (max === undefined) continue;
    if (value === null) {
      unavailable.push(name);
      continue;
    }
    if (value > max) return fail(`${name} ${value} > max ${max}`);
  }

  return { passed: true, failReason: null, unavailable, metrics };
}

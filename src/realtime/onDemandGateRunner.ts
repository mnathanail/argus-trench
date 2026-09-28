import { hasAnyGateEvaluation, insertOnDemandGateDecision } from '../db/repositories/decisionLog.js';
import { evaluateOnDemandGate } from '../decision/onDemandGate.js';
import {
  ON_DEMAND_GATE_ENABLED,
  ON_DEMAND_GATE_MAX_PER_MINUTE,
  ON_DEMAND_GATE_PRIORITY,
} from '../decision/paperTradingConfig.js';
import { fetchTokenInfo, fetchTokenSecurity, type TokenInfo, type TokenSecurity } from '../gmgn/tokenInfo.js';

/**
 * Εκτέλεση του on-demand gate (βλ. decision/onDemandGate.ts) τη στιγμή που ένα wallet μας
 * αγοράζει token χωρίς αξιολόγηση. Ποτέ δεν πετάει — σε οποιοδήποτε σφάλμα γυρνάει
 * 'skipped' και το σήμα απλά χάνεται όπως πριν (gate_not_passed).
 *
 *  - Ένας έλεγχος ανά token: ταυτόχρονα events για το ίδιο token περιμένουν τον ίδιο
 *    έλεγχο· μετά, το row στη βάση (πέρασε ή όχι) σημαίνει «ήδη αξιολογημένο».
 *  - Όριο ON_DEMAND_GATE_MAX_PER_MINUTE, ώστε ένα burst σημάτων να μη φάει το κοινό GMGN
 *    budget των άλλων loops.
 */

export type OnDemandOutcome = 'passed' | 'failed' | 'skipped';

export interface OnDemandGateDeps {
  enabled: boolean;
  maxPerMinute: number;
  now: () => number;
  hasAnyGateEvaluation: (mint: string, version: string) => Promise<boolean>;
  fetchInfo: (mint: string) => Promise<TokenInfo>;
  fetchSecurity: (mint: string) => Promise<TokenSecurity>;
  insert: typeof insertOnDemandGateDecision;
  log: (line: string) => void;
}

const defaultDeps: OnDemandGateDeps = {
  enabled: ON_DEMAND_GATE_ENABLED,
  maxPerMinute: ON_DEMAND_GATE_MAX_PER_MINUTE,
  now: () => Date.now(),
  hasAnyGateEvaluation: (mint, version) => hasAnyGateEvaluation(mint, version),
  fetchInfo: (mint) => fetchTokenInfo(mint, { priority: ON_DEMAND_GATE_PRIORITY }),
  fetchSecurity: (mint) => fetchTokenSecurity(mint, { priority: ON_DEMAND_GATE_PRIORITY }),
  insert: insertOnDemandGateDecision,
  log: (line) => console.log(line),
};

const inFlight = new Map<string, Promise<OnDemandOutcome>>();
let recentChecks: number[] = [];

/** Μόνο για tests. */
export function resetOnDemandGateState(): void {
  inFlight.clear();
  recentChecks = [];
}

export function tryOnDemandGate(
  mint: string,
  version: string,
  deps: OnDemandGateDeps = defaultDeps,
): Promise<OnDemandOutcome> {
  if (!deps.enabled) return Promise.resolve('skipped');
  const existing = inFlight.get(mint);
  if (existing !== undefined) return existing;
  const run = runOnce(mint, version, deps).finally(() => inFlight.delete(mint));
  inFlight.set(mint, run);
  return run;
}

async function runOnce(mint: string, version: string, deps: OnDemandGateDeps): Promise<OnDemandOutcome> {
  const tag = `[on-demand-gate] mint=${mint.slice(0, 8)}`;
  try {
    if (await deps.hasAnyGateEvaluation(mint, version)) return 'skipped';

    const now = deps.now();
    recentChecks = recentChecks.filter((t) => now - t < 60_000);
    if (recentChecks.length >= deps.maxPerMinute) {
      deps.log(`${tag} skipped: rate cap ${deps.maxPerMinute}/min`);
      return 'skipped';
    }
    recentChecks.push(now);

    const [info, security] = await Promise.all([
      deps.fetchInfo(mint),
      // Το security είναι συμπληρωματικό (rug/insider, αν τα δώσει) — αποτυχία του δεν
      // ακυρώνει τον έλεγχο.
      deps.fetchSecurity(mint).catch((error: unknown) => {
        deps.log(`${tag} token security απέτυχε (συνεχίζουμε χωρίς): ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    ]);
    const result = evaluateOnDemandGate(info, security);
    await deps.insert({
      tokenAddress: mint,
      logicVersion: version,
      gateSnapshot: {
        source: 'on_demand',
        created_timestamp: info.creationTimestamp,
        holder_count: info.holderCount,
        checked_at: new Date(now).toISOString(),
        unavailable: result.unavailable,
        ...result.metrics,
      },
      gatePassed: result.passed,
      gateFailReason: result.failReason,
    });
    deps.log(
      `${tag} ${result.passed ? 'ΠΕΡΑΣΕ' : `απορρίφθηκε: ${result.failReason}`}` +
        (result.unavailable.length > 0 ? ` (χωρίς: ${result.unavailable.join(',')})` : ''),
    );
    return result.passed ? 'passed' : 'failed';
  } catch (error) {
    deps.log(`${tag} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return 'skipped';
  }
}

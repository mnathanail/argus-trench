import { rethrowIfRateLimited } from '../gmgn/errors.js';
import type { RunOptions } from '../gmgn/exec.js';
import { computeFloatShare, computeRiskWalletPct, fetchAllTokenHolders, isFloatDegenerate } from '../gmgn/holderRisk.js';

/**
 * Holder risk: τι ποσοστό του float κρατούν bundler / rat_trader / sniper wallets
 * (gmgn/holderRisk.ts). Μεταφέρθηκε εδώ 2026-09-29 από το κανάλι GMGN smart money (που
 * σταμάτησε), ώστε να ελέγχεται ΚΑΙ στις δικές μας realtime/live αγορές.
 *
 * Τεκμηρίωση ορίου (2026-09-22, 1136 κλειστά σήματα του καναλιού GMGN smart money):
 *   <10% → +10.5% (n=35) · 10–30% → −53.4% (110) · 30–50% → −86.2% (272) ·
 *   ≥50% → −92.9%, win rate 1.7% (460).
 * `null` (δεν ελέγχθηκε / degenerate float / σφάλμα) ΔΕΝ αποκλείει ποτέ — απουσία
 * στοιχείων δεν είναι απόδειξη κινδύνου.
 */
export const HOLDER_RISK_MAX_PCT = 0.5;

export function isHighHolderRisk(riskPct: number | null): boolean {
  return riskPct !== null && riskPct >= HOLDER_RISK_MAX_PCT;
}

export interface HolderRiskSnapshot {
  riskPct: number | null;
  riskWalletCount: number | null;
  /** false = δεν έγινε καν έλεγχος (σφάλμα/rate limit)· true με riskPct null = degenerate float. */
  checked: boolean;
}

export const HOLDER_RISK_NOT_CHECKED: HolderRiskSnapshot = { riskPct: null, riskWalletCount: null, checked: false };

/** Ποτέ δεν πετάει. `rateLimited` = το σφάλμα ήταν 429 (ο caller μπορεί να σταματήσει να ξαναδοκιμάζει). */
export async function tryComputeHolderRisk(
  tokenAddress: string,
  options: RunOptions = {},
): Promise<{ snapshot: HolderRiskSnapshot; rateLimited: boolean }> {
  try {
    const holders = await fetchAllTokenHolders({ tokenAddress, ...options });
    const float = computeFloatShare(holders);
    const normalCount = holders.filter((h) => h.addrType === 0).length;
    if (isFloatDegenerate(float, normalCount)) {
      return { snapshot: { riskPct: null, riskWalletCount: null, checked: true }, rateLimited: false };
    }
    const risk = computeRiskWalletPct(holders, float);
    return { snapshot: { riskPct: risk.riskPct, riskWalletCount: risk.riskWalletCount, checked: true }, rateLimited: false };
  } catch (error) {
    let rateLimited = false;
    try {
      rethrowIfRateLimited(error);
    } catch {
      rateLimited = true;
    }
    return { snapshot: HOLDER_RISK_NOT_CHECKED, rateLimited };
  }
}

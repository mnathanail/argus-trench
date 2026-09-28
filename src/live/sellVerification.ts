import { fetchTokenBalance } from '../gmgn/tokenBalance.js';
import { getLiveSolBalance } from '../gmgn/portfolio.js';
import { delay } from '../util/delay.js';

/**
 * Τι πραγματικά συνέβη όταν το `executeLiveSell` πέταξε error.
 *
 * ΠΡΑΓΜΑΤΙΚΟ INCIDENT 2026-09-27/28: 14 live trades σημαδεύτηκαν needs_manual_exit μετά
 * από "αποτυχημένη" πώληση — ενώ τουλάχιστον μία (trade 6442, 3RNy7erx…) είχε ΠΡΑΓΜΑΤΙΚΑ
 * εκτελεστεί on-chain (+104%, επιβεβαιωμένο από τον χρήστη· καμία χειροκίνητη πώληση,
 * κανένα native order). Το gmgn-cli επέστρεψε error αφού το swap είχε ήδη περάσει. Το error
 * του CLI δεν είναι αξιόπιστη απόδειξη αποτυχίας — το on-chain υπόλοιπο είναι.
 *
 * - `sold`: το token έφυγε ΚΑΙ μπήκε SOL στο wallet → η ΔΙΚΗ μας πώληση εκτελέστηκε.
 * - `gone_elsewhere`: το token έφυγε αλλά δεν μπήκε SOL → πουλήθηκε νωρίτερα από κάπου αλλού
 *   (ή ταυτόχρονο buy άλλου trade κάλυψε τα έσοδα) — δεν ξέρουμε το πραγματικό αποτέλεσμα.
 * - `still_held`: τα tokens είναι ακόμα στο wallet → η πώληση πράγματι δεν έγινε.
 * - `unknown`: οι έλεγχοι υπολοίπου απέτυχαν οι ίδιοι.
 */
export type SellFailureVerdict =
  | { kind: 'sold'; proceedsSol: number }
  | { kind: 'gone_elsewhere' }
  | { kind: 'still_held'; tokenBalance: number }
  | { kind: 'unknown' };

/** Καθαρή, τεσταρίσιμη ταξινόμηση. `solProceeds` = SOL υπόλοιπο τώρα − SOL υπόλοιπο πριν την πώληση. */
export function classifySellFailure(tokenBalance: number | null, solProceeds: number | null): SellFailureVerdict {
  if (tokenBalance === null) return { kind: 'unknown' };
  if (tokenBalance > 0) return { kind: 'still_held', tokenBalance };
  if (solProceeds !== null && solProceeds > 0) return { kind: 'sold', proceedsSol: solProceeds };
  // Token 0, αλλά είτε δεν μπήκε SOL είτε δεν διαβάστηκε το SOL υπόλοιπο. Fail-safe: ΔΕΝ
  // κλείνουμε το trade με υποθετικά νούμερα — ο caller πέφτει σε needs_manual_exit.
  return { kind: 'gone_elsewhere' };
}

/** Πόσες φορές / κάθε πόσο ξανακοιτάμε το υπόλοιπο — το GMGN balance index μπορεί να
 * καθυστερεί λίγα δευτερόλεπτα μετά το on-chain settlement. Σύνολο ~12s. */
export const SELL_VERIFY_ATTEMPTS = 3;
export const SELL_VERIFY_DELAY_MS = 4_000;

export interface SellVerificationDeps {
  fetchTokenBalance: (wallet: string, token: string) => Promise<number>;
  getSolBalance: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: SellVerificationDeps = {
  fetchTokenBalance: (wallet, token) => fetchTokenBalance(wallet, token),
  getSolBalance: () => getLiveSolBalance(),
  sleep: delay,
};

/**
 * Μετά από error στην πώληση: ελέγχει το ΠΡΑΓΜΑΤΙΚΟ υπόλοιπο του token (με επαναλήψεις για
 * το settlement) και, αν έφυγε, πόσο SOL μπήκε. Ποτέ δεν πετάει — σφάλματα στους ίδιους
 * τους ελέγχους καταλήγουν `unknown`.
 */
export async function verifySellAfterError(
  walletAddress: string,
  tokenAddress: string,
  solBalanceBeforeSell: number,
  deps: SellVerificationDeps = defaultDeps,
): Promise<SellFailureVerdict> {
  let lastTokenBalance: number | null = null;
  for (let attempt = 0; attempt < SELL_VERIFY_ATTEMPTS; attempt++) {
    await deps.sleep(SELL_VERIFY_DELAY_MS);
    try {
      lastTokenBalance = await deps.fetchTokenBalance(walletAddress, tokenAddress);
    } catch {
      lastTokenBalance = null;
      continue;
    }
    if (lastTokenBalance > 0) continue; // ίσως ακόμα δεν έχει ενημερωθεί — ξανακοίτα
    let solNow: number | null;
    try {
      solNow = await deps.getSolBalance();
    } catch {
      solNow = null;
    }
    return classifySellFailure(0, solNow === null ? null : solNow - solBalanceBeforeSell);
  }
  return classifySellFailure(lastTokenBalance, null);
}

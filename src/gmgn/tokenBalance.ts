import { runCli, type RunOptions } from './exec.js';
import { GmgnResponseError } from './errors.js';
import { expectObject, toNumber } from './validate.js';

/**
 * Watchdog client (2026-09-17, incident #1193 — βλ. migration 0013/0014, CLAUDE.md
 * "Ό,τι μένει ακόμα ανοιχτό"). Route `portfolio token-balance`, weight 1 (ήδη στο
 * routes.ts, ΚΑΝΕΝΑΣ adapter δεν το χρησιμοποιούσε πριν από αυτό) — `GET
 * /v1/user/wallet_token_balance`.
 *
 * Σκοπός: ένα ΔΕΥΤΕΡΟ, ανεξάρτητο δίχτυ ασφαλείας πάνω σε ΟΛΑ τα ανοιχτά `mode='live'`
 * trades (βλ. liveTradeWatchdog.ts) — όχι μόνο όσα έχουν ενεργό native order (αυτά τα
 * καλύπτει ήδη ο liveStrategyReconciler). Διαβάζει το ΠΡΑΓΜΑΤΙΚΟ on-chain token balance
 * του live wallet· αν είναι 0, η θέση έφυγε από κάπου αλλού (π.χ. το websocket feed
 * πάγωσε σιωπηλά χωρίς 'close' event — καμία heartbeat/staleness ανίχνευση υπάρχει ακόμα
 * στο pumpportalConnection.ts) — βλ. σχόλιο στο liveTradeWatchdog.ts.
 *
 * ⚠️ Το `.agents/skills/gmgn-portfolio/SKILL.md` δίνει ΜΟΝΟ usage examples για αυτό το
 * route — ΚΑΜΙΑ τεκμηρίωση response schema (επιβεβαιωμένο 2026-09-17). Δεν μπορούμε να
 * το δοκιμάσουμε live εδώ (χωρίς πραγματικό API key σε αυτό το sandbox) — γραμμένο
 * αμυντικά, δοκιμάζοντας τα πιο πιθανά ονόματα πεδίων και πετώντας `GmgnResponseError`
 * με πλήρες context αν κανένα δεν ταιριάζει, ίδιο σκεπτικό με `parsePortfolioInfoSol*`
 * στο portfolio.ts. Αν αργότερα φανεί το πραγματικό σχήμα, μόνο αυτό το αρχείο αλλάζει.
 */

export async function fetchTokenBalance(
  walletAddress: string,
  tokenAddress: string,
  options: RunOptions = {},
): Promise<number> {
  const raw = await runCli(
    'portfolio token-balance',
    ['portfolio', 'token-balance', '--chain', 'sol', '--wallet', walletAddress, '--token', tokenAddress],
    options,
  );
  return parseTokenBalance(raw);
}

/** Εξαγόμενο ξεχωριστά ώστε να τεσταρίζεται χωρίς πραγματικό CLI call (ίδιο pattern με
 * parsePortfolioInfoSolBalances). Δοκιμάζει, με σειρά προτεραιότητας, τα πιο πιθανά
 * top-level ονόματα πεδίου για ένα single-value balance response. */
export function parseTokenBalance(raw: unknown): number {
  const response = expectObject(raw, 'portfolio.token-balance');

  const candidateKeys = ['balance', 'token_balance', 'amount', 'ui_amount'] as const;
  for (const key of candidateKeys) {
    const value = response[key];
    if (value !== undefined && value !== null) {
      return toNumber(value, `portfolio.token-balance.${key}`);
    }
  }

  throw new GmgnResponseError(
    `no recognized balance field (tried: ${candidateKeys.join(', ')})`,
    'portfolio.token-balance',
  );
}

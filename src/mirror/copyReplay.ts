/**
 * 2026-09-30 — «τι θα έβγαινε;» πάνω στις ΠΡΑΓΜΑΤΙΚΕΣ on-chain συναλλαγές ενός wallet (Helius,
 * ίδια ανάγνωση με το mirror — επιβεβαιωμένη 11/11 με το GMGN). Καθαρές συναρτήσεις.
 *
 * Επεισόδιο = από την πρώτη αγορά ενός token μέχρι να μηδενίσει το υπόλοιπό του (ξανά αγορά
 * μετά = νέο επεισόδιο, όπως μια νέα mirror θέση). Αν το πρώτο που βλέπουμε είναι πώληση
 * (αγόρασε πριν το παράθυρο), το επεισόδιο είναι ελλιπές και δεν μετράει.
 *
 * Τρόποι αντιγραφής (και οι δύο βγαίνουν μαζί του, στο ίδιο % με εκείνον):
 *   all   = κάθε αγορά του = buySol (όπως το mirror σήμερα)
 *   first = μόνο η πρώτη αγορά του επεισοδίου = buySol
 * Υποθέσεις όπως το paper mirror: αγορά στην τιμή του + slippage, πώληση στην τιμή του,
 * fees % πάνω στο ποσό εισόδου.
 */

export interface WalletTrade {
  mint: string;
  txType: 'buy' | 'sell';
  sol: number;
  tokens: number;
  balanceAfter: number;
  blockTime: number;
  signature: string;
}

export interface Episode {
  mint: string;
  startTime: number;
  endTime: number;
  closed: boolean;
  trades: WalletTrade[];
}

export function splitEpisodes(trades: readonly WalletTrade[]): { episodes: Episode[]; incomplete: number } {
  const byMint = new Map<string, WalletTrade[]>();
  for (const t of [...trades].sort((a, b) => a.blockTime - b.blockTime)) byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
  const episodes: Episode[] = [];
  let incomplete = 0;
  for (const [mint, list] of byMint) {
    let current: WalletTrade[] | null = null;
    let skipping = false;
    for (const t of list) {
      if (current === null) {
        // Ήδη κρατούσε από πριν το παράθυρο (πρώτο που βλέπουμε: πώληση, ή αγορά ενώ κρατάει
        // ακόμα) → ελλιπές επεισόδιο, αγνόησε μέχρι να μηδενίσει.
        const heldBefore = t.txType === 'sell' || t.balanceAfter - t.tokens > 1e-9;
        if (skipping || heldBefore) {
          if (!skipping) incomplete += 1;
          skipping = t.balanceAfter > 1e-9 && !(t.txType === 'sell' && isFullExit(t));
          continue;
        }
        current = [];
      }
      current.push(t);
      if (t.txType === 'sell' && isFullExit(t)) {
        episodes.push({ mint, startTime: current[0]!.blockTime, endTime: t.blockTime, closed: true, trades: current });
        current = null;
      }
    }
    if (current !== null && current.length > 0) {
      episodes.push({ mint, startTime: current[0]!.blockTime, endTime: current.at(-1)!.blockTime, closed: false, trades: current });
    }
  }
  return { episodes: episodes.sort((a, b) => a.startTime - b.startTime), incomplete };
}

const FULL_EXIT_PCT = 0.99;
function sellPct(t: WalletTrade): number {
  const before = t.balanceAfter + t.tokens;
  if (!(before > 0)) return 1;
  const pct = t.tokens / before;
  return pct >= FULL_EXIT_PCT ? 1 : pct;
}
function isFullExit(t: WalletTrade): boolean {
  return sellPct(t) === 1;
}

export interface ReplayResult {
  solIn: number;
  solOut: number;
  pnlSol: number;
  pnlPct: number | null;
  buys: number;
  /** Ποσό που μένει ανοιχτό, αποτιμημένο στην τελευταία τιμή. */
  openValueSol: number;
}

/** Τι έβγαλε ο ίδιος (SOL από/προς το pool, χωρίς τα δικά του fees). */
export function walletResult(ep: Episode): ReplayResult {
  let solIn = 0;
  let solOut = 0;
  let buys = 0;
  for (const t of ep.trades) {
    if (t.txType === 'buy') {
      solIn += t.sol;
      buys += 1;
    } else solOut += t.sol;
  }
  const last = ep.trades.at(-1)!;
  const lastPrice = last.sol / last.tokens;
  const openValueSol = ep.closed ? 0 : last.balanceAfter * lastPrice;
  const pnlSol = solOut + openValueSol - solIn;
  return { solIn, solOut, pnlSol, pnlPct: solIn > 0 ? pnlSol / solIn : null, buys, openValueSol };
}

export function copyResult(
  ep: Episode,
  mode: 'all' | 'first',
  opts: { buySol: number; slippagePct: number; feesPct: number },
): ReplayResult {
  let tokens = 0;
  let solIn = 0;
  let solOut = 0;
  let buys = 0;
  for (const t of ep.trades) {
    const price = t.sol / t.tokens;
    if (!(price > 0)) continue;
    if (t.txType === 'buy') {
      if (mode === 'first' && buys > 0) continue;
      tokens += opts.buySol / (price * (1 + opts.slippagePct));
      solIn += opts.buySol;
      buys += 1;
    } else if (tokens > 0) {
      const sold = tokens * sellPct(t);
      solOut += sold * price;
      tokens -= sold;
    }
  }
  const last = ep.trades.at(-1)!;
  const openValueSol = tokens > 0 ? tokens * (last.sol / last.tokens) : 0;
  const pnlSol = solOut + openValueSol - solIn - solIn * opts.feesPct;
  return { solIn, solOut, pnlSol, pnlPct: solIn > 0 ? pnlSol / solIn : null, buys, openValueSol };
}

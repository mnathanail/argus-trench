import { fetchWalletBuys, fetchWalletSells, type WalletActivity } from '../gmgn/activity.js';
import type { RunOptions } from '../gmgn/exec.js';

/**
 * Πραγματικό αποτέλεσμα μιας θέσης που πουλήθηκε ΕΚΤΟΣ της δικής μας διαδρομής πώλησης
 * (native GMGN strategy, ή πώληση που δεν καταγράφηκε) — 2026-09-29.
 *
 * Γιατί όχι από το `order strategy list`: το `close_price` έρχεται ΠΑΝΤΑ κενό, και τα
 * `check_price`/`usdt_profit` αποδείχθηκαν λάθος απέναντι στο Solscan (incident #1225).
 * Εδώ χρησιμοποιούμε τις ΙΔΙΕΣ τις on-chain συναλλαγές του δικού μας wallet (`portfolio
 * activity`): αξία πώλησης σε USD / αξία αγοράς σε USD. Ποσοστό, όχι SOL — το SOL
 * αποτέλεσμα βγαίνει εφαρμόζοντάς το στο πραγματικό actual_entry_amount_sol. Σφάλμα:
 * μόνο η μεταβολή SOL/USD ανάμεσα σε αγορά και πώληση.
 */

export interface OwnSellResult {
  /** αξία πώλησης / αξία αγοράς (π.χ. 0.48 = −52%). */
  ratio: number;
  source: 'cost_usd' | 'price_usd';
  sellTxHash: string;
  sellAt: Date;
}

const BUY_LOOKBACK_MS = 5 * 60_000;

export function computeOwnSellRatio(
  buys: readonly WalletActivity[],
  sells: readonly WalletActivity[],
  tokenAddress: string,
  entryAtMs: number,
): OwnSellResult | null {
  const buy = buys
    .filter((b) => b.tokenAddress === tokenAddress && b.timestamp * 1000 >= entryAtMs - BUY_LOOKBACK_MS)
    .sort((a, b) => Math.abs(a.timestamp * 1000 - entryAtMs) - Math.abs(b.timestamp * 1000 - entryAtMs))[0];
  if (buy === undefined) return null;
  const ownSells = sells
    .filter((s) => s.tokenAddress === tokenAddress && s.timestamp >= buy.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
  const last = ownSells.at(-1);
  if (last === undefined) return null;

  const soldUsd = ownSells.reduce((sum, s) => sum + (s.costUsd ?? NaN), 0);
  if (buy.costUsd !== null && buy.costUsd > 0 && Number.isFinite(soldUsd) && soldUsd >= 0) {
    return { ratio: soldUsd / buy.costUsd, source: 'cost_usd', sellTxHash: last.txHash, sellAt: new Date(last.timestamp * 1000) };
  }
  if (buy.priceUsd !== null && buy.priceUsd > 0 && last.priceUsd !== null) {
    return { ratio: last.priceUsd / buy.priceUsd, source: 'price_usd', sellTxHash: last.txHash, sellAt: new Date(last.timestamp * 1000) };
  }
  return null;
}

export async function findOwnSellRatio(
  walletAddress: string,
  tokenAddress: string,
  entryAt: Date,
  options: RunOptions = {},
): Promise<OwnSellResult | null> {
  const since = entryAt.getTime();
  const [buys, sells] = await Promise.all([
    fetchWalletBuys(walletAddress, { ...options, limit: 50, stopAtTimestamp: since - 2 * BUY_LOOKBACK_MS }),
    fetchWalletSells(walletAddress, { ...options, stopAtTimestamp: since - BUY_LOOKBACK_MS }),
  ]);
  return computeOwnSellRatio(buys.activities, sells.activities, tokenAddress, since);
}

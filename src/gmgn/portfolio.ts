import { runCli, type RunOptions } from './exec.js';
import { GmgnResponseError } from './errors.js';
import { expectArray, expectObject, expectString, toNumber } from './validate.js';

/**
 * Verified against πραγματικό GMGN CLI response (2026-09-11):
 *
 * gmgn-cli portfolio info --raw:
 *   { wallets: [
 *       { chain: "eth", address: "0x...", balances: [{ symbol: "ETH", token_address: "0x0...", balance: "0", usd_value: "" }, ...] },
 *       { chain: "sol", address: "yFb3v4wfoc7fSrxXXJ9YTM6JwMVZdnus5fmKe2A6gH5",
 *         balances: [
 *           { symbol: "SOL", token_address: "So111...1111", balance: "0.020816731", usd_value: "" },
 *           { symbol: "USDC", token_address: "EPjFWdd...", balance: "0", usd_value: "" }
 *         ] },
 *       ... (arbitrum/arc/base/bsc/hyperevm/robinhood/stable, ίδιο EVM address, δε μας αφορούν)
 *   ] }
 *
 * ΚΡΙΣΙΜΟ, επιβεβαιωμένο με πραγματική κατάθεση 2026-09-11: το `balance` είναι
 * ΑΝΘΡΩΠΙΝΕΣ μονάδες SOL (π.χ. "0.020816731"), ΟΧΙ lamports — η δεκαδική τελεία και η
 * ακρίβεια 9 δεκαδικών το επιβεβαιώνουν αδιαμφισβήτητα (lamports θα ήταν ακέραιος).
 * `usd_value` είναι κενό string, όχι number/null — δεν το χρησιμοποιούμε.
 * Πολλαπλά chains στο ΙΔΙΟ response — μας ενδιαφέρει ΜΟΝΟ chain==='sol'.
 */

export interface PortfolioBalance {
  symbol: string;
  balance: number;
}

export async function fetchSolWalletBalances(options: RunOptions = {}): Promise<PortfolioBalance[]> {
  const raw = await runCli('portfolio info', ['portfolio', 'info'], options);
  return parsePortfolioInfoSolBalances(raw);
}

export function parsePortfolioInfoSolBalances(raw: unknown): PortfolioBalance[] {
  const response = expectObject(raw, 'portfolio.info');
  const wallets = expectArray(response['wallets'], 'portfolio.info.wallets');

  const solWalletRaw = wallets.find((w) => {
    if (typeof w !== 'object' || w === null) return false;
    return (w as Record<string, unknown>)['chain'] === 'sol';
  });
  if (solWalletRaw === undefined) {
    // Δεν σκάει σε "0 SOL" σιωπηλά — ο caller (decideTradeMode μέσω κάποιου try/catch)
    // πρέπει να ξέρει ρητά ότι κάτι είναι λάθος στη ρύθμιση, όχι απλά "άδειο πορτοφόλι".
    throw new GmgnResponseError('no sol-chain wallet in response', 'portfolio.info.wallets');
  }
  const solWallet = expectObject(solWalletRaw, 'portfolio.info.wallets[chain=sol]');
  const balances = expectArray(solWallet['balances'], 'portfolio.info.wallets[chain=sol].balances');

  return balances.map((entry, index) => {
    const row = expectObject(entry, `portfolio.info.wallets[chain=sol].balances[${index}]`);
    return {
      symbol: expectString(row['symbol'], `portfolio.info.wallets[chain=sol].balances[${index}].symbol`),
      balance: toNumber(row['balance'], `portfolio.info.wallets[chain=sol].balances[${index}].balance`),
    };
  });
}

/** Το πραγματικό, τρέχον υπόλοιπο SOL του live trading wallet. Πετάει (δεν επιστρέφει 0
 * σιωπηλά) αν το response δεν έχει καν wallet SOL entry — ο caller αποφασίζει πώς να
 * φερθεί σε τέτοιο σφάλμα (η δική μας πρόθεση: fallback σε 'paper' mode, βλ. tradeMode.ts,
 * όχι να ρισκάρει trade με άγνωστο υπόλοιπο). */
export async function getLiveSolBalance(options: RunOptions = {}): Promise<number> {
  const balances = await fetchSolWalletBalances(options);
  const sol = balances.find((b) => b.symbol === 'SOL');
  if (sol === undefined) {
    throw new GmgnResponseError('no SOL balance entry for the sol-chain wallet', 'portfolio.info.wallets[chain=sol].balances');
  }
  return sol.balance;
}

import { runCli, type RunOptions } from './exec.js';
import { expectObject, expectString, toNumber, toNumberOrNull } from './validate.js';

/**
 * Trading στατιστικά ενός wallet — η βάση του scoring στο layer 2.
 *
 * ΠΡΟΣΟΧΗ στη σημασιολογία, γιατί καθορίζει το threshold του CLAUDE.md
 * (`win_rate > 0.5 AND trade_count >= 15`):
 *
 * - Το win rate ΔΕΝ είναι top-level `win_rate`· είναι `pnl_stat.winrate`.
 * - Υπολογίζεται πάνω σε **tokens**, όχι σε trades: τα buckets `pnl_lt_nd5_num`,
 *   `pnl_nd5_0x_num`, `pnl_0x_2x_num`, `pnl_2x_5x_num`, `pnl_gt_5x_num` αθροίζουν
 *   ακριβώς σε `pnl_stat.token_num` (επιβεβαιωμένο: 0+497+549+16+4 = 1066 = token_num).
 * - Άρα το `tradeCount` που ταιριάζει με το winrate είναι το `token_num` (πόσες θέσεις),
 *   ΟΧΙ το `buy + sell` (πόσες συναλλαγές). Το ίδιο wallet έδειξε token_num 1066 ενώ
 *   buy+sell = 5080. Αν βάζαμε το δεύτερο, αριθμητής και παρονομαστής θα μέτραγαν
 *   διαφορετικά πράγματα και το threshold θα ήταν 5× χαλαρότερο απ' όσο νομίζουμε.
 */
export interface WalletStats {
  walletAddress: string;
  /** 0–1. `pnl_stat.winrate`. */
  winRate: number | null;
  /** Πλήθος θέσεων (tokens) — ο παρονομαστής του winRate. */
  tokenCount: number | null;
  /**
   * `realized_profit_pnl`. Είναι **ratio/ROI**, όχι multiplier: 0.3264 σημαίνει +32.6%.
   * Το αποθηκεύουμε ως έχει στο `pnl_multiplier` του schema — βλ. σημείωση στο CLAUDE.md.
   */
  realizedPnlRatio: number | null;
  realizedProfitUsd: number | null;
  buyCount: number | null;
  sellCount: number | null;
  /** Δευτερόλεπτα. Χρήσιμο ως sanity check: sniper bot vs. πραγματικός trader. */
  avgHoldingPeriodSec: number | null;
  lastTradeAt: number | null;
}

export interface FetchWalletStatsOptions extends RunOptions {
  wallet: string;
  chain?: string;
}

export function buildStatsArgs(options: FetchWalletStatsOptions): string[] {
  return ['portfolio', 'stats', '--chain', options.chain ?? 'sol', '--wallet', options.wallet];
}

export async function fetchWalletStats(options: FetchWalletStatsOptions): Promise<WalletStats> {
  const raw = await runCli('portfolio stats', buildStatsArgs(options), options);
  return parseWalletStats(raw);
}

export function parseWalletStats(raw: unknown): WalletStats {
  const root = expectObject(raw, 'response');
  const pnl = isObject(root['pnl_stat'])
    ? (root['pnl_stat'] as Record<string, unknown>)
    : {};

  return {
    walletAddress: expectString(root['wallet_address'], 'wallet_address'),
    winRate: toNumberOrNull(pnl['winrate'], 'pnl_stat.winrate'),
    tokenCount: toNumberOrNull(pnl['token_num'], 'pnl_stat.token_num'),
    realizedPnlRatio: toNumberOrNull(root['realized_profit_pnl'], 'realized_profit_pnl'),
    realizedProfitUsd: toNumberOrNull(root['realized_profit'], 'realized_profit'),
    buyCount: toNumberOrNull(root['buy'], 'buy'),
    sellCount: toNumberOrNull(root['sell'], 'sell'),
    avgHoldingPeriodSec: toNumberOrNull(pnl['avg_holding_period'], 'pnl_stat.avg_holding_period'),
    lastTradeAt: toNumberOrNull(root['last_timestamp'], 'last_timestamp'),
  };
}

/** Ο έλεγχος συνέπειας που μας έσωσε: τα buckets πρέπει να αθροίζουν σε `token_num`. */
export function pnlBucketsSumTo(raw: unknown): { sum: number; tokenNum: number } | null {
  const root = expectObject(raw, 'response');
  if (!isObject(root['pnl_stat'])) return null;
  const pnl = root['pnl_stat'] as Record<string, unknown>;
  const buckets = ['pnl_lt_nd5_num', 'pnl_nd5_0x_num', 'pnl_0x_2x_num', 'pnl_2x_5x_num', 'pnl_gt_5x_num'];
  const sum = buckets.reduce((acc, key) => acc + (toNumberOrNull(pnl[key], key) ?? 0), 0);
  return { sum, tokenNum: toNumber(pnl['token_num'], 'pnl_stat.token_num') };
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

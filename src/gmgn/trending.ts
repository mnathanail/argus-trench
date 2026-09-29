import { GmgnResponseError } from './errors.js';
import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, expectString, toNumberOrNull } from './validate.js';

/**
 * `market trending` (weight 1). 2026-09-29: πηγή tokens για το wallet discovery. Τα
 * «πρόσφατα graduated» (trenches completed) ήταν λάθος επιλογή: το πρώτο πραγματικό
 * `top-traders-check` έδειξε token ηλικίας ~1′ — όλοι οι traders ήταν dev_team/bundler/
 * sniper/fresh_wallet και κανείς δεν είχε προλάβει να κρατήσει ή να πουλήσει. Εδώ παίρνουμε
 * tokens που ΗΔΗ έτρεξαν (ATH market cap ≥ όριο) και είναι 1h–24h παλιά, ώστε οι top
 * traders τους να είναι όσοι όντως έβγαλαν λεφτά.
 *
 * Σχήμα κατά SKILL.md: `data.rank` = πίνακας tokens. Δεχόμαστε και `rank`/`list`/πίνακα στη
 * ρίζα (το CLI έχει κανονικοποιήσει αλλιώς το trenches — βλ. CLAUDE.md), αλλιώς σκάει δυνατά.
 */
export interface TrendingToken {
  address: string;
  historyHighestMarketCap: number | null;
  creationTimestamp: number | null;
}

export interface FetchTrendingOptions extends RunOptions {
  interval?: '1m' | '5m' | '1h' | '6h' | '24h';
  platform?: string;
  minCreated?: string;
  maxCreated?: string;
  minHistoryHighestMarketCap?: number;
  maxBundlerRate?: number;
  maxInsiderRate?: number;
  limit?: number;
}

/** Tokens για discovery: Pump.fun, 1h–24h, ATH ≥ $300k, bundler/insider ≤ 30%, κατά volume 6h. */
export const DISCOVERY_TRENDING: Required<Omit<FetchTrendingOptions, keyof RunOptions>> = {
  interval: '6h',
  platform: 'Pump.fun',
  minCreated: '1h',
  maxCreated: '24h',
  minHistoryHighestMarketCap: 300_000,
  maxBundlerRate: 0.3,
  maxInsiderRate: 0.3,
  limit: 30,
};

export function buildTrendingArgs(options: FetchTrendingOptions = {}): string[] {
  const o = { ...DISCOVERY_TRENDING, ...options };
  return [
    'market', 'trending',
    '--chain', 'sol',
    '--interval', o.interval,
    '--platform', o.platform,
    '--min-created', o.minCreated,
    '--max-created', o.maxCreated,
    '--min-history-highest-marketcap', String(o.minHistoryHighestMarketCap),
    '--max-bundler-rate', String(o.maxBundlerRate),
    '--max-insider-rate', String(o.maxInsiderRate),
    '--order-by', 'volume',
    '--direction', 'desc',
    '--limit', String(o.limit),
  ];
}

export async function fetchTrendingTokens(options: FetchTrendingOptions = {}): Promise<TrendingToken[]> {
  const raw = await runCli('market trending', buildTrendingArgs(options), options);
  return parseTrendingResponse(raw);
}

export function parseTrendingResponse(raw: unknown): TrendingToken[] {
  const list = findRankList(raw);
  return list.map((item, index) => {
    const path = `rank[${index}]`;
    const row = expectObject(item, path);
    const num = (key: string): number | null => {
      try {
        return toNumberOrNull(row[key], `${path}.${key}`);
      } catch {
        return null;
      }
    };
    return {
      address: expectString(row['address'], `${path}.address`),
      historyHighestMarketCap: num('history_highest_market_cap'),
      creationTimestamp: num('creation_timestamp'),
    };
  });
}

function findRankList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = expectObject(raw, 'response');
  const data = root['data'];
  const container = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : root;
  if (Array.isArray(data)) return data;
  for (const key of ['rank', 'list']) {
    if (container[key] !== undefined) return expectArray(container[key], key);
  }
  throw new GmgnResponseError(`no "rank"/"list" key; got [${Object.keys(container).join(', ')}]`, 'trending');
}

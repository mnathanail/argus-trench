import { runCli, type RunOptions } from './exec.js';
import { expectObject, toNumberOrNull, toStringOrNull } from './validate.js';

/**
 * `gmgn-cli token info` / `token security` — ανά token, weight 1 το καθένα
 * (.agents/skills/gmgn-token/SKILL.md). Για το on-demand gate (2026-09-28, βλ.
 * decision/onDemandGate.ts).
 *
 * Σχήμα επιβεβαιωμένο σε ΠΡΑΓΜΑΤΙΚΟ output (2026-09-28, __fixtures__/token-info.pump.json
 * και token-security.pump.json): top-level object, χωρίς `data` wrapper, αριθμοί ως
 * strings. ΠΡΟΣΟΧΗ: το πραγματικό `token security` για νέο pump.fun token ΔΕΝ έφερε
 * `rug_ratio` / `suspected_insider_hold_rate` / `bundler_trader_amount_rate`, παρότι τα
 * skill docs τα αναφέρουν — γι' αυτό εδώ είναι nullable και το gate τα χειρίζεται ως
 * «μη διαθέσιμα», όχι ως 0.
 */

export interface TokenInfo {
  tokenAddress: string;
  launchpadPlatform: string | null;
  /** Unix seconds. */
  creationTimestamp: number | null;
  holderCount: number | null;
  topHolderRate: number | null;
  /** `stat.top_bundler_trader_percentage` — «ratio of volume from bundler bots». */
  bundlerVolumeRate: number | null;
  /** `stat.top_entrapment_trader_percentage` — «ratio of volume from entrapment traders». */
  entrapmentVolumeRate: number | null;
  /** `stat.top_rat_trader_percentage` — «ratio of volume from rat/insider traders». */
  ratTraderVolumeRate: number | null;
  smartWallets: number | null;
  /** Σε SOL (`migration_market_cap_quote`), για αναφορά. */
  migrationMarketCap: number | null;
}

export interface TokenSecurity {
  topHolderRate: number | null;
  rugRatio: number | null;
  insiderHoldRate: number | null;
  bundlerTraderAmountRate: number | null;
}

function sub(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseTokenInfo(raw: unknown): TokenInfo {
  const root = expectObject(raw, 'token info');
  const stat = sub(root, 'stat');
  const tags = sub(root, 'wallet_tags_stat');
  const n = (obj: Record<string, unknown>, field: string, path: string): number | null =>
    toNumberOrNull(obj[field], path);
  return {
    tokenAddress: toStringOrNull(root['address']) ?? '',
    launchpadPlatform: toStringOrNull(root['launchpad_platform']),
    creationTimestamp: n(root, 'creation_timestamp', 'token info.creation_timestamp'),
    holderCount: n(root, 'holder_count', 'token info.holder_count'),
    topHolderRate:
      n(stat, 'top_10_holder_rate', 'token info.stat.top_10_holder_rate') ??
      n(sub(root, 'dev'), 'top_10_holder_rate', 'token info.dev.top_10_holder_rate'),
    bundlerVolumeRate: n(stat, 'top_bundler_trader_percentage', 'token info.stat.top_bundler_trader_percentage'),
    entrapmentVolumeRate: n(stat, 'top_entrapment_trader_percentage', 'token info.stat.top_entrapment_trader_percentage'),
    ratTraderVolumeRate: n(stat, 'top_rat_trader_percentage', 'token info.stat.top_rat_trader_percentage'),
    smartWallets: n(tags, 'smart_wallets', 'token info.wallet_tags_stat.smart_wallets'),
    migrationMarketCap: n(root, 'migration_market_cap', 'token info.migration_market_cap'),
  };
}

export function parseTokenSecurity(raw: unknown): TokenSecurity {
  const root = expectObject(raw, 'token security');
  const n = (field: string): number | null => toNumberOrNull(root[field], `token security.${field}`);
  return {
    topHolderRate: n('top_10_holder_rate'),
    rugRatio: n('rug_ratio'),
    insiderHoldRate: n('suspected_insider_hold_rate'),
    bundlerTraderAmountRate: n('bundler_trader_amount_rate'),
  };
}

function tokenArgs(command: 'info' | 'security', address: string, chain = 'sol'): string[] {
  return ['token', command, '--chain', chain, '--address', address];
}

export async function fetchTokenInfo(address: string, options: RunOptions = {}): Promise<TokenInfo> {
  return parseTokenInfo(await runCli('token info', tokenArgs('info', address), options));
}

export async function fetchTokenSecurity(address: string, options: RunOptions = {}): Promise<TokenSecurity> {
  return parseTokenSecurity(await runCli('token security', tokenArgs('security', address), options));
}

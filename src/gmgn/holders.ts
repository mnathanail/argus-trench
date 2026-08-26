import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, expectString } from './validate.js';

/**
 * `token holders --tag <tag>`. Το `--tag` είναι single-value, ΟΧΙ repeatable (σε
 * αντίθεση με `market trenches --type`) — για δύο tags θέλει δύο ξεχωριστά calls.
 * Weight 5, το ακριβότερο route που χρησιμοποιούμε — βλ. `routes.ts`.
 */
export type HolderTag =
  | 'smart_degen'
  | 'renowned'
  | 'fresh_wallet'
  | 'dev'
  | 'sniper'
  | 'rat_trader'
  | 'bundler'
  | 'transfer_in'
  | 'dex_bot'
  | 'bluechip_owner';

export interface TokenHolder {
  /**
   * Το wallet address του holder. ΠΡΟΣΟΧΗ: υπάρχει ΚΑΙ `account_address` στο raw
   * response, που είναι το on-chain token account (ATA) — ΟΧΙ το wallet. Επιβεβαιωμένο
   * με πραγματικό call (2026-08-26): `address` είναι το σωστό πεδίο για τον owner.
   */
  address: string;
  tags: readonly string[];
}

export interface FetchTokenHoldersOptions extends RunOptions {
  tokenAddress: string;
  tag: HolderTag;
  chain?: string;
  limit?: number;
}

export function buildHoldersArgs(options: FetchTokenHoldersOptions): string[] {
  const args = [
    'token',
    'holders',
    '--chain',
    options.chain ?? 'sol',
    '--address',
    options.tokenAddress,
    '--tag',
    options.tag,
  ];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return args;
}

export async function fetchTokenHolders(
  options: FetchTokenHoldersOptions,
): Promise<TokenHolder[]> {
  const raw = await runCli('token holders', buildHoldersArgs(options), options);
  return parseHoldersResponse(raw);
}

export function parseHoldersResponse(raw: unknown): TokenHolder[] {
  const root = expectObject(raw, 'response');
  const list = expectArray(root['list'] ?? [], 'list');
  return list.map((item, index) => parseHolder(item, `list[${index}]`));
}

function parseHolder(item: unknown, path: string): TokenHolder {
  const row = expectObject(item, path);
  const tags = Array.isArray(row['tags']) ? row['tags'].filter((t) => typeof t === 'string') : [];
  return {
    address: expectString(row['address'], `${path}.address`),
    tags,
  };
}

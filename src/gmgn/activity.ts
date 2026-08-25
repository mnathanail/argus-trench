import { runCli, type RunOptions } from './exec.js';
import {
  expectArray,
  expectObject,
  expectString,
  toNumber,
  toNumberOrNull,
  toStringOrNull,
} from './validate.js';

/**
 * Trade activity ενός ΣΥΓΚΕΚΡΙΜΕΝΟΥ wallet.
 *
 * Αυτό είναι η πηγή triggers για τη watchlist μας — ΟΧΙ το `track follow-wallet`, που
 * resolve-άρει τη λίστα από τα follows του GMGN account και άρα εξαρτάται από το UI
 * (βλ. CLAUDE.md layer 3). Κόστος: weight 3 **ανά wallet**.
 */
export interface WalletActivity {
  wallet: string;
  txHash: string;
  /** Επιβεβαιωμένα `event_type`, ΟΧΙ `type` όπως λέει το documentation. */
  eventType: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenAmount: number | null;
  costUsd: number | null;
  priceUsd: number | null;
  /** Unix seconds (number, σε αντίθεση με τα ποσά που είναι strings). */
  timestamp: number;
  launchpadPlatform: string | null;
}

export interface WalletActivityPage {
  activities: WalletActivity[];
  /** Opaque base64 cursor· `null` όταν δεν υπάρχει επόμενη σελίδα. */
  nextCursor: string | null;
}

export interface FetchWalletActivityOptions extends RunOptions {
  wallet: string;
  chain?: string;
  /** `buy` / `sell` / `transferIn` / `transferOut` / `add` / `remove`, repeatable. */
  types?: readonly string[];
  limit?: number;
  cursor?: string | null;
}

export function buildActivityArgs(options: FetchWalletActivityOptions): string[] {
  const args = ['portfolio', 'activity', '--chain', options.chain ?? 'sol', '--wallet', options.wallet];
  for (const type of options.types ?? []) args.push('--type', type);
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.cursor) args.push('--cursor', options.cursor);
  return args;
}

export async function fetchWalletActivity(
  options: FetchWalletActivityOptions,
): Promise<WalletActivityPage> {
  const raw = await runCli('portfolio activity', buildActivityArgs(options), options);
  return parseActivityResponse(raw);
}

/** Convenience για το layer 3: μόνο αγορές, πρώτη σελίδα. */
export async function fetchWalletBuys(
  wallet: string,
  options: Omit<FetchWalletActivityOptions, 'wallet' | 'types'> = {},
): Promise<WalletActivityPage> {
  return fetchWalletActivity({ ...options, wallet, types: ['buy'] });
}

export function parseActivityResponse(raw: unknown): WalletActivityPage {
  const root = expectObject(raw, 'response');
  const list = expectArray(root['activities'] ?? [], 'activities');
  return {
    activities: list.map((item, index) => parseActivity(item, `activities[${index}]`)),
    nextCursor: toStringOrNull(root['next']),
  };
}

function parseActivity(item: unknown, path: string): WalletActivity {
  const row = expectObject(item, path);
  const token = isObject(row['token']) ? (row['token'] as Record<string, unknown>) : {};

  return {
    wallet: expectString(row['wallet'], `${path}.wallet`),
    txHash: expectString(row['tx_hash'], `${path}.tx_hash`),
    eventType: expectString(row['event_type'], `${path}.event_type`),
    tokenAddress: expectString(token['address'], `${path}.token.address`),
    tokenSymbol: toStringOrNull(token['symbol']),
    // Τα ποσά έρχονται ως strings σε αυτό το endpoint — σε αντίθεση με το `trenches`.
    tokenAmount: toNumberOrNull(row['token_amount'], `${path}.token_amount`),
    costUsd: toNumberOrNull(row['cost_usd'], `${path}.cost_usd`),
    priceUsd: toNumberOrNull(row['price_usd'], `${path}.price_usd`),
    timestamp: toNumber(row['timestamp'], `${path}.timestamp`),
    launchpadPlatform: toStringOrNull(row['launchpad_platform']),
  };
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

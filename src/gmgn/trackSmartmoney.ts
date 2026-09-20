import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, expectString, toNumberOrNull, toStringOrNull } from './validate.js';

/**
 * `track smartmoney` — GMGN-tagged (πλατφόρμα-wide) smart money / whale wallets, ΟΧΙ η
 * δική μας watchlist. Weight 1 (φθηνότερο route μαζί με `track kol`), βλ. routes.ts.
 *
 * Ξεχωριστό, παράλληλο κανάλι σήματος από το layer 3 (walletActivity.ts/
 * realtimeEntryHandler.ts): εκεί ο trigger είναι ένα wallet ΑΠΟ ΤΗ ΔΙΚΗ ΜΑΣ,
 * self-curated λίστα (~100-150 addresses, weight 3/wallet/κύκλο για να χτιστεί) — εδώ
 * είναι ΟΛΟΚΛΗΡΗ η πλατφόρμα-wide λίστα του GMGN, weight 1 ΣΥΝΟΛΙΚΑ (όχι ανά wallet).
 * CLAUDE.md ρητά το είχε σημειώσει ως "παραμένει open/unimplemented" — αυτό είναι η
 * πρώτη υλοποίηση.
 *
 * ΔΕΝ ταυτίζεται με `track follow-wallet` (αυτό εξαρτάται από τα follows του GMGN UI
 * account — ρητά απορρίπτεται στο CLAUDE.md layer 3) ούτε με τη δική μας
 * `watchlist_wallets` — τα wallets εδώ είναι GMGN's δικά του tagged wallets, ΟΧΙ κάτι
 * που εμείς προσθέσαμε/σκοράραμε.
 *
 * Καμία τεκμηριωμένη σελιδοποίηση/cursor σε αυτό το route (βλ. gmgn-track skill) — μόνο
 * `--limit` πάνω σε πρόσφατα trades. Το dedup είναι δουλειά του caller (ίδιο μοτίβο με
 * `filterNewBuys` στο activity.ts), μέσω `transactionHash`.
 */
export interface SmartMoneyTrade {
  transactionHash: string;
  makerAddress: string;
  /** 'buy' | 'sell' — client-side filter στο ίδιο το CLI αν περάσουμε --side, αλλά το
   * κρατάμε ούτως ή άλλως στο parsed shape ώστε ο caller να μη βασίζεται σε αυτό. */
  side: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  launchpad: string | null;
  amountUsd: number | null;
  tokenAmount: number | null;
  priceUsd: number | null;
  /** 0 = άνοιγμα/προσθήκη θέσης, 1 = κλείσιμο/μείωση — ΑΝΤΙΣΤΡΟΦΟ από το follow-wallet
   * (εκεί 1=πλήρες open/close). Βλ. skill doc "is_open_or_close" section. */
  isOpenOrClose: number | null;
  timestamp: number;
  makerTags: readonly string[];
}

export interface FetchSmartMoneyOptions extends RunOptions {
  chain?: string;
  limit?: number;
  side?: 'buy' | 'sell';
}

export function buildSmartMoneyArgs(options: FetchSmartMoneyOptions): string[] {
  const args = ['track', 'smartmoney', '--chain', options.chain ?? 'sol'];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.side !== undefined) args.push('--side', options.side);
  return args;
}

export async function fetchSmartMoneyTrades(
  options: FetchSmartMoneyOptions = {},
): Promise<SmartMoneyTrade[]> {
  const raw = await runCli('track smartmoney', buildSmartMoneyArgs(options), options);
  return parseSmartMoneyResponse(raw);
}

export function parseSmartMoneyResponse(raw: unknown): SmartMoneyTrade[] {
  const root = expectObject(raw, 'response');
  const list = expectArray(root['list'] ?? [], 'list');
  return list.map((item, index) => parseSmartMoneyTrade(item, `list[${index}]`));
}

function parseSmartMoneyTrade(item: unknown, path: string): SmartMoneyTrade {
  const row = expectObject(item, path);
  const baseToken = isObject(row['base_token']) ? (row['base_token'] as Record<string, unknown>) : {};
  const makerInfo = isObject(row['maker_info']) ? (row['maker_info'] as Record<string, unknown>) : {};
  const tags = Array.isArray(makerInfo['tags'])
    ? makerInfo['tags'].filter((t): t is string => typeof t === 'string')
    : [];

  return {
    transactionHash: expectString(row['transaction_hash'], `${path}.transaction_hash`),
    makerAddress: expectString(row['maker'], `${path}.maker`),
    side: expectString(row['side'], `${path}.side`),
    tokenAddress: expectString(row['base_address'], `${path}.base_address`),
    tokenSymbol: toStringOrNull(baseToken['symbol']),
    launchpad: toStringOrNull(baseToken['launchpad']),
    amountUsd: toNumberOrNull(row['amount_usd'], `${path}.amount_usd`),
    tokenAmount: toNumberOrNull(row['token_amount'], `${path}.token_amount`),
    priceUsd: toNumberOrNull(row['price_usd'], `${path}.price_usd`),
    isOpenOrClose: toNumberOrNull(row['is_open_or_close'], `${path}.is_open_or_close`),
    timestamp: toNumberOrNull(row['timestamp'], `${path}.timestamp`) ?? 0,
    makerTags: tags,
  };
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

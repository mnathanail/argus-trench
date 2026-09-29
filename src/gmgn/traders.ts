import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, expectString, toNumberOrNull } from './validate.js';

/**
 * `token traders` — top traders ενός token (κάθε wallet που αγόρασε/πούλησε, όχι μόνο όσοι
 * κρατούν ακόμα). Weight 5, ίδιο με `token holders`. 2026-09-29: νέα πηγή wallet discovery
 * (collectors/walletDiscovery.ts) — όσοι ΒΓΑΛΑΝ λεφτά σε tokens που έτρεξαν, αντί για
 * holders με ετικέτα smart_degen (που έφερναν κυρίως snipers).
 *
 * Σχήμα από .agents/skills/gmgn-token/SKILL.md (ίδιο με `token holders`: `{ list: [...] }`,
 * `address` = wallet, ΟΧΙ `account_address`). Όλα τα πεδία πέρα από `address` είναι
 * optional εδώ: αν λείπει κάποιο, το wallet απλώς δεν περνάει το φίλτρο (βλ.
 * `isCopyableTrader`) — ποτέ δεν μπαίνει wallet χωρίς στοιχεία.
 */
export type TraderOrderBy = 'profit' | 'unrealized_profit' | 'buy_volume_cur' | 'sell_volume_cur' | 'amount_percentage';

export interface TokenTrader {
  address: string;
  /** 0 = κανονικό wallet, 2 = exchange / pool. */
  addrType: number | null;
  /** Γενικές ετικέτες του wallet (π.χ. smart_degen, kol). */
  tags: readonly string[];
  /** Ετικέτες ΓΙΑ ΑΥΤΟ το token (π.χ. sniper, bundler). */
  makerTokenTags: readonly string[];
  realizedProfitUsd: number | null;
  /** realized_profit / buy_cost (0.5 = +50%). */
  realizedPnl: number | null;
  buyCostUsd: number | null;
  /** Unix sec. */
  startHoldingAt: number | null;
  /** Unix sec· null = κρατάει ακόμα. */
  endHoldingAt: number | null;
}

export interface FetchTokenTradersOptions extends RunOptions {
  tokenAddress: string;
  chain?: string;
  orderBy?: TraderOrderBy;
  limit?: number;
}

export function buildTradersArgs(options: FetchTokenTradersOptions): string[] {
  return [
    'token',
    'traders',
    '--chain',
    options.chain ?? 'sol',
    '--address',
    options.tokenAddress,
    '--order-by',
    options.orderBy ?? 'profit',
    '--direction',
    'desc',
    '--limit',
    String(options.limit ?? 50),
  ];
}

export async function fetchTokenTraders(options: FetchTokenTradersOptions): Promise<TokenTrader[]> {
  const raw = await runCli('token traders', buildTradersArgs(options), options);
  return parseTradersResponse(raw);
}

export function parseTradersResponse(raw: unknown): TokenTrader[] {
  const root = expectObject(raw, 'response');
  const list = expectArray(root['list'] ?? [], 'list');
  return list.map((item, index) => parseTrader(item, `list[${index}]`));
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []);

/** Ποτέ δεν πετάει για αριθμητικό πεδίο: άκυρη τιμή = null (το wallet απλώς δεν περνάει). */
function num(row: Record<string, unknown>, key: string, path: string): number | null {
  try {
    return toNumberOrNull(row[key], `${path}.${key}`);
  } catch {
    return null;
  }
}

function parseTrader(item: unknown, path: string): TokenTrader {
  const row = expectObject(item, path);
  const end = num(row, 'end_holding_at', path);
  return {
    address: expectString(row['address'], `${path}.address`),
    addrType: num(row, 'addr_type', path),
    tags: strings(row['tags']),
    makerTokenTags: strings(row['maker_token_tags']),
    realizedProfitUsd: num(row, 'realized_profit', path),
    realizedPnl: num(row, 'realized_pnl', path),
    buyCostUsd: num(row, 'history_bought_cost', path),
    startHoldingAt: num(row, 'start_holding_at', path),
    endHoldingAt: end === 0 ? null : end,
  };
}

/**
 * Ετικέτες που αποκλείουν: αγόρασε στο άνοιγμα (sniper), bot bundle (bundler), insider
 * (rat_trader), ο δημιουργός και η ομάδα του (dev/dev_team/creator — ετικέτες του πραγματικού
 * response), sandwich_bot, wallet χωρίς ιστορικό (fresh_wallet — συνήθως
 * αναλώσιμο wallet του ίδιου operator), πήρε tokens με transfer αντί για αγορά (transfer_in).
 * Ελέγχονται ΚΑΙ στα `tags` ΚΑΙ στα `maker_token_tags`.
 */
export const EXCLUDED_TRADER_TAGS = ['sniper', 'bundler', 'rat_trader', 'dev', 'dev_team', 'creator', 'fresh_wallet', 'transfer_in', 'sandwich_bot'] as const;

/** Ελάχιστο realized κέρδος σε αυτό το token: ≥ 2x (realized_pnl ≥ 1.0). */
export const MIN_TRADER_REALIZED_PNL = 1.0;
/** Ελάχιστο ποσό αγοράς (USD) — κάτω από αυτό τα ×N είναι θόρυβος (π.χ. $2 → $20). */
export const MIN_TRADER_BUY_COST_USD = 50;
/** Ελάχιστος χρόνος κρατήματος σε αυτό το token — κάτω από 2′ = sniper συμπεριφορά
 * (βλ. CLAUDE.md «Wallet quality: snipers vs holders»). */
export const MIN_TRADER_HOLD_SEC = 120;

/** `not_sold` = δεν έχει πουλήσει τίποτα (realized_pnl κενό) — δεν ξέρουμε αν βγαίνει καλά. */
export type TraderRejectReason = 'not_wallet' | 'excluded_tag' | 'not_sold' | 'low_profit' | 'small_size' | 'short_hold' | 'missing_data';

export function traderRejectReason(trader: TokenTrader, nowSec: number): TraderRejectReason | null {
  if (trader.addrType !== 0) return 'not_wallet';
  const allTags = [...trader.tags, ...trader.makerTokenTags];
  if (EXCLUDED_TRADER_TAGS.some((t) => allTags.includes(t))) return 'excluded_tag';
  if (trader.buyCostUsd === null || trader.startHoldingAt === null) return 'missing_data';
  if (trader.realizedPnl === null) return 'not_sold';
  if (trader.realizedPnl < MIN_TRADER_REALIZED_PNL) return 'low_profit';
  if (trader.buyCostUsd < MIN_TRADER_BUY_COST_USD) return 'small_size';
  const heldSec = (trader.endHoldingAt ?? nowSec) - trader.startHoldingAt;
  if (heldSec < MIN_TRADER_HOLD_SEC) return 'short_hold';
  return null;
}

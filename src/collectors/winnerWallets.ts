import {
  activateWinnerWallet,
  deactivateCurated,
  listProvenWallets,
  listRecentlyScannedTokens,
  listWalletStatuses,
  listWinnerScores,
  recordWinnerTokenScan,
  upsertWinnerHit,
  type WalletStatusRow,
  type WinnerScore,
} from '../db/repositories/winnerWallets.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { EXCLUDED_TRADER_TAGS, fetchTokenTraders, type TokenTrader } from '../gmgn/traders.js';
import { fetchWinnerTokens, type TrendingToken } from '../gmgn/trending.js';
import { fetchWalletStats } from '../gmgn/walletStats.js';
import { delay } from '../util/delay.js';
import { WALLET_DISCOVERY_LOOP_PACING_MS } from './intervals.js';

/**
 * 2026-10-07 (ρητή απόφαση χρήστη: «θέλω μόνο πορτοφόλια που έχουν βγάλει κέρδη από τα τοπ
 * νομίσματα — τώρα έχουμε θόρυβο και καίμε credits»). Αντικαθιστά το παλιό wallet discovery
 * (GMGN win rate) ως ΜΟΝΗ αυτόματη πηγή της watchlist, και κλαδεύει ό,τι δεν το δικαιολογεί.
 *
 * Κάθε κύκλος (κάθε 2h· 2026-10-07: 50 tokens / 60 bot έλεγχοι ανά κύκλο ώστε η watchlist να
 * αλλάξει μέσα σε ώρες, όχι μέρες):
 *   1. Τοπ tokens: Pump.fun, δημιουργία τις τελευταίες 48h, ATH ≥ $300k, κατά ATH (ίδια κλήση με
 *      το winners-report). Όσα δεν σαρώθηκαν τις τελευταίες 12h, ως `TOKENS_PER_CYCLE`.
 *   2. Top 100 traders κατά κέρδος ανά token → «νικητής» = κανονικό wallet, χωρίς ετικέτα
 *      sniper/bundler/dev/…, μπήκε 0.5–60′ μετά τη δημιουργία (πιάσιμο από εμάς), αγορά ≥ $50,
 *      κράτησε ≥ 2′, ≥ 3× και ≥ $300 κέρδος → `wallet_winner_hits`.
 *   3. Wallet της watchlist = ≥ 2 τοπ tokens μέσα σε 14 μέρες, ή ένα ≥ 10×. Έλεγχος bot με
 *      `portfolio stats` (μέσος χρόνος κράτησης < 2′ → όχι), ως `MAX_STATS_PER_CYCLE` ανά κύκλο.
 *   4. Κλάδεμα: ενεργά μένουν ΜΟΝΟ manual, mirror, τα νικητές wallets (ως `WATCHLIST_MAX`, κατά
 *      κατάταξη) και όσα αποδείχτηκαν με δικά μας trades (≥ 3 κλειστά σε 14 μέρες, θετικό σύνολο).
 *      Γίνεται μόνο όταν υπάρχουν ≥ `MIN_WINNERS_TO_PRUNE` νικητές — ώστε το πρώτο τρέξιμο (άδειος
 *      πίνακας) να μην αδειάσει τη watchlist.
 *
 * GMGN: 1 + TOKENS_PER_CYCLE × 5 + έως MAX_STATS_PER_CYCLE × 3 weight, σειριακά με pacing.
 */
export const WINNER_TOKENS_HOURS = 48;
export const WINNER_MIN_ATH_USD = 300_000;
export const TOKENS_PER_CYCLE = 50;
export const TOKEN_RESCAN_HOURS = 12;
export const WINNER_MIN_MULTIPLE = 3;
export const WINNER_BIG_MULTIPLE = 10;
export const WINNER_MIN_PROFIT_USD = 300;
export const WINNER_MIN_COST_USD = 50;
export const WINNER_MIN_ENTRY_MIN = 0.5;
export const WINNER_MAX_ENTRY_MIN = 60;
export const WINNER_MIN_HOLD_SEC = 120;
export const WINNER_WINDOW_DAYS = 14;
export const WATCHLIST_MAX = 150;
export const MIN_WINNERS_TO_PRUNE = 30;
export const MAX_STATS_PER_CYCLE = 60;
export const BOT_MAX_AVG_HOLDING_SEC = 120;
export const PROVEN_MIN_TRADES = 3;

/** /unwatch (manual) και μπλοκαρισμένα από τη βαθμολογία (scored_out) δεν ξαναμπαίνουν ποτέ αυτόματα. */
const NEVER_REACTIVATE = new Set(['manual', 'scored_out']);

export type WinnerRejectReason =
  | 'not_wallet'
  | 'excluded_tag'
  | 'missing_data'
  | 'low_multiple'
  | 'low_profit'
  | 'small_size'
  | 'entry_too_early'
  | 'entry_too_late'
  | 'short_hold';

/** × σε αυτό το token: 1 + profit_change (realized + unrealized)· αλλιώς 1 + realized_pnl. */
export function traderMultiple(t: TokenTrader): number | null {
  if (t.profitChange !== undefined && t.profitChange !== null) return 1 + t.profitChange;
  if (t.realizedPnl !== null) return 1 + t.realizedPnl;
  return null;
}

export function winnerRejectReason(t: TokenTrader, tokenCreatedSec: number | null, nowSec: number): WinnerRejectReason | null {
  if (t.addrType !== 0) return 'not_wallet';
  const tags = [...t.tags, ...t.makerTokenTags];
  if (EXCLUDED_TRADER_TAGS.some((x) => tags.includes(x))) return 'excluded_tag';
  const multiple = traderMultiple(t);
  const cost = t.totalCostUsd ?? t.buyCostUsd;
  const profit = t.profitUsd ?? t.realizedProfitUsd;
  if (multiple === null || cost === null || profit === null || t.startHoldingAt === null || tokenCreatedSec === null) return 'missing_data';
  if (multiple < WINNER_MIN_MULTIPLE) return 'low_multiple';
  if (profit < WINNER_MIN_PROFIT_USD) return 'low_profit';
  if (cost < WINNER_MIN_COST_USD) return 'small_size';
  const entryMin = (t.startHoldingAt - tokenCreatedSec) / 60;
  if (entryMin < WINNER_MIN_ENTRY_MIN) return 'entry_too_early';
  if (entryMin > WINNER_MAX_ENTRY_MIN) return 'entry_too_late';
  if ((t.endHoldingAt ?? nowSec) - t.startHoldingAt < WINNER_MIN_HOLD_SEC) return 'short_hold';
  return null;
}

export function isWinnerWallet(s: WinnerScore): boolean {
  return s.tokens >= 2 || s.maxMultiple >= WINNER_BIG_MULTIPLE;
}

/** Κατάταξη: περισσότερα τοπ tokens, μετά μεγαλύτερο ×, μετά συνολικό κέρδος. */
export function rankWinners(scores: readonly WinnerScore[]): WinnerScore[] {
  return scores
    .filter(isWinnerWallet)
    .sort((a, b) => b.tokens - a.tokens || b.maxMultiple - a.maxMultiple || b.totalProfitUsd - a.totalProfitUsd || (a.address < b.address ? -1 : 1));
}

export interface WatchlistPlan {
  /** Νικητές που πρέπει να είναι ενεργοί (ως WATCHLIST_MAX). */
  keepWinners: string[];
  /** Ενεργά wallets που κόβονται ('curated'). */
  deactivate: string[];
  /** false = λίγοι νικητές ακόμα, κανένα κλάδεμα. */
  pruned: boolean;
}

/** Καθαρή απόφαση: ποιοι νικητές μένουν και ποια ενεργά wallets κόβονται. */
export function planWatchlist(
  ranked: readonly WinnerScore[],
  statuses: readonly WalletStatusRow[],
  proven: ReadonlySet<string>,
  bots: ReadonlySet<string>,
  max = WATCHLIST_MAX,
  minToPrune = MIN_WINNERS_TO_PRUNE,
): WatchlistPlan {
  const byAddress = new Map(statuses.map((s) => [s.address, s]));
  const keepWinners = ranked
    .filter((w) => !bots.has(w.address) && !NEVER_REACTIVATE.has(byAddress.get(w.address)?.deactivatedReason ?? ''))
    .slice(0, max)
    .map((w) => w.address);
  if (keepWinners.length < minToPrune) return { keepWinners, deactivate: [], pruned: false };
  const keep = new Set([...keepWinners, ...proven]);
  const deactivate = statuses
    .filter((s) => s.active && s.source !== 'manual' && s.copyMode !== 'mirror' && !keep.has(s.address))
    .map((s) => s.address);
  return { keepWinners, deactivate, pruned: true };
}

export interface WinnerWalletsResult {
  tokensScanned: number;
  tradersSeen: number;
  hits: number;
  rejected: Partial<Record<WinnerRejectReason, number>>;
  winners: number;
  activated: number;
  bots: number;
  deactivated: number;
  pruned: boolean;
  failures: number;
}

/** Bots που βρέθηκαν με `portfolio stats` — δεν ξαναελέγχονται για 7 μέρες (in-memory). */
const BOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const knownBots = new Map<string, number>();

export function resetWinnerWalletsState(): void {
  knownBots.clear();
}

async function scanToken(token: TrendingToken, nowSec: number, rejected: Partial<Record<WinnerRejectReason, number>>): Promise<{ traders: number; hits: number }> {
  const traders = await fetchTokenTraders({ tokenAddress: token.address, orderBy: 'profit', limit: 100 });
  let hits = 0;
  for (const t of traders) {
    const reason = winnerRejectReason(t, token.creationTimestamp, nowSec);
    if (reason !== null) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    hits += 1;
    await upsertWinnerHit({
      walletAddress: t.address,
      tokenAddress: token.address,
      tokenSymbol: token.symbol ?? null,
      tokenAthUsd: token.historyHighestMarketCap,
      multiple: traderMultiple(t)!,
      profitUsd: t.profitUsd ?? t.realizedProfitUsd,
      costUsd: t.totalCostUsd ?? t.buyCostUsd,
      entryMin: token.creationTimestamp === null || t.startHoldingAt === null ? null : (t.startHoldingAt - token.creationTimestamp) / 60,
    });
  }
  await recordWinnerTokenScan(
    { address: token.address, symbol: token.symbol ?? null, athUsd: token.historyHighestMarketCap, createdAtUnix: token.creationTimestamp },
    traders.length,
    hits,
  );
  return { traders: traders.length, hits };
}

export async function runWinnerWalletsCycle(): Promise<WinnerWalletsResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rejected: Partial<Record<WinnerRejectReason, number>> = {};
  let failures = 0;
  let tradersSeen = 0;
  let hits = 0;

  // 1–2. τοπ tokens → νικητές traders
  const top = await fetchWinnerTokens(WINNER_TOKENS_HOURS, WINNER_MIN_ATH_USD);
  await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
  const recent = await listRecentlyScannedTokens(top.map((t) => t.address), TOKEN_RESCAN_HOURS);
  const tokens = top.filter((t) => !recent.has(t.address)).slice(0, TOKENS_PER_CYCLE);
  for (const token of tokens) {
    try {
      const r = await scanToken(token, nowSec, rejected);
      tradersSeen += r.traders;
      hits += r.hits;
    } catch (error) {
      rethrowIfRateLimited(error);
      failures += 1;
    }
    await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
  }

  // 3. ποια wallets είναι νικητές· bot έλεγχος για όσα δεν είναι ήδη ενεργά
  const ranked = rankWinners(await listWinnerScores(WINNER_WINDOW_DAYS));
  const statuses = await listWalletStatuses();
  const byAddress = new Map(statuses.map((s) => [s.address, s]));
  const now = Date.now();
  for (const [address, at] of knownBots) if (now - at > BOT_TTL_MS) knownBots.delete(address);

  let statsUsed = 0;
  let activated = 0;
  const avgHold = new Map<string, number | null>();
  for (const w of ranked.slice(0, WATCHLIST_MAX)) {
    const status = byAddress.get(w.address);
    if (knownBots.has(w.address) || NEVER_REACTIVATE.has(status?.deactivatedReason ?? '')) continue;
    if (status?.active && (status.source === 'winner_trader' || status.source === 'manual')) continue;
    if (statsUsed >= MAX_STATS_PER_CYCLE) break;
    statsUsed += 1;
    try {
      const stats = await fetchWalletStats({ wallet: w.address });
      avgHold.set(w.address, stats.avgHoldingPeriodSec);
      if (stats.avgHoldingPeriodSec !== null && stats.avgHoldingPeriodSec < BOT_MAX_AVG_HOLDING_SEC) knownBots.set(w.address, now);
    } catch (error) {
      rethrowIfRateLimited(error);
      failures += 1; // χωρίς έλεγχο → δεν ενεργοποιείται σε αυτόν τον κύκλο
    }
    await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
  }

  // 4. σχέδιο: ποιοι νικητές μένουν, τι κόβεται
  const proven = await listProvenWallets(WINNER_WINDOW_DAYS, PROVEN_MIN_TRADES);
  const plan = planWatchlist(ranked, statuses, proven, new Set(knownBots.keys()));
  for (const address of plan.keepWinners) {
    const status = byAddress.get(address);
    const alreadyOk = status?.active && (status.source === 'winner_trader' || status.source === 'manual');
    // Νέο / ανενεργό wallet ενεργοποιείται μόνο αφού περάσει τον bot έλεγχο σε αυτόν ή προηγούμενο κύκλο.
    if (alreadyOk) continue;
    if (!avgHold.has(address) && !status?.active) continue; // δεν έφτασε ο έλεγχος σε αυτόν τον κύκλο
    if (await activateWinnerWallet(address, avgHold.get(address) ?? null)) activated += 1;
  }
  const deactivated = await deactivateCurated(plan.deactivate);

  return {
    tokensScanned: tokens.length,
    tradersSeen,
    hits,
    rejected,
    winners: ranked.length,
    activated,
    bots: knownBots.size,
    deactivated,
    pruned: plan.pruned,
    failures,
  };
}

/** true = τρέχει (αντικαθιστά το παλιό wallet discovery, που μένει κλειστό). */
export const WINNER_WALLETS_ENABLED = true;

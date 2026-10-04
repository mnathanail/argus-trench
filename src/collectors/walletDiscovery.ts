import { insertWalletIfNew, listKnownAddresses } from '../db/repositories/watchlistWallets.js';
import { isRealtimeSignalWallet } from '../realtime/walletSubscriptionSync.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { fetchTokenTraders, traderRejectReason, type TokenTrader, type TraderRejectReason } from '../gmgn/traders.js';
import { type TrenchCandidate } from '../gmgn/trenches.js';
import { fetchTrendingTokens, type TrendingToken } from '../gmgn/trending.js';
import type { PumpPortalConnection } from '../realtime/pumpportalConnection.js';
import { fetchWalletStats, type WalletStats } from '../gmgn/walletStats.js';
import { WALLET_DISCOVERY_LOOP_PACING_MS } from './intervals.js';
import { ADVISORY_TOKEN_COUNT_FLOOR, ADVISORY_WIN_RATE_FLOOR } from '../telegram/commands.js';
import { delay } from '../util/delay.js';

/**
 * Layer 2 — «Αυτόματο» wallet discovery (CLAUDE.md). Hourly, standing process
 * ανεξάρτητο από τα layer 1/3 collectors:
 *
 *   ~10 Pump.fun tokens που έτρεξαν (trending 6h, 1h–24h, ATH ≥ $300k), όχι ήδη σαρωμένα
 *     → top traders κατά κέρδος ανά token (από 2026-09-29· πριν: holders `smart_degen`)
 *     → φίλτρο sniper/bundler/κέρδος/κράτημα από το ίδιο response
 *     → μοναδικά candidate wallets, με πόσα tokens τα «είδαν» (βαρύτητα, όχι φίλτρο)
 *     → όσα ΔΕΝ ξέρουμε ήδη, ≤ 40/κύκλο → `portfolio stats` σειριακά
 *     → INSERT (`source='top_trader'`) ΜΟΝΟ όσα περνούν `passesTopTraderThreshold`
 *       — αλλιώς skip, όχι inactive row.
 *
 * Throttled by design: το loop τρέχει σε exclusive scheduler window, όλα τα calls
 * περνούν σειριακά από τον ΙΔΙΟ global rate limiter (`gmgn/exec.ts`) και υπάρχει σκόπιμο
 * `WALLET_DISCOVERY_LOOP_PACING_MS` ανάμεσα σε διαδοχικά calls.
 *
 * ⚠️ Το αρχικό spec έλεγε «~20-30» tokens — μειώθηκε στο πρακτικό default παρακάτω.
 * Στην πράξη, 25 tokens × holders (weight 5) + δεκάδες candidates × stats (weight 3)
 * ξεπερνούσε συστηματικά τα 300+ weight ανά κύκλο· πάνω σε shared budget 20/s, ΜΑΖΙ με
 * τα άλλα 3 loops, ο κύκλος σχεδόν ποτέ δεν πρόλαβε να τελειώσει πριν χτυπήσει rate
 * limit — και επειδή μια αποτυχία πετάει ΟΛΟ το progress του κύκλου (κανένα partial
 * commit), ξανάρχιζε από το μηδέν κάθε φορά, επ' αόριστον. Μικρότερο sampleSize
 * σημαίνει πιο αργή συνολική κάλυψη candidates, αλλά πραγματικά ολοκληρωμένους κύκλους
 * αντί για έναν κύκλο που ποτέ δεν τελειώνει.
 *
 * ⚠️ Κάθε per-item `catch` (ανά token για traders, ανά candidate για stats) καλεί ΠΡΩΤΑ
 * `rethrowIfRateLimited` — ένα naive `catch { failures++; continue }` θα καταπίνε το
 * `GmgnRateLimitError` και θα ξαναχτυπούσε το API στο ΕΠΟΜΕΝΟ item μέσα στο ban,
 * επεκτείνοντάς το κατά 5s ανά request (βρέθηκε ως πραγματικό bug στο υπάρχον
 * `scoring.ts` όσο χτιζόταν αυτό το collector — διορθώθηκε εκεί επίσης).
 */
export interface WalletDiscoveryOptions {
  /** «~20-30» στο αρχικό spec· μειώθηκε σε πρακτικό default — βλ. σχόλιο πάνω από τη function. */
  sampleSize?: number;
  /** Πόσους top traders (κατά κέρδος) να ζητήσει ανά token. */
  tradersLimitPerToken?: number;
  /** Optional — αν δοθεί, κάθε νέο wallet κάνει αμέσως subscribeWallet στο realtime feed,
   * ώστε η ανίχνευση αγορών του (realtimeEntryHandler.ts) να ξεκινήσει από τη στιγμή της
   * ανακάλυψης — χωρίς αυτό, θα χρειαζόταν restart για να το «δει» το websocket. */
  realtimeConnection?: PumpPortalConnection;
}

export interface WalletDiscoveryResult {
  tokensScanned: number;
  /** Traders που είδαμε (όλα τα tokens, με διπλά). */
  tradersSeen: number;
  /** Πόσοι απορρίφθηκαν ανά λόγο πριν το scoring (sniper/bundler, <2x, <2′ κ.λπ.). */
  rejected: Record<TraderRejectReason, number>;
  uniqueCandidates: number;
  /** Νέα active=true rows. */
  discovered: number;
  /** Σκοράρισμα έγινε, δεν έφτασε το threshold — καμία εγγραφή. */
  belowThreshold: number;
  /** Το address υπήρχε ήδη (οποιοδήποτε source) — δεν σκοραρίστηκε καν. */
  alreadyKnown: number;
  /** traders ή stats call που απέτυχε για ένα token/wallet· δεν σταματά τον κύκλο. */
  failures: number;
}

/** Cap+rotate (CLAUDE.md takeaway): ≤ 40 `portfolio stats` (weight 3) ανά κύκλο. */
export const DISCOVERY_MAX_SCORED_PER_CYCLE = 40;
/** Wallet που απορρίφθηκε στο scoring δεν ξανασκοράρεται για 24h (in-memory — ένα restart
 * απλώς το ξαναελέγχει, κανένα πρόβλημα). */
const REJECTED_TTL_MS = 24 * 60 * 60 * 1000;
const recentlyRejected = new Map<string, number>();
/** Token που σαρώθηκε δεν ξανασαρώνεται για 24h — κάθε ωριαίος κύκλος παίρνει ΝΕΑ tokens. */
const SCANNED_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const recentlyScannedTokens = new Map<string, number>();

export function resetWalletDiscoveryState(): void {
  recentlyRejected.clear();
  recentlyScannedTokens.clear();
}

/** Με τη σειρά του trending (volume), όσα δεν σαρώθηκαν πρόσφατα, μοναδικά. */
export function pickUnscannedTokens(
  trending: readonly TrendingToken[],
  scanned: ReadonlyMap<string, number>,
  sampleSize: number,
): { tokenAddress: string }[] {
  const seen = new Set<string>();
  const picked: { tokenAddress: string }[] = [];
  for (const t of trending) {
    if (scanned.has(t.address) || seen.has(t.address)) continue;
    seen.add(t.address);
    picked.push({ tokenAddress: t.address });
    if (picked.length >= sampleSize) break;
  }
  return picked;
}

/**
 * 2026-09-29 (ρητή απόφαση χρήστη, «θέλω το 3»): πηγή = TOP TRADERS κατά κέρδος
 * (`token traders --order-by profit`) tokens που ΗΔΗ έτρεξαν (`market trending`, βλ.
 * gmgn/trending.ts — ΟΧΙ τα πρόσφατα graduated: ηλικίας ~1′, μόνο dev/bundlers), ΟΧΙ holders με
 * ετικέτα smart_degen. Λόγος: τα smart_degen που βρίσκαμε ήταν κυρίως snipers (πουλούν
 * < 2′ μετά την αγορά) — αντιγράφοντάς τα χάναμε δομικά (−0.34 SOL σε 187 αντιγραφές).
 *
 * Φίλτρο ανά trader, ΠΡΙΝ το scoring (0 κόστος — από το ίδιο response, βλ.
 * `traderRejectReason`): κανονικό wallet, χωρίς ετικέτα sniper/bundler/rat_trader/dev/
 * fresh_wallet/transfer_in, ≥ 2x realized σε αυτό το token, αγορά ≥ $50, κράτημα ≥ 2′.
 * Scoring (`portfolio stats`): το ίδιο floor με πριν ΚΑΙ μέσος χρόνος κρατήματος ≥ 2′.
 * Νέα wallets γράφονται με `source='top_trader'` ώστε τα αποτελέσματά τους να μετριούνται
 * χωριστά (`npm run wallet-holding-report`).
 */
export async function runWalletDiscoveryCycle(
  options: WalletDiscoveryOptions = {},
): Promise<WalletDiscoveryResult> {
  const sampleSize = options.sampleSize ?? 10;
  const tradersLimit = options.tradersLimitPerToken ?? 50;
  const nowSec = Math.floor(Date.now() / 1000);

  const now = Date.now();
  for (const [address, at] of recentlyScannedTokens) if (now - at > SCANNED_TOKEN_TTL_MS) recentlyScannedTokens.delete(address);
  const trending = await fetchTrendingTokens();
  const tokens = pickUnscannedTokens(trending, recentlyScannedTokens, sampleSize);
  for (const token of tokens) recentlyScannedTokens.set(token.tokenAddress, now);

  const perTokenTraders: TokenTrader[][] = [];
  const rejected: Record<TraderRejectReason, number> = {
    not_wallet: 0, excluded_tag: 0, not_sold: 0, low_profit: 0, small_size: 0, short_hold: 0, missing_data: 0,
  };
  let tradersSeen = 0;
  let traderFailures = 0;

  // Σειριακά ανά token: ο rate limiter είναι κοινός, το παράλληλο δε κερδίζει throughput.
  for (const token of tokens) {
    try {
      const traders = await fetchTokenTraders({ tokenAddress: token.tokenAddress, orderBy: 'profit', limit: tradersLimit });
      tradersSeen += traders.length;
      const kept: TokenTrader[] = [];
      for (const trader of traders) {
        const reason = traderRejectReason(trader, nowSec);
        if (reason === null) kept.push(trader);
        else rejected[reason] += 1;
      }
      perTokenTraders.push(kept);
    } catch (error) {
      // Rate limit σταματά ΟΛΟΚΛΗΡΟ τον κύκλο (βλ. rethrowIfRateLimited).
      rethrowIfRateLimited(error);
      traderFailures += 1;
    }
    await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
  }

  const ranked = rankCandidatesByFrequency(perTokenTraders);
  const known = await listKnownAddresses(ranked.map((c) => c.address));
  for (const [address, at] of recentlyRejected) if (now - at > REJECTED_TTL_MS) recentlyRejected.delete(address);
  const toScore = ranked
    .filter((c) => !known.has(c.address) && !recentlyRejected.has(c.address))
    .slice(0, DISCOVERY_MAX_SCORED_PER_CYCLE);

  let discovered = 0;
  let belowThreshold = 0;
  let alreadyKnown = ranked.filter((c) => known.has(c.address)).length;
  let statsFailures = 0;

  for (const candidate of toScore) {
    let stats: WalletStats;
    try {
      stats = await fetchWalletStats({ wallet: candidate.address });
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
    } catch (error) {
      rethrowIfRateLimited(error);
      statsFailures += 1;
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
      continue;
    }
    if (!passesTopTraderThreshold(stats)) {
      belowThreshold += 1;
      recentlyRejected.set(candidate.address, Date.now());
      continue;
    }
    const inserted = await insertWalletIfNew({
      address: candidate.address,
      source: 'top_trader',
      active: true,
      winRate: stats.winRate,
      pnlMultiplier: stats.realizedPnlRatio,
      tradeCount: stats.tokenCount,
      avgHoldingSec: stats.avgHoldingPeriodSec,
    });
    if (inserted) {
      discovered += 1;
      // 2026-10-04: bots (μέσος χρόνος κράτησης < 60″) όχι στο realtime feed — walletSubscriptionSync.ts.
      if (isRealtimeSignalWallet({ copyMode: 'signal', avgHoldingSec: stats.avgHoldingPeriodSec })) {
        options.realtimeConnection?.subscribeWallet(candidate.address);
      }
    } else alreadyKnown += 1;
  }

  return {
    tokensScanned: tokens.length,
    tradersSeen,
    rejected,
    uniqueCandidates: ranked.length,
    discovered,
    belowThreshold,
    alreadyKnown,
    failures: traderFailures + statsFailures,
  };
}

/** Ελάχιστος ΜΕΣΟΣ χρόνος κρατήματος (όλο το ιστορικό του wallet, `pnl_stat.avg_holding_period`). */
export const MIN_AVG_HOLDING_SEC = 120;

/** Το υπάρχον floor (`passesAutoDiscoveryThreshold`) ΚΑΙ μέσος χρόνος κρατήματος ≥ 2′ —
 * άγνωστος χρόνος = δεν περνάει. */
export function passesTopTraderThreshold(stats: WalletStats): boolean {
  return (
    passesAutoDiscoveryThreshold(stats) &&
    stats.avgHoldingPeriodSec !== null &&
    stats.avgHoldingPeriodSec >= MIN_AVG_HOLDING_SEC
  );
}

/** Ταξινομεί κατά `complete_timestamp` (graduation), όχι `created_timestamp`. */
export function pickRecentGraduated(
  candidates: readonly TrenchCandidate[],
  sampleSize: number,
): TrenchCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, completedAt: readCompleteTimestamp(candidate) }))
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, sampleSize)
    .map((entry) => entry.candidate);
}

function readCompleteTimestamp(candidate: TrenchCandidate): number | null {
  const value = candidate.raw['complete_timestamp'];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export interface DiscoveryCandidate {
  address: string;
  /** Σε πόσα από τα sampled tokens εμφανίστηκε ως tagged holder. */
  tokenCount: number;
}

/**
 * Μοναδικά wallets σε ΟΛΑ τα sampled tokens, ταξινομημένα κατά συχνότητα εμφάνισης
 * φθίνουσα — τα multi-token wallets σκοράρονται πρώτα (πιο πιθανό να τελειώσει ο
 * throttled κύκλος σε αυτά πριν σε λιγότερο ενδιαφέροντα candidates), ΧΩΡΙΣ να
 * αποκλείονται όσα εμφανίζονται σε ένα μόνο token — η συχνότητα είναι βαρύτητα
 * προτεραιότητας, δεν είναι hard filter.
 */
export function rankCandidatesByFrequency(
  perTokenHolders: readonly (readonly { address: string }[])[],
): DiscoveryCandidate[] {
  const counts = new Map<string, number>();
  for (const holders of perTokenHolders) {
    // Set ανά token: αν το ίδιο address εμφανιζόταν δις στην ίδια λίστα holders δε
    // πρέπει να μετρήσει σαν να το είδαμε σε δύο διαφορετικά tokens.
    for (const address of new Set(holders.map((holder) => holder.address))) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([address, tokenCount]) => ({ address, tokenCount }))
    .sort((a, b) => b.tokenCount - a.tokenCount || (a.address < b.address ? -1 : 1));
}

/**
 * Το ΙΔΙΟ floor με το manual advisory alert (`telegram/commands.ts`) — CLAUDE.md
 * ρητά το ορίζει ως ένα και μόνο threshold, όχι δύο ξεχωριστά νούμερα που θα
 * μπορούσαν να αποσυγχρονιστούν. `winRate > 0.5` (strict) `AND tokenCount >= 15`.
 * `token_num`, ΟΧΙ buy+sell — διαφέρουν έως 5× (βλ. `gmgn/walletStats.ts`).
 */
export function passesAutoDiscoveryThreshold(stats: WalletStats): boolean {
  return (
    stats.winRate !== null &&
    stats.winRate > ADVISORY_WIN_RATE_FLOOR &&
    stats.tokenCount !== null &&
    stats.tokenCount >= ADVISORY_TOKEN_COUNT_FLOOR
  );
}

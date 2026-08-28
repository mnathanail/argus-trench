import { insertWalletIfNew } from '../db/repositories/watchlistWallets.js';
import { LAUNCHPAD_PLATFORMS } from '../decision/gateConfig.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { fetchTokenHolders, type HolderTag, type TokenHolder } from '../gmgn/holders.js';
import { fetchTrenches, type TrenchCandidate } from '../gmgn/trenches.js';
import { fetchWalletStats, type WalletStats } from '../gmgn/walletStats.js';
import { WALLET_DISCOVERY_LOOP_PACING_MS } from './intervals.js';
import { ADVISORY_TOKEN_COUNT_FLOOR, ADVISORY_WIN_RATE_FLOOR } from '../telegram/commands.js';
import { delay } from '../util/delay.js';

/**
 * Layer 2 — «Αυτόματο» wallet discovery (CLAUDE.md). Weekly, standing process
 * ανεξάρτητο από τα layer 1/3 collectors:
 *
 *   ~8-10 πρόσφατα graduated Pump.fun tokens (default — βλ. σημείωση παρακάτω)
 *     → holders tagged `smart_degen` ανά token
 *     → μοναδικά candidate wallets, με πόσα tokens τα «είδαν» (βαρύτητα, όχι φίλτρο)
 *     → `portfolio stats` ανά candidate, σειριακά
 *     → INSERT σε watchlist_wallets ΜΟΝΟ όσα περνούν το ίδιο threshold με το manual
 *       floor (`win_rate > 0.5 AND token_num >= 15`) — αλλιώς skip, όχι inactive row.
 *
 * Throttled by design: όλα τα calls (holders weight 5, stats weight 3) περνούν σειριακά
 * από τον ΙΔΙΟ global rate limiter (`gmgn/exec.ts`) που ήδη μοιράζεται με
 * discovery/wallet-activity/wallet-scoring, ΚΑΙ με σκόπιμο `WALLET_DISCOVERY_LOOP_PACING_MS`
 * ανάμεσα σε διαδοχικά calls — βλ. `util/delay.ts` για το γιατί το weight-based budget
 * από μόνο του δεν αρκούσε (RATE_LIMIT_EXCEEDED σε κάθε ριπή, ανεξάρτητα από backoff).
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
 * ⚠️ Κάθε per-item `catch` (ανά token για holders, ανά candidate για stats) καλεί ΠΡΩΤΑ
 * `rethrowIfRateLimited` — ένα naive `catch { failures++; continue }` θα καταπίνε το
 * `GmgnRateLimitError` και θα ξαναχτυπούσε το API στο ΕΠΟΜΕΝΟ item μέσα στο ban,
 * επεκτείνοντάς το κατά 5s ανά request (βρέθηκε ως πραγματικό bug στο υπάρχον
 * `scoring.ts` όσο χτιζόταν αυτό το collector — διορθώθηκε εκεί επίσης).
 */
export interface WalletDiscoveryOptions {
  /** «~20-30» στο αρχικό spec· μειώθηκε σε πρακτικό default — βλ. σχόλιο πάνω από τη function. */
  sampleSize?: number;
  /** Πρωτεύον tag. `renowned` είναι προαιρετικό πρόσθετο πέρασμα — βλ. `includeRenowned`. */
  tag?: HolderTag;
  /** Δεύτερο, ξεχωριστό call ανά token (ίδιο weight 5) — off by default για να μη διπλασιάζει το κόστος. */
  includeRenowned?: boolean;
  /** Πόσους holders να ζητήσει ανά token/tag call. */
  holdersLimitPerToken?: number;
}

export interface WalletDiscoveryResult {
  tokensScanned: number;
  uniqueCandidates: number;
  /** Νέα active=true rows. */
  discovered: number;
  /** Σκοράρισμα έγινε, δεν έφτασε το threshold — καμία εγγραφή. */
  belowThreshold: number;
  /** Το address υπήρχε ήδη (οποιοδήποτε source) — δεν το αγγίξαμε. */
  alreadyKnown: number;
  /** holders ή stats call που απέτυχε για ένα token/wallet· δεν σταματά τον κύκλο. */
  failures: number;
}

export async function runWalletDiscoveryCycle(
  options: WalletDiscoveryOptions = {},
): Promise<WalletDiscoveryResult> {
  const sampleSize = options.sampleSize ?? 10;
  const tag = options.tag ?? 'smart_degen';
  const holdersLimit = options.holdersLimitPerToken ?? 20;

  const graduated = await fetchTrenches({ category: 'completed', launchpadPlatforms: LAUNCHPAD_PLATFORMS });
  const tokens = pickRecentGraduated(graduated, sampleSize);

  const perTokenHolders: TokenHolder[][] = [];
  let holderFailures = 0;

  // Σειριακά ανά token: ο rate limiter είναι κοινός, το παράλληλο δε κερδίζει throughput
  // — ίδιο σκεπτικό με discovery.ts/walletActivity.ts.
  for (const token of tokens) {
    try {
      perTokenHolders.push(
        await fetchTokenHolders({ tokenAddress: token.tokenAddress, tag, limit: holdersLimit }),
      );
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
    } catch (error) {
      // Rate limit σταματά ΟΛΟΚΛΗΡΟ τον κύκλο — αλλιώς τα επόμενα tokens θα
      // ξαναχτυπούσαν το API μέσα στο ban (βλ. rethrowIfRateLimited).
      rethrowIfRateLimited(error);
      holderFailures += 1;
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
      continue;
    }
    if (!options.includeRenowned) continue;
    try {
      perTokenHolders.push(
        await fetchTokenHolders({ tokenAddress: token.tokenAddress, tag: 'renowned', limit: holdersLimit }),
      );
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
    } catch (error) {
      rethrowIfRateLimited(error);
      holderFailures += 1;
      await delay(WALLET_DISCOVERY_LOOP_PACING_MS);
    }
  }

  const candidates = rankCandidatesByFrequency(perTokenHolders);

  let discovered = 0;
  let belowThreshold = 0;
  let alreadyKnown = 0;
  let statsFailures = 0;

  for (const candidate of candidates) {
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
    if (!passesAutoDiscoveryThreshold(stats)) {
      belowThreshold += 1;
      continue;
    }
    const inserted = await insertWalletIfNew({
      address: candidate.address,
      source: 'smart_money',
      active: true,
      winRate: stats.winRate,
      pnlMultiplier: stats.realizedPnlRatio,
      tradeCount: stats.tokenCount,
    });
    if (inserted) discovered += 1;
    else alreadyKnown += 1;
  }

  return {
    tokensScanned: tokens.length,
    uniqueCandidates: candidates.length,
    discovered,
    belowThreshold,
    alreadyKnown,
    failures: holderFailures + statsFailures,
  };
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
  perTokenHolders: readonly (readonly TokenHolder[])[],
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

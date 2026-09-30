import { listWalletsWithOpenMirrorPositions } from '../db/repositories/mirror.js';
import { listMirrorWallets } from '../db/repositories/watchlistWallets.js';
import { fetchWalletActivity, type WalletActivity } from '../gmgn/activity.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { runCli } from '../gmgn/exec.js';
import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { handleMirrorEvent, type MirrorOutcome } from './mirrorHandler.js';

/**
 * MIRROR route — δεύτερη πηγή (2026-09-30). Το PumpPortal δεν μας έστειλε αγορές του
 * chriskogias (π.χ. ADAM, Pump.fun $6k, καμία εγγραφή πουθενά), οπότε για τα mirror wallets
 * ρωτάμε ΚΑΙ το GMGN (`portfolio activity`, weight 3/wallet) κάθε MIRROR_POLL_INTERVAL_MS.
 * Ίδιος handler, ίδιο signature (= tx_hash) → ό,τι έρθει και από τις δύο πηγές μετράει μία
 * φορά. Κάθε mirror_events row γράφει την πηγή (detail_json.source) — έτσι φαίνεται και
 * πόσα χάνει το PumpPortal.
 *
 * Μετατροπή activity → event: tokenAmount = token_amount, solAmount = quote_amount (μόνο αν
 * το quote είναι SOL), τιμή = sol/tokens (pool 'pump-amm', χωρίς curve πεδία — βλ.
 * priceFromTradeEvent). Πώληση με is_open_or_close=1 = πλήρης έξοδος (newTokenBalance 0)·
 * αλλιώς το % βγαίνει από την εκτίμηση υπολοίπου της θέσης. Launchpad από το `launchpad_platform`
 * του activity row (fallback `token info`, μία φορά ανά token): μόνο Pump.fun → pool 'pump-amm'·
 * αλλιώς 'other' (αγνοείται).
 */

export const MIRROR_POLL_INTERVAL_MS = 15_000;
/** Στο πρώτο poll μετά από start: δεν ξαναπαίζουμε ιστορικό πέρα από αυτό. */
const FIRST_POLL_LOOKBACK_SEC = 300;
const MIRROR_POLL_PRIORITY = 600;
const SOL_QUOTES = new Set(['So11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);

const cursors = new Map<string, number>(); // wallet → τελευταίο timestamp (unix sec) που επεξεργαστήκαμε
const launchpadCache = new Map<string, string | null>();

export interface MirrorPollDeps {
  listWallets: () => Promise<string[]>;
  fetchActivity: (wallet: string) => Promise<WalletActivity[]>;
  launchpadOf: (mint: string) => Promise<string | null>;
  handle: (event: PumpPortalTradeEvent) => Promise<MirrorOutcome | null>;
  nowSec: () => number;
}

async function launchpadFromGmgn(mint: string): Promise<string | null> {
  if (launchpadCache.has(mint)) return launchpadCache.get(mint) ?? null;
  const raw = (await runCli('token info', ['token', 'info', '--chain', 'sol', '--address', mint], {
    priority: MIRROR_POLL_PRIORITY,
  })) as Record<string, unknown>;
  const lp = typeof raw['launchpad_platform'] === 'string' && raw['launchpad_platform'] !== '' ? raw['launchpad_platform'] : null;
  launchpadCache.set(mint, lp);
  return lp;
}

const defaultDeps: MirrorPollDeps = {
  listWallets: async () => {
    const mirror = (await listMirrorWallets()).map((w) => w.address);
    const withOpen = await listWalletsWithOpenMirrorPositions();
    return [...new Set([...mirror, ...withOpen])];
  },
  fetchActivity: async (wallet) =>
    (await fetchWalletActivity({ wallet, types: ['buy', 'sell'], limit: 30, priority: MIRROR_POLL_PRIORITY })).activities,
  launchpadOf: launchpadFromGmgn,
  handle: (event) => handleMirrorEvent(event, 'gmgn'),
  nowSec: () => Math.floor(Date.now() / 1000),
};

/** Καθαρή μετατροπή· null = δεν αντιγράφεται (όχι buy/sell, όχι SOL quote, λείπουν ποσά). */
export function activityToEvent(a: WalletActivity, launchpad: string | null): PumpPortalTradeEvent | null {
  if (a.eventType !== 'buy' && a.eventType !== 'sell') return null;
  if (a.quoteAddress !== undefined && a.quoteAddress !== null && !SOL_QUOTES.has(a.quoteAddress)) return null;
  if (a.tokenAmount === null || !(a.tokenAmount > 0) || a.quoteAmount === undefined || a.quoteAmount === null) return null;
  return {
    signature: a.txHash,
    mint: a.tokenAddress,
    traderPublicKey: a.wallet,
    txType: a.eventType,
    tokenAmount: a.tokenAmount,
    solAmount: a.quoteAmount,
    pool: launchpad === 'Pump.fun' ? 'pump-amm' : 'other',
    ...(a.eventType === 'sell' && a.isOpenOrClose === 1 ? { newTokenBalance: 0 } : {}),
  };
}

export interface MirrorPollResult {
  wallets: number;
  newActivities: number;
  outcomes: MirrorOutcome[];
  failures: number;
}

export async function runMirrorPollCycle(deps: MirrorPollDeps = defaultDeps): Promise<MirrorPollResult> {
  const wallets = await deps.listWallets();
  const outcomes: MirrorOutcome[] = [];
  let newActivities = 0;
  let failures = 0;
  for (const wallet of wallets) {
    const since = cursors.get(wallet) ?? deps.nowSec() - FIRST_POLL_LOOKBACK_SEC;
    try {
      const fresh = (await deps.fetchActivity(wallet))
        .filter((a) => a.timestamp >= since) // ίδιο δευτερόλεπτο: τα διπλά τα κόβει το signature
        .sort((x, y) => x.timestamp - y.timestamp);
      let maxTs = since;
      for (const a of fresh) {
        newActivities += 1;
        // Το activity row έχει ήδη launchpad_platform· `token info` μόνο αν λείπει.
        const tradable = a.eventType === 'buy' || a.eventType === 'sell';
        const launchpad = !tradable ? null : (a.launchpadPlatform ?? (await deps.launchpadOf(a.tokenAddress)));
        const event = activityToEvent(a, launchpad);
        if (event !== null) {
          const outcome = await deps.handle(event);
          if (outcome !== null) outcomes.push(outcome);
        }
        maxTs = Math.max(maxTs, a.timestamp);
      }
      cursors.set(wallet, maxTs);
    } catch (error) {
      rethrowIfRateLimited(error);
      failures += 1;
      console.error(`[mirror-poll] ${wallet.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { wallets: wallets.length, newActivities, outcomes, failures };
}

/** Μόνο για tests. */
export function resetMirrorPollState(): void {
  cursors.clear();
  launchpadCache.clear();
}

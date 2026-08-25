import { findPassedTokens, recordTrigger } from '../db/repositories/decisionLog.js';
import {
  listActiveWallets,
  updateActivityCursor,
  type WatchlistWallet,
} from '../db/repositories/watchlistWallets.js';
import { PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import { fetchWalletBuys, type WalletActivity } from '../gmgn/activity.js';
import type { GateThresholds } from '../gmgn/trenches.js';

/**
 * Layer 3 — signal triggers. Η τομή των δύο ρευμάτων: trusted wallet από ΤΗ ΛΙΣΤΑ ΜΑΣ
 * αγοράζει token που πέρασε το gate.
 *
 * Πηγή είναι το `portfolio activity --type buy` ανά wallet, ΟΧΙ το `track follow-wallet`
 * (αυτό resolve-άρει τη λίστα από τα follows του GMGN account, δηλαδή εξαρτάται από το UI
 * — βλ. CLAUDE.md layer 3). Κόστος: weight 3 **ανά wallet**.
 *
 * Φάση 1: το signal καταγράφεται ως `signal_logged`, καμία συναλλαγή.
 */
export interface WalletActivityOptions {
  thresholds?: GateThresholds;
  /** Πόσα trades ζητάμε ανά wallet. Αρκετά για να καλύψουν ένα poll interval. */
  pageSize?: number;
}

export interface WalletActivityResult {
  version: string;
  walletsPolled: number;
  newBuys: number;
  signalsRecorded: number;
}

export async function runWalletActivityCycle(
  options: WalletActivityOptions = {},
): Promise<WalletActivityResult> {
  const version = logicVersion(options.thresholds ?? PHASE1_THRESHOLDS);
  const wallets = await listActiveWallets();

  let newBuys = 0;
  let signalsRecorded = 0;

  for (const wallet of wallets) {
    // Σειριακά ανά wallet: ο rate limiter είναι κοινός, άρα το παράλληλο δε κερδίζει
    // throughput — θα έκανε μόνο τα logs μη ντετερμινιστικά και το 429 πιο πιθανό.
    const buys = await fetchNewBuys(wallet, options.pageSize ?? 20);
    if (buys.length === 0) continue;
    newBuys += buys.length;

    const gated = await findPassedTokens(buys.map((buy) => buy.tokenAddress), version);
    for (const buy of buys) {
      if (!gated.has(buy.tokenAddress)) continue;
      const updated = await recordTrigger({
        tokenAddress: buy.tokenAddress,
        logicVersion: version,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: wallet.address,
        // Τα scores ΤΗ ΣΤΙΓΜΗ του trigger, όχι σημερινά — αλλιώς το backtest είναι
        // μεροληπτικό προς τα σημερινά αποτελέσματα του wallet.
        triggerWalletSnapshot: {
          win_rate: wallet.winRate,
          pnl_multiplier: wallet.pnlMultiplier,
          trade_count: wallet.tradeCount,
          source: wallet.source,
          buy_cost_usd: buy.costUsd,
          buy_price_usd: buy.priceUsd,
          buy_tx_hash: buy.txHash,
          buy_timestamp: buy.timestamp,
        },
        decision: 'signal_logged',
        decisionReasonText: `${wallet.source} wallet ${short(wallet.address)} αγόρασε ${buy.tokenSymbol ?? short(buy.tokenAddress)} — gate είχε περάσει`,
      });
      if (updated > 0) signalsRecorded += 1;
    }

    // Ο cursor προχωράει ΑΦΟΥ επεξεργαστούμε τη σελίδα: αν σκάσει κάτι στη μέση, ο
    // επόμενος κύκλος θα ξαναδεί τα ίδια buys αντί να τα χάσει σιωπηλά.
    const newest = buys[0];
    if (newest) {
      await updateActivityCursor(wallet.address, newest.txHash, new Date(newest.timestamp * 1000));
    }
  }

  return { version, walletsPolled: wallets.length, newBuys, signalsRecorded };
}

/**
 * Τα trades έρχονται newest-first. Κρατάμε ό,τι είναι πιο νέο από τον cursor.
 *
 * Ο έλεγχος γίνεται σε tx hash ΚΑΙ σε timestamp: το hash είναι το ακριβές σημείο που
 * φτάσαμε, αλλά αν εξαφανιστεί από τη σελίδα (π.χ. πολλά νέα trades στο μεσοδιάστημα) το
 * timestamp είναι το ασφαλές fallback ώστε να μη ξανα-παραχθούν παλιά signals.
 */
export async function fetchNewBuys(
  wallet: WatchlistWallet,
  pageSize: number,
): Promise<WalletActivity[]> {
  const page = await fetchWalletBuys(wallet.address, { limit: pageSize });
  return filterNewBuys(page.activities, wallet.lastSeenTxHash, wallet.lastSeenActivityAt);
}

/** Χωριστά από το fetch ώστε να τεστάρεται χωρίς δίκτυο. */
export function filterNewBuys(
  activities: readonly WalletActivity[],
  cursorHash: string | null,
  cursorTime: Date | null,
): WalletActivity[] {
  const fresh: WalletActivity[] = [];
  for (const activity of activities) {
    if (cursorHash !== null && activity.txHash === cursorHash) break;
    if (cursorTime !== null && activity.timestamp * 1000 <= cursorTime.getTime()) break;
    fresh.push(activity);
  }
  return fresh;
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

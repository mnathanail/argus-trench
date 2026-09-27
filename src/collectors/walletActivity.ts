import { findPassedTokens, recordTrigger } from '../db/repositories/decisionLog.js';
import { countOpenLiveOrPaperTrades } from '../db/repositories/paperTrades.js';
import {
  markActivityChecked,
  selectWalletsForActivityCheck,
  updateActivityCursor,
  type WatchlistWallet,
} from '../db/repositories/watchlistWallets.js';
import {
  WALLET_ACTIVITY_LOOP_PACING_MS,
  WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE,
  WALLET_ACTIVITY_WALLETS_PER_CYCLE,
} from './intervals.js';
import { PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import { fetchWalletBuys, type WalletActivity } from '../gmgn/activity.js';
import type { GateThresholds } from '../gmgn/trenches.js';
import { delay } from '../util/delay.js';

/**
 * Layer 3 — signal triggers. Η τομή των δύο ρευμάτων: trusted wallet από ΤΗ ΛΙΣΤΑ ΜΑΣ
 * αγοράζει token που πέρασε το gate.
 *
 * Πηγή είναι το `portfolio activity --type buy` ανά wallet, ΟΧΙ το `track follow-wallet`
 * (αυτό resolve-άρει τη λίστα από τα follows του GMGN account, δηλαδή εξαρτάται από το UI
 * — βλ. CLAUDE.md layer 3). Κόστος: weight 3 **ανά wallet**.
 *
 * Το signal καταγράφεται ως `signal_logged` στο decision_log, ΚΑΝΕΝΑ trade (2026-09-27:
 * trades ανοίγει μόνο το realtime/live path). Σημ.: αυτό το loop δεν είναι πια wired στο
 * main.ts — το ίδιο σήμα έρχεται realtime μέσω PumpPortal websocket.
 */
export interface WalletActivityOptions {
  thresholds?: GateThresholds;
  /** Πόσα trades ζητάμε ανά wallet. Αρκετά για να καλύψουν ένα poll interval. */
  pageSize?: number;
  /** Μέγιστος αριθμός wallets ανά κύκλο· το default εφαρμόζει round-robin polling. */
  walletsPerCycle?: number;
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

  const openTrades = await countOpenLiveOrPaperTrades();
  if (openTrades >= WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE) {
    return { version, walletsPolled: 0, newBuys: 0, signalsRecorded: 0 };
  }

  // Selection βάσει "ποιος περιμένει περισσότερο" (last_activity_checked_at ASC), όχι
  // in-memory index — self-healing σε restart, δε λιμοκτονεί wallets στο τέλος μιας
  // λίστας που μεγαλώνει (βλ. migration 0005).
  const wallets = await selectWalletsForActivityCheck(
    options.walletsPerCycle ?? WALLET_ACTIVITY_WALLETS_PER_CYCLE,
  );

  let newBuys = 0;
  let signalsRecorded = 0;

  for (const wallet of wallets) {
    // Σειριακά ανά wallet, με σκόπιμο pacing για αποφυγή IP-level bursts.
    // Το delay μπαίνει ΑΜΕΣΩΣ μετά το ίδιο το network call, όχι στο τέλος του loop
    // body — αλλιώς το early `continue` παρακάτω (καμία νέα activity) θα το παρέκαμπτε
    // ακριβώς στην πιο κοινή περίπτωση.
    const buys = await fetchNewBuys(wallet, options.pageSize ?? 20);
    await delay(WALLET_ACTIVITY_LOOP_PACING_MS);
    // Σφράγισε ΤΩΡΑ, πριν το early continue — το rotation αφορά "πότε το είδαμε",
    // ανεξάρτητα αν βρέθηκε κάτι νέο ή όχι (ίδιο ζήτημα με το delay από πάνω).
    await markActivityChecked(wallet.address);
    if (buys.length === 0) continue;
    newBuys += buys.length;

    const gated = await findPassedTokens(buys.map((buy) => buy.tokenAddress), version);
    for (const buy of buys) {
      const gateSnapshot = gated.get(buy.tokenAddress);
      if (gateSnapshot === undefined) continue;

      const recorded = await recordTrigger({
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
      // 2026-09-27: μόνο decision_log, κανένα log_only trade/subscription — βλ. docstring.
      if (recorded !== null) signalsRecorded += 1;
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
  const page = await fetchWalletBuys(wallet.address, {
    limit: pageSize,
    stopAtTxHash: wallet.lastSeenTxHash,
    stopAtTimestamp: wallet.lastSeenActivityAt?.getTime() ?? null,
    priority: 5,
  });
  return filterNewBuys(page.activities, wallet.lastSeenTxHash, wallet.lastSeenActivityAt);
}

/** Χωριστά από το fetch ώστε να τεστάρεται χωρίς δίκτυο. */
export function filterNewBuys(
  activities: readonly WalletActivity[],
  cursorHash: string | null,
  cursorTime: Date | null,
): WalletActivity[] {
  const fresh: WalletActivity[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    if (cursorHash !== null && activity.txHash === cursorHash) break;
    if (cursorTime !== null && activity.timestamp * 1000 <= cursorTime.getTime()) break;
    if (seen.has(activity.txHash)) continue;
    seen.add(activity.txHash);
    fresh.push(activity);
  }
  return fresh;
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

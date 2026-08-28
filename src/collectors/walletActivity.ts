import { findPassedTokens } from '../db/repositories/decisionLog.js';
import { recordSignal } from '../db/repositories/entries.js';
import {
  listActiveWallets,
  updateActivityCursor,
  type WatchlistWallet,
} from '../db/repositories/watchlistWallets.js';
import { WALLET_LOOP_PACING_MS } from './intervals.js';
import { PHASE1_THRESHOLDS, logicVersion } from '../decision/gateConfig.js';
import {
  PAPER_ASSUMED_LATENCY_MS,
  PAPER_ASSUMED_SLIPPAGE_PCT,
  PAPER_BANKROLL_SOL,
  PAPER_POSITION_SIZE_PCT,
  conditionOrdersJson,
} from '../decision/paperTradingConfig.js';
import { fetchWalletBuys, type WalletActivity } from '../gmgn/activity.js';
import type { GateThresholds } from '../gmgn/trenches.js';
import { toNumberOrNull } from '../gmgn/validate.js';
import { delay } from '../util/delay.js';

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
    // Σειριακά ανά wallet, ΜΕ σκόπιμο pacing (όχι μόνο σειριακά) — βλ. WALLET_LOOP_PACING_MS.
    // Το delay μπαίνει ΑΜΕΣΩΣ μετά το ίδιο το network call, όχι στο τέλος του loop
    // body — αλλιώς το early `continue` παρακάτω (καμία νέα activity) θα το παρέκαμπτε
    // ακριβώς στην πιο κοινή περίπτωση.
    const buys = await fetchNewBuys(wallet, options.pageSize ?? 20);
    await delay(WALLET_LOOP_PACING_MS);
    if (buys.length === 0) continue;
    newBuys += buys.length;

    const gated = await findPassedTokens(buys.map((buy) => buy.tokenAddress), version);
    for (const buy of buys) {
      const gateSnapshot = gated.get(buy.tokenAddress);
      if (gateSnapshot === undefined) continue;

      // 'price' έρχεται από το ήδη-fetched gate_snapshot_json — ΟΧΙ φρέσκο call, ακριβώς
      // όπως ορίστηκε: δε ρισκάρουμε επιπλέον GMGN weight μόνο για ένα simulated entry.
      const entryPrice = toNumberOrNull(gateSnapshot['price'], 'gate_snapshot.price');
      const simulatedEntryAmountSol = PAPER_BANKROLL_SOL * PAPER_POSITION_SIZE_PCT;

      const recorded = await recordSignal(
        {
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
        },
        {
          tokenAddress: buy.tokenAddress,
          intendedSizePct: PAPER_POSITION_SIZE_PCT,
          bankrollAtEntry: PAPER_BANKROLL_SOL,
          // entryPrice==null σε ελάχιστα, ασυνήθιστα gate_snapshots χωρίς 'price' — 0 αντί
          // για null ώστε το column (NUMERIC NOT NULL-ish χρήση) να μη σκάσει· το
          // exit-resolver ήδη πρέπει να αγνοεί trades με μη-ρεαλιστική τιμή.
          simulatedEntryPrice: entryPrice ?? 0,
          simulatedEntryAmountSol: simulatedEntryAmountSol,
          assumedSlippagePct: PAPER_ASSUMED_SLIPPAGE_PCT,
          assumedLatencyMs: PAPER_ASSUMED_LATENCY_MS,
          conditionOrders: conditionOrdersJson(),
        },
      );
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

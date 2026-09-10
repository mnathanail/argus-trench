import { findPassedTokens } from '../db/repositories/decisionLog.js';
import { recordSignal } from '../db/repositories/entries.js';
import { countOpenTrades } from '../db/repositories/paperTrades.js';
import { getWallet, type WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import { logicVersion, PHASE1_THRESHOLDS } from '../decision/gateConfig.js';
import {
  PAPER_ASSUMED_LATENCY_MS,
  PAPER_ASSUMED_SLIPPAGE_PCT,
  PAPER_BANKROLL_SOL,
  PAPER_POSITION_SIZE_PCT,
  conditionOrdersJson,
} from '../decision/paperTradingConfig.js';
import { WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE } from '../collectors/intervals.js';
import { priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { subscribeForNewTrade } from './subscriptionManager.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';

export interface RealtimeEntryResult {
  tokenAddress: string;
  walletAddress: string;
  walletName: string | null;
  entryPrice: number;
}

export type EntryWalletInput = Pick<
  WatchlistWallet,
  'address' | 'active' | 'winRate' | 'pnlMultiplier' | 'tradeCount' | 'source' | 'name'
> | null;

export type EntryDecision = { type: 'skip' } | { type: 'enter'; entryPrice: number };

/**
 * Καθαρή απόφαση — τεσταρίζεται πλήρως χωρίς DB, ίδιο σκεπτικό με το decideForTick στο
 * realtimeExitHandler.ts. Η ΕΚΤΕΛΕΣΗ (fetches, recordSignal, subscribe) ζει στο
 * handleRealtimeEntryEvent παρακάτω.
 */
export function decideEntry(
  event: PumpPortalTradeEvent,
  wallet: EntryWalletInput,
  gateSnapshotExists: boolean,
  openTradesCount: number,
): EntryDecision {
  if (event.txType !== 'buy') return { type: 'skip' };
  // Άμυνα: το wallet θα μπορούσε να έχει απενεργοποιηθεί (auto-lifecycle) ΑΦΟΥ κάναμε
  // subscribe αλλά ΠΡΙΝ φτάσει αυτό το event — δεν το ξανααφαιρούμε ποτέ από τη
  // συνδρομή, άρα ο έλεγχος εδώ είναι απαραίτητος.
  if (wallet === null || !wallet.active) return { type: 'skip' };
  if (!gateSnapshotExists) return { type: 'skip' }; // δεν έχει (ακόμα) περάσει το gate
  if (openTradesCount >= WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE) return { type: 'skip' };

  const entryPrice = priceFromTradeEvent(event);
  if (entryPrice === null) return { type: 'skip' }; // π.χ. ήδη εκτός bonding curve

  return { type: 'enter', entryPrice };
}

/**
 * Η websocket αντιστοιχία του wallet-activity.ts's core λογικής — "ένα (ενεργό) wallet
 * μόλις αγόρασε ένα ήδη-gated token" — αλλά ΧΩΡΙΣ κανένα GMGN call τη στιγμή του
 * γεγονότος. Το gate check είναι απλό DB lookup (το discovery loop, ΠΑΡΑΜΕΝΕΙ GMGN-based,
 * έχει ήδη γράψει το αποτέλεσμα στο decision_log).
 *
 * Η τιμή εισόδου είναι η ΠΡΑΓΜΑΤΙΚΗ, στιγμιαία τιμή από το ίδιο το event
 * (`priceFromTradeEvent`) — ΟΧΙ το gate_snapshot's τιμή (που θα μπορούσε να είναι
 * λεπτά/ώρες παλιά). Σκόπιμη βελτίωση σε σχέση με το wallet-activity.ts.
 */
export async function handleRealtimeEntryEvent(
  event: PumpPortalTradeEvent,
  connection: PumpPortalConnection,
): Promise<RealtimeEntryResult | null> {
  if (event.txType !== 'buy') return null; // γρήγορη έξοδος, αποφεύγει τα παρακάτω DB calls

  const wallet = await getWallet(event.traderPublicKey);
  const version = logicVersion(PHASE1_THRESHOLDS);
  const gated = await findPassedTokens([event.mint], version);
  const openTradesCount = await countOpenTrades();

  const decision = decideEntry(event, wallet, gated.has(event.mint), openTradesCount);
  if (decision.type === 'skip') return null;
  // TS δε στενεύει το `wallet` μέσω του decideEntry (ξεχωριστή function) — αλλά
  // decision.type==='enter' εγγυάται ήδη ότι wallet!==null (βλ. decideEntry).
  if (wallet === null) return null;

  const recorded = await recordSignal(
    {
      tokenAddress: event.mint,
      logicVersion: version,
      triggerType: 'smart_money_buy',
      triggerWalletAddress: wallet.address,
      triggerWalletSnapshot: {
        win_rate: wallet.winRate,
        pnl_multiplier: wallet.pnlMultiplier,
        trade_count: wallet.tradeCount,
        source: wallet.source,
        // Το PumpPortal δίνει SOL-denominated ποσά, ΟΧΙ USD (σε αντίθεση με το GMGN) —
        // κρατάμε ό,τι πραγματικά έχουμε, χωρίς να το παρουσιάζουμε σαν USD.
        buy_cost_sol: event.solAmount,
        buy_tx_hash: event.signature,
        buy_timestamp: Math.floor(Date.now() / 1000),
        source_channel: 'pumpportal_websocket',
      },
      decision: 'signal_logged',
      decisionReasonText: `${wallet.source} wallet ${wallet.address} αγόρασε (realtime) — gate είχε περάσει`,
    },
    {
      tokenAddress: event.mint,
      intendedSizePct: PAPER_POSITION_SIZE_PCT,
      bankrollAtEntry: PAPER_BANKROLL_SOL,
      simulatedEntryPrice: decision.entryPrice,
      simulatedEntryAmountSol: PAPER_BANKROLL_SOL * PAPER_POSITION_SIZE_PCT,
      assumedSlippagePct: PAPER_ASSUMED_SLIPPAGE_PCT,
      assumedLatencyMs: PAPER_ASSUMED_LATENCY_MS,
      conditionOrders: conditionOrdersJson(),
      entryAt: new Date(), // πραγματικό realtime event — "τώρα" ΕΙΝΑΙ η πραγματική στιγμή
    },
  );

  if (recorded === null) return null; // π.χ. race με ήδη υπάρχον ανοιχτό trade στο ίδιο ζευγάρι

  subscribeForNewTrade(connection, event.mint, wallet.address);

  return {
    tokenAddress: event.mint,
    walletAddress: wallet.address,
    walletName: wallet.name,
    entryPrice: decision.entryPrice,
  };
}

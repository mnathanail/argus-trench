import { getDecisionById } from '../db/repositories/decisionLog.js';
import { closeTrade, listOpenTrades, type PaperTrade } from '../db/repositories/paperTrades.js';
import type { ExitReason } from '../db/types.js';
import { fetchWalletSells } from '../gmgn/activity.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { fetchKline, type Candle } from '../gmgn/kline.js';
import {
  EXIT_TIER_1_PRICE_SCALE,
  EXIT_TIER_2_ACTIVATION_SCALE,
  EXIT_TIER_2_DRAWDOWN_PCT,
  EXIT_TIMEOUT_MS,
  PAPER_ASSUMED_FEES_PCT,
} from '../decision/paperTradingConfig.js';
import { EXIT_RESOLVER_LOOP_PACING_MS } from './intervals.js';
import { delay } from '../util/delay.js';

/**
 * Κλείνει `paper_trades` (mode='log_only', ανοιγμένα από signal_logged decisions) βάσει
 * πραγματικού ιστορικού τιμών (market kline) και πραγματικής δραστηριότητας του trigger
 * wallet (portfolio activity --type sell) — καμία πραγματική συναλλαγή, μόνο υπολογισμός
 * του τι ΘΑ είχε συμβεί. Χωρίς αυτό, τα signal_logged events δεν μπορούν ποτέ να
 * αποτιμηθούν (CLAUDE.md).
 *
 * Ωριαίο interval σκόπιμα — βλ. EXIT_RESOLVER_INTERVAL_MS στο intervals.ts.
 *
 * ⚠️ Εξαρτάται από το gmgn/kline.ts, ΜΗ επαληθευμένο ακόμα με πραγματικό call.
 */
export interface ExitResolverResult {
  openTrades: number;
  closed: number;
  failures: number;
  failureReasons: string[];
}

export async function runExitResolverCycle(): Promise<ExitResolverResult> {
  const openTrades = await listOpenTrades();
  let closed = 0;
  let failures = 0;
  const failureReasons: string[] = [];

  for (const trade of openTrades) {
    try {
      if (await resolveOneTrade(trade)) closed += 1;
    } catch (error) {
      // Rate limit σταματά ΟΛΟΚΛΗΡΟ τον κύκλο — ίδια λογική με τα άλλα collectors, ίδιος
      // λόγος: τα επόμενα trades δε πρέπει να ξαναχτυπήσουν το API μέσα στο ban.
      rethrowIfRateLimited(error);
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (!failureReasons.includes(reason)) failureReasons.push(reason);
    }
    await delay(EXIT_RESOLVER_LOOP_PACING_MS);
  }

  return { openTrades: openTrades.length, closed, failures, failureReasons };
}

async function resolveOneTrade(trade: PaperTrade): Promise<boolean> {
  // Δεν μπορούμε να υπολογίσουμε % κέρδους χωρίς έγκυρη entry price (σπάνιο: μόνο όταν
  // το gate_snapshot δεν είχε 'price' τη στιγμή του entry) — άφησέ το ανοιχτό, μην
  // κλείσεις με ψεύτικα νούμερα.
  if (trade.simulatedEntryPrice === null || trade.simulatedEntryPrice <= 0) return false;

  const decision = await getDecisionById(trade.decisionLogId);
  const triggerWallet = decision?.triggerWalletAddress ?? null;

  const fromSeconds = Math.floor(trade.entryAt.getTime() / 1000);
  const rawCandles = await fetchKline({ tokenAddress: trade.tokenAddress, from: fromSeconds });
  // Defensive sort: δεν έχουμε επαληθεύσει αν το GMGN εγγυάται χρονολογική σειρά.
  const candles = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

  let walletSellAt: Date | null = null;
  if (triggerWallet !== null) {
    const sells = await fetchWalletSells(triggerWallet, { limit: 20 });
    const afterEntry = sells.activities
      .filter((sell) => sell.tokenAddress === trade.tokenAddress)
      .find((sell) => sell.timestamp * 1000 >= trade.entryAt.getTime());
    walletSellAt = afterEntry ? new Date(afterEntry.timestamp * 1000) : null;
  }

  const result = resolveExit({
    entryPrice: trade.simulatedEntryPrice,
    entryAt: trade.entryAt,
    candles,
    walletSellAt,
    now: new Date(),
  });
  if (result === null) return false;

  const pnlPct = (result.exitPrice - trade.simulatedEntryPrice) / trade.simulatedEntryPrice;
  const pnlSol = (trade.bankrollAtEntry ?? 0) * (trade.intendedSizePct ?? 0) * pnlPct;
  const pnlNetPct = pnlPct - PAPER_ASSUMED_FEES_PCT;

  await closeTrade(trade.id, {
    exitReason: result.exitReason,
    exitTriggerDetail:
      result.exitReason === 'exit_signal' && triggerWallet !== null ? { wallet: triggerWallet } : null,
    simulatedExitPrice: result.exitPrice,
    pnlSol,
    pnlPct,
    assumedFeesPct: PAPER_ASSUMED_FEES_PCT,
    pnlNetPct,
  });
  return true;
}

export interface ExitCheckInput {
  entryPrice: number;
  entryAt: Date;
  /** Πρέπει να είναι ήδη sorted ascending κατά timestamp. */
  candles: readonly Candle[];
  walletSellAt: Date | null;
  now: Date;
}

export interface ExitCheckResult {
  exitReason: ExitReason;
  exitPrice: number;
  exitAt: Date;
}

/**
 * Καθαρή function, χωρίς δίκτυο/DB — ίδιο pattern με το `filterNewBuys` στο
 * walletActivity.ts. Διατρέχει το ιστορικό χρονολογικά και επιστρέφει ΤΟ ΠΡΩΤΟ από τα
 * τέσσερα exit conditions που πυροδοτείται:
 *
 *   1. exit_signal — το trigger wallet πούλησε. Ελέγχεται ΠΡΩΤΟ μέσα σε κάθε candle,
 *      ώστε ένα ταυτόχρονο tier-hit να μην κρύψει ότι βγήκε το wallet που ακολουθούμε
 *      (CLAUDE.md: "βγαίνεις όταν βγαίνουν τα wallets που ακολουθείς, ανεξάρτητα από τιμή").
 *   2. tp_tier_1 — fixed +50%.
 *   3. trailing_stop — μετά την ενεργοποίηση στο +100%, κλείνει σε -40% από το peak.
 *   4. timeout — 24 ώρες από entry χωρίς κανένα από τα παραπάνω.
 *
 * ΔΕΝ μοντελοποιεί split 50/50 θέσεις σε ξεχωριστά rows (v1, απλοποιημένο σκόπιμα).
 */
export function resolveExit(input: ExitCheckInput): ExitCheckResult | null {
  const tier1Price = input.entryPrice * EXIT_TIER_1_PRICE_SCALE;
  const tier2ActivationPrice = input.entryPrice * EXIT_TIER_2_ACTIVATION_SCALE;
  let trailingActive = false;
  let peakSinceActivation = 0;

  for (const candle of input.candles) {
    const candleTime = new Date(candle.timestamp * 1000);
    if (candleTime.getTime() < input.entryAt.getTime()) continue;

    if (input.walletSellAt !== null && input.walletSellAt.getTime() <= candleTime.getTime()) {
      return { exitReason: 'exit_signal', exitPrice: candle.close, exitAt: input.walletSellAt };
    }

    if (!trailingActive && candle.high >= tier2ActivationPrice) {
      // Το candle δείχνει ότι η τιμή έφτασε ΚΑΙ τα δύο thresholds μέσα στο ίδιο,
      // αδρό παράθυρο — προτιμάμε "συνέχισε ανοδικά" (trailing) αντί για "σταμάτησε
      // στο tier1", αλλιώς το tier1 θα κέρδιζε ΠΑΝΤΑ (κάθε candle που φτάνει +100%
      // περνάει αναγκαστικά και το +50%) και το trailing θα ήταν dead code.
      trailingActive = true;
      peakSinceActivation = candle.high;
    } else if (trailingActive && candle.high > peakSinceActivation) {
      peakSinceActivation = candle.high;
    } else if (!trailingActive && candle.high >= tier1Price) {
      return { exitReason: 'tp_tier_1', exitPrice: tier1Price, exitAt: candleTime };
    }

    if (trailingActive) {
      const stopPrice = peakSinceActivation * (1 - EXIT_TIER_2_DRAWDOWN_PCT);
      if (candle.low <= stopPrice) {
        return { exitReason: 'trailing_stop', exitPrice: stopPrice, exitAt: candleTime };
      }
    }
  }

  // Τίποτα μέσα στο διαθέσιμο ιστορικό — έλεγξε wallet-sell/timeout πέρα από αυτό.
  const lastClose = input.candles.at(-1)?.close ?? input.entryPrice;
  if (input.walletSellAt !== null) {
    return { exitReason: 'exit_signal', exitPrice: lastClose, exitAt: input.walletSellAt };
  }
  if (input.now.getTime() - input.entryAt.getTime() >= EXIT_TIMEOUT_MS) {
    return {
      exitReason: 'timeout',
      exitPrice: lastClose,
      exitAt: new Date(input.entryAt.getTime() + EXIT_TIMEOUT_MS),
    };
  }
  return null;
}

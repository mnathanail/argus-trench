import {
  getLiveHaltState,
  setLiveHalted,
  clearLiveHalt as clearLiveHaltInDb,
} from '../db/repositories/liveTradingState.js';
import { getRecentClosedLiveTrades, getTodayRealizedLossSol } from '../db/repositories/paperTrades.js';
import { LIVE_DAILY_LOSS_CAP_SOL, LIVE_KILL_SWITCH_CONSEC_LOSSES } from './paperTradingConfig.js';
import { startOfAthensDay } from '../util/athensTime.js';

export interface RiskGateResult {
  allowed: boolean;
  reason: string | null;
  /** ΔΙΟΡΘΩΣΗ 2026-09-18: true ΜΟΝΟ όταν ΑΥΤΗ η κλήση ήταν αυτή που πραγματικά ενεργοποίησε
   * το kill-switch τώρα (πρώτη φορά, όχι απλή επιβεβαίωση ήδη ενεργού halt) — βλ.
   * setLiveHalted(). Ο caller (attemptLiveEntry/main.ts) το χρησιμοποιεί για να στείλει
   * proactive Telegram alert ΜΙΑ φορά, αντί ο χρήστης να το μαθαίνει μόνο από το επόμενο
   * daily digest (ή ένα μπαγιάτικο digest, όπως συνέβη πραγματικά 2026-09-17/18). */
  justHalted: boolean;
}

/**
 * Καθαρή, τεσταρίσιμη λειτουργία — μετράει συνεχόμενες ζημιές ξεκινώντας από το πιο
 * πρόσφατο trade, σταματάει στο πρώτο μη-ζημιογόνο (ή άγνωστο) αποτέλεσμα. `pnlSol===null`
 * σπάει το σερί (δεν το αυξάνει) — ένα κλειστό `live` trade με άγνωστο pnl θα ήταν από
 * μόνο του ανησυχητική ανωμαλία, αλλά δεν το μετράμε σαν ζημιά χωρίς να είμαστε σίγουροι.
 */
export function countConsecutiveLosses(recentTradesNewestFirst: readonly { pnlSol: number | null }[]): number {
  let count = 0;
  for (const trade of recentTradesNewestFirst) {
    if (trade.pnlSol === null || trade.pnlSol >= 0) break;
    count += 1;
  }
  return count;
}

/**
 * Καλείται πριν από ΚΑΘΕ live trade (μαζί με το decideTradeMode's balance check — δύο
 * ξεχωριστοί, ανεξάρτητοι έλεγχοι, ΚΑΙ οι δύο πρέπει να περάσουν).
 *
 * Το kill-switch (LIVE_KILL_SWITCH_CONSEC_LOSSES συνεχόμενες ζημιές — 10, από 2026-09-18,
 * βλ. paperTradingConfig.ts) είναι STICKY — μόλις ενεργοποιηθεί, ΜΕΝΕΙ ενεργό ακόμα κι αν
 * αργότερα «σπάσει» το σερί (π.χ. με ένα paper trade, ή απλά με το πέρασμα του χρόνου) —
 * ρητή απόφαση χρήστη 2026-09-11: κάποιος πρέπει να δει ΓΙΑΤΙ έγιναν τόσες ζημιές στη
 * σειρά πριν ξαναρχίσει, όχι να συνεχίσει αυτόματα. Καθαρίζει ΜΟΝΟ μέσω ρητής,
 * χειροκίνητης ενέργειας — βλ. clearLiveHalt().
 */
export async function checkLiveRiskGate(now: Date = new Date()): Promise<RiskGateResult> {
  const halt = await getLiveHaltState();
  if (halt.haltedAt !== null) {
    return {
      allowed: false,
      reason: `kill-switch ενεργό από ${halt.haltedAt.toISOString()} — ${halt.haltedReason}`,
      justHalted: false, // ήδη ενεργό από πριν, όχι νέο — μην ξαναειδοποιήσεις
    };
  }

  const recentTrades = await getRecentClosedLiveTrades(LIVE_KILL_SWITCH_CONSEC_LOSSES);
  const consecLosses = countConsecutiveLosses(recentTrades);
  if (consecLosses >= LIVE_KILL_SWITCH_CONSEC_LOSSES) {
    const reason = `${consecLosses} συνεχόμενες ζημιές`;
    // ενεργοποίηση ΤΩΡΑ, θα μείνει sticky από εδώ και πέρα. `justHalted` ξεχωρίζει "εγώ το
    // πυροδότησα τώρα" από "κάποιο σχεδόν-ταυτόχρονο σήμα το πυροδότησε πρώτο" — και στις
    // δύο περιπτώσεις το trade μπλοκάρεται, αλλά το alert πρέπει να φύγει μία μόνο φορά.
    const justHalted = await setLiveHalted(reason);
    return { allowed: false, reason: `kill-switch — ${reason}`, justHalted };
  }

  const todayLoss = await getTodayRealizedLossSol(startOfAthensDay(now));
  if (todayLoss >= LIVE_DAILY_LOSS_CAP_SOL) {
    return { allowed: false, reason: `ημερήσιο όριο ζημιάς (${todayLoss.toFixed(4)} SOL)`, justHalted: false };
  }

  return { allowed: true, reason: null, justHalted: false };
}

/** Χειροκίνητο reset — καλείται ΜΟΝΟ από ρητή ενέργεια χρήστη. */
export async function clearLiveHalt(): Promise<void> {
  await clearLiveHaltInDb();
}

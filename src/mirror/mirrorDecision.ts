import { priceFromTradeEvent, type PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { MIRROR_ALLOWED_POOLS, MIRROR_FULL_EXIT_PCT } from './mirrorConfig.js';

/**
 * Καθαρή απόφαση του MIRROR route για ένα trade event ενός mirror wallet (χωρίς DB).
 *
 * Κανόνες (ρητή απόφαση χρήστη 2026-09-30, ίδιοι με το σχέδιο του hermes-copyist):
 *  - ΚΑΘΕ αγορά του wallet = μία δική μας αγορά σταθερού ποσού (buySol).
 *  - Κάθε πώληση του wallet = πώληση του ΙΔΙΟΥ % της δικής μας θέσης. % = όσα πούλησε /
 *    όσα είχε πριν την πώληση (από το newTokenBalance του PumpPortal· αλλιώς από την
 *    εκτίμηση υπολοίπου που κρατάμε· αν δεν ξέρουμε τίποτα → 100%, ποτέ «μένουμε μέσα
 *    χωρίς να ξέρουμε»). Πλήρης έξοδος του wallet → κλείνουμε όλη τη θέση.
 *  - Μία θέση ανά token: αν το token το έχει ανοιχτό άλλο mirror wallet → αγνοείται.
 *  - Μόνο Pump.fun / PumpSwap pools. Χωρίς gate, χωρίς stop-loss.
 *  - Paper: αγορά στην τιμή του event + slippage, πώληση στην τιμή του event (ίδια σύμβαση
 *    με το paper του argus: slippage μόνο στην είσοδο, fees στο τελικό pnl).
 */

export interface MirrorPositionState {
  id: number;
  walletAddress: string;
  tokensHeld: number;
  solIn: number;
  solOut: number;
  targetTokensEst: number | null;
  lastPriceSol: number | null;
}

export type MirrorIgnoreReason = 'pool' | 'no_price' | 'zero_amount' | 'other_wallet_position' | 'no_position';

export type MirrorDecision =
  | { action: 'ignored'; reason: MirrorIgnoreReason; priceSol: number | null }
  | { action: 'buy'; open: boolean; priceSol: number; fillPrice: number; ourSol: number; ourTokens: number; targetBalanceAfter: number }
  | {
      action: 'sell';
      close: boolean;
      pct: number;
      pctSource: 'new_token_balance' | 'estimate' | 'unknown_full_exit';
      priceSol: number;
      ourTokens: number;
      ourSol: number;
      targetBalanceAfter: number;
    };

export interface MirrorConfig {
  buySol: number;
  entrySlippagePct: number;
}

export function decideMirror(
  event: PumpPortalTradeEvent,
  position: MirrorPositionState | null,
  cfg: MirrorConfig,
): MirrorDecision {
  if (event.pool === undefined || !MIRROR_ALLOWED_POOLS.includes(event.pool)) {
    return { action: 'ignored', reason: 'pool', priceSol: null };
  }
  if (!(event.tokenAmount > 0)) return { action: 'ignored', reason: 'zero_amount', priceSol: null };

  const eventPrice = priceFromTradeEvent(event);
  if (position !== null && position.walletAddress !== event.traderPublicKey) {
    return { action: 'ignored', reason: 'other_wallet_position', priceSol: eventPrice };
  }

  if (event.txType === 'buy') {
    if (eventPrice === null) return { action: 'ignored', reason: 'no_price', priceSol: null };
    const fillPrice = eventPrice * (1 + cfg.entrySlippagePct);
    return {
      action: 'buy',
      open: position === null,
      priceSol: eventPrice,
      fillPrice,
      ourSol: cfg.buySol,
      ourTokens: cfg.buySol / fillPrice,
      targetBalanceAfter: event.newTokenBalance ?? (position?.targetTokensEst ?? 0) + event.tokenAmount,
    };
  }

  // sell
  if (position === null) return { action: 'ignored', reason: 'no_position', priceSol: eventPrice };
  // Dust sell σε graduated token δεν δίνει τιμή — παίρνουμε την τελευταία γνωστή, ώστε μια
  // έξοδος του wallet να μη μας αφήσει ποτέ κολλημένους μέσα (δεν έχουμε stop-loss).
  const priceSol = eventPrice ?? position.lastPriceSol;
  if (priceSol === null) return { action: 'ignored', reason: 'no_price', priceSol: null };

  let pct: number;
  let pctSource: 'new_token_balance' | 'estimate' | 'unknown_full_exit';
  if (event.newTokenBalance !== undefined) {
    const before = event.newTokenBalance + event.tokenAmount;
    pct = before > 0 ? event.tokenAmount / before : 1;
    pctSource = 'new_token_balance';
  } else if (position.targetTokensEst !== null && position.targetTokensEst > 0) {
    pct = Math.min(1, event.tokenAmount / position.targetTokensEst);
    pctSource = 'estimate';
  } else {
    pct = 1;
    pctSource = 'unknown_full_exit';
  }
  const close = pct >= MIRROR_FULL_EXIT_PCT;
  const ourTokens = close ? position.tokensHeld : position.tokensHeld * pct;
  return {
    action: 'sell',
    close,
    pct: close ? 1 : pct,
    pctSource,
    priceSol,
    ourTokens,
    ourSol: ourTokens * priceSol,
    targetBalanceAfter: event.newTokenBalance ?? Math.max(0, (position.targetTokensEst ?? 0) - event.tokenAmount),
  };
}

/** Τελικό pnl μιας κλειστής θέσης: ό,τι πήραμε − ό,τι βάλαμε − fees (ίδιο % με το paper του argus). */
export function mirrorPnl(solIn: number, solOut: number, feesPct: number): { pnlSol: number; pnlPct: number | null } {
  const pnlSol = solOut - solIn - solIn * feesPct;
  return { pnlSol, pnlPct: solIn > 0 ? pnlSol / solIn : null };
}

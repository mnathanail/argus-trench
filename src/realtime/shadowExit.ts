import {
  EXIT_TIER_2_ACTIVATION_SCALE,
  EXIT_TIER_2_DRAWDOWN_PCT,
  EXIT_TIMEOUT_MS,
  PROFIT_FLOOR_SCALE,
  STOP_LOSS_PCT,
  TRAILING_CONFIRM_MS,
  TRAILING_GRACE_MS,
} from '../decision/paperTradingConfig.js';
import { priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';

/**
 * "4B" trailing σε SHADOW mode (2026-09-28, ρητή απόφαση χρήστη — βλ. migration 0017).
 *
 * Καθαρές, τεσταρίσιμες συναρτήσεις. ΔΕΝ αγγίζουν το `checkTick` (την πραγματική λογική
 * εξόδου) — τρέχουν ΔΙΠΛΑ του στα ίδια ticks και καταγράφουν πού θα είχε βγει το 4B.
 *
 * Διαφορά από τη σημερινή λογική (checkTick) ΜΟΝΟ στο trailing:
 *  - grace period: για TRAILING_GRACE_MS μετά την αγορά το trailing δεν βγαίνει.
 *  - επιβεβαίωση: μετά το grace, η τιμή πρέπει να μείνει ≤ stop για TRAILING_CONFIRM_MS
 *    συνεχόμενα· ένα tick πάνω από το stop μηδενίζει το ρολόι.
 * Ίδια με τη σημερινή: stop-loss −50% (αμέσως, και μέσα στο grace), ενεργοποίηση trailing
 * στο +50%, drawdown 25% από το peak, floor +10%, exit_signal (το trigger wallet πούλησε),
 * timeout 24h. Το tp_tier_1 παραλείπεται — με activation == tier1 δεν πυροδοτείται ποτέ
 * ούτε στην πραγματική λογική.
 */

export interface ShadowState {
  peak: number | null;
  trailingActive: boolean;
  breachSince: Date | null;
}

export interface TrailingConfirmationRules {
  graceMs: number;
  confirmMs: number;
}

export const SHADOW_4B_RULES: TrailingConfirmationRules = {
  graceMs: TRAILING_GRACE_MS,
  confirmMs: TRAILING_CONFIRM_MS,
};

/**
 * Shadow «χωρίς exit_signal» (2026-09-29, migration 0020): ΙΔΙΟΙ κανόνες με τη σημερινή
 * λογική (grace 0, επιβεβαίωση 0 → έξοδος στο πρώτο tick ≤ stop, όπως το checkTick),
 * μόνο που ΔΕΝ βγαίνει όταν πουλάει το trigger wallet (βλ. `ignoreExitSignal`).
 */
export const NO_EXIT_SIGNAL_RULES: TrailingConfirmationRules = { graceMs: 0, confirmMs: 0 };

export type ShadowExitReason = 'stop_loss' | 'trailing_stop' | 'exit_signal' | 'timeout';

export interface ShadowTickResult {
  exit: { reason: 'stop_loss' | 'trailing_stop'; price: number } | null;
  state: ShadowState;
}

export function shadowTick(
  input: { entryPrice: number; entryAt: Date; now: Date; currentPrice: number; state: ShadowState },
  rules: TrailingConfirmationRules = SHADOW_4B_RULES,
): ShadowTickResult {
  const { entryPrice, currentPrice, state } = input;
  const peak = Math.max(state.peak ?? entryPrice, currentPrice);

  const stopLossPrice = entryPrice * (1 - STOP_LOSS_PCT);
  if (currentPrice <= stopLossPrice) {
    return {
      exit: { reason: 'stop_loss', price: Math.min(stopLossPrice, currentPrice) },
      state: { ...state, peak },
    };
  }

  const trailingActive = state.trailingActive || currentPrice >= entryPrice * EXIT_TIER_2_ACTIVATION_SCALE;
  if (!trailingActive) return { exit: null, state: { peak, trailingActive, breachSince: null } };

  const stopPrice = Math.max(peak * (1 - EXIT_TIER_2_DRAWDOWN_PCT), entryPrice * PROFIT_FLOOR_SCALE);
  if (currentPrice > stopPrice) return { exit: null, state: { peak, trailingActive, breachSince: null } };

  const msSinceEntry = input.now.getTime() - input.entryAt.getTime();
  if (msSinceEntry < rules.graceMs) {
    // Μέσα στο grace: καμία έξοδος, και το ρολόι επιβεβαίωσης δεν ξεκινάει ακόμα.
    return { exit: null, state: { peak, trailingActive, breachSince: null } };
  }
  const breachSince = state.breachSince ?? input.now;
  if (input.now.getTime() - breachSince.getTime() >= rules.confirmMs) {
    return { exit: { reason: 'trailing_stop', price: currentPrice }, state: { peak, trailingActive, breachSince } };
  }
  return { exit: null, state: { peak, trailingActive, breachSince } };
}

export interface ShadowTradeInput {
  entryPrice: number;
  entryAt: Date;
  triggerWalletAddress: string | null;
  state: ShadowState;
}

export type ShadowDecision =
  | { type: 'exit'; reason: ShadowExitReason; price: number }
  | { type: 'update'; state: ShadowState }
  | { type: 'ignore' };

/** Η απόφαση του shadow για ένα PumpPortal event — αντίστοιχο του `decideForTick`. */
export function decideShadowTick(
  trade: ShadowTradeInput,
  event: PumpPortalTradeEvent,
  now: Date,
  rules: TrailingConfirmationRules = SHADOW_4B_RULES,
  options: { ignoreExitSignal?: boolean } = {},
): ShadowDecision {
  const price = priceFromTradeEvent(event);

  if (now.getTime() - trade.entryAt.getTime() >= EXIT_TIMEOUT_MS) {
    return { type: 'exit', reason: 'timeout', price: price ?? trade.state.peak ?? trade.entryPrice };
  }

  if (!options.ignoreExitSignal && event.txType === 'sell' && event.traderPublicKey === trade.triggerWalletAddress) {
    return { type: 'exit', reason: 'exit_signal', price: price ?? trade.entryPrice };
  }

  if (price === null) return { type: 'ignore' };

  const result = shadowTick(
    { entryPrice: trade.entryPrice, entryAt: trade.entryAt, now, currentPrice: price, state: trade.state },
    rules,
  );
  if (result.exit !== null) return { type: 'exit', reason: result.exit.reason, price: result.exit.price };

  const s = result.state;
  const unchanged =
    s.peak === trade.state.peak &&
    s.trailingActive === trade.state.trailingActive &&
    (s.breachSince?.getTime() ?? null) === (trade.state.breachSince?.getTime() ?? null);
  return unchanged ? { type: 'ignore' } : { type: 'update', state: s };
}

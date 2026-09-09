import {
  EXIT_TIER_1_PRICE_SCALE,
  EXIT_TIER_2_ACTIVATION_SCALE,
  EXIT_TIER_2_DRAWDOWN_PCT,
} from '../decision/paperTradingConfig.js';

export interface TickCheckInput {
  entryPrice: number;
  /** Το τρέχον peak που έχουμε ήδη δει, από τη βάση (paper_trades.peak_price_since_entry).
   * null αν αυτό είναι το πρώτο tick μετά το entry — δεν έχει έρθει ακόμα τίποτα. */
  peakPriceSinceEntry: number | null;
  /** paper_trades.trailing_active — αν το tier2 έχει ήδη ενεργοποιηθεί σε προηγούμενο tick. */
  trailingActive: boolean;
  /** Η τιμή ΑΥΤΟΥ του tick (από priceFromTradeEvent). */
  currentPrice: number;
}

export interface TickExit {
  exitReason: 'tp_tier_1' | 'trailing_stop';
  exitPrice: number;
}

export interface TickCheckResult {
  /** Αν != null, η θέση πρέπει να κλείσει ΤΩΡΑ. */
  exit: TickExit | null;
  /** Το νέο state να αποθηκευτεί — ΠΑΝΤΑ, ασχέτως αν έκλεισε ή όχι (ο caller το γράφει
   * στη βάση σε κάθε περίπτωση, ώστε το ΕΠΟΜΕΝΟ tick να ξεκινήσει από το σωστό σημείο). */
  newPeakPriceSinceEntry: number;
  newTrailingActive: boolean;
}

/**
 * Η tick-based αντιστοιχία του `resolveExit` (candle-based) στο exitResolver.ts — ίδιοι
 * κανόνες (tier2 προτεραιότητα έναντι tier1 στο ίδιο σημείο, trailing stop από peak μετά
 * την ενεργοποίηση), αλλά δουλεύει πάνω σε ΕΝΑ σημείο τιμής τη φορά αντί για πλήρες
 * ιστορικό candles — το websocket δίνει μεμονωμένα trades, όχι OHLC bars. Το state
 * (peak/trailingActive) περνάει ρητά μέσα-έξω, ΔΕΝ κρατάει τίποτα εσωτερικά — η επιμονή
 * είναι δουλειά του caller (παίρνει από τη βάση, γράφει πίσω στη βάση).
 *
 * ΔΕΝ ελέγχει εδώ το wallet-sell (exit_signal) ή το 24ωρο timeout — αυτά χειρίζονται
 * ξεχωριστά στον orchestration layer (realtimeExitHandler.ts), το πρώτο γιατί δεν είναι
 * τιμή, το δεύτερο γιατί δεν "συμβαίνει" σε κανένα συγκεκριμένο tick, παραμένει δουλειά
 * του periodic exit-resolver.
 */
export function checkTick(input: TickCheckInput): TickCheckResult {
  const tier1Price = input.entryPrice * EXIT_TIER_1_PRICE_SCALE;
  const tier2ActivationPrice = input.entryPrice * EXIT_TIER_2_ACTIVATION_SCALE;

  const peak = Math.max(input.peakPriceSinceEntry ?? input.entryPrice, input.currentPrice);
  let trailingActive = input.trailingActive;

  if (!trailingActive && input.currentPrice >= tier2ActivationPrice) {
    // Ίδιο σκεπτικό με το resolveExit: προτίμησε "συνέχισε ανοδικά" (trailing) αντί για
    // "σταμάτησε στο tier1" — κάθε τιμή που φτάνει +100% περνάει αναγκαστικά και το
    // +50%, άρα χωρίς αυτή την προτεραιότητα το tier1 θα κέρδιζε ΠΑΝΤΑ.
    trailingActive = true;
  } else if (!trailingActive && input.currentPrice >= tier1Price) {
    return {
      exit: { exitReason: 'tp_tier_1', exitPrice: tier1Price },
      newPeakPriceSinceEntry: peak,
      newTrailingActive: trailingActive,
    };
  }

  if (trailingActive) {
    const stopPrice = peak * (1 - EXIT_TIER_2_DRAWDOWN_PCT);
    if (input.currentPrice <= stopPrice) {
      return {
        exit: { exitReason: 'trailing_stop', exitPrice: stopPrice },
        newPeakPriceSinceEntry: peak,
        newTrailingActive: trailingActive,
      };
    }
  }

  return { exit: null, newPeakPriceSinceEntry: peak, newTrailingActive: trailingActive };
}

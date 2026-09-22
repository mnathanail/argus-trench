import {
  EXIT_TIER_1_PRICE_SCALE,
  EXIT_TIER_2_ACTIVATION_SCALE,
  EXIT_TIER_2_DRAWDOWN_PCT,
  PROFIT_FLOOR_SCALE,
  STOP_LOSS_PCT,
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
  exitReason: 'tp_tier_1' | 'trailing_stop' | 'stop_loss';
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
 *
 * `stop_loss` προστέθηκε 2026-09-11, πρώτη φορά πραγματικό κεφάλαιο — ΠΑΝΤΑ ελέγχεται
 * ΠΡΩΤΟ, πριν από tier1/trailing: -50% από το entry (ΟΧΙ από peak, διαφορετικό από το
 * trailing_stop) είναι καθαρή προστασία downside, δεν πρέπει ποτέ να «χαθεί» πίσω από
 * κάποιον άλλο έλεγχο. Ισχύει ΑΣΧΕΤΑ αν το trailing έχει ήδη ενεργοποιηθεί.
 */
export function checkTick(input: TickCheckInput): TickCheckResult {
  const tier1Price = input.entryPrice * EXIT_TIER_1_PRICE_SCALE;
  const tier2ActivationPrice = input.entryPrice * EXIT_TIER_2_ACTIVATION_SCALE;
  const stopLossPrice = input.entryPrice * (1 - STOP_LOSS_PCT);

  const peak = Math.max(input.peakPriceSinceEntry ?? input.entryPrice, input.currentPrice);
  let trailingActive = input.trailingActive;

  if (input.currentPrice <= stopLossPrice) {
    // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα): πριν, καταγράφαμε ΠΑΝΤΑ το threshold
    // (stopLossPrice), ποτέ την πραγματική τιμή του tick που το πυροδότησε. Σε ένα
    // pump.fun token μια κατάρρευση συχνά προσπερνάει κατά πολύ το -50% μέχρι να φτάσει
    // το επόμενο tick (π.χ. -70%) — καταγράφοντας πάντα -50% συστηματικά υποτιμούσαμε τη
    // ζημιά κάθε stop_loss στο paper P&L. `Math.min` εδώ σημαίνει "ποτέ καλύτερα από το
    // threshold" (ο πωλητής δεν προλαβαίνει ποτέ την ακριβή στιγμή), μόνο χειρότερα ή ίσα.
    const exitPrice = Math.min(stopLossPrice, input.currentPrice);
    return {
      exit: { exitReason: 'stop_loss', exitPrice },
      newPeakPriceSinceEntry: peak,
      newTrailingActive: trailingActive,
    };
  }

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
    // ΝΕΟ 2026-09-22 — βλ. PROFIT_FLOOR_SCALE στο paperTradingConfig.ts: ο stop ΠΟΤΕ δεν
    // πέφτει κάτω από το ελάχιστο κατοχυρωμένο κέρδος, όσο χαμηλά κι αν πάει το
    // μαθηματικό peak*(1-drawdown). Με τις τρέχουσες τιμές (+50% activation, 25%
    // drawdown) αυτό είναι ήδη αδρανές (ελάχιστο δυνατό +12.5% > floor +10%) — υπάρχει
    // ρητά ως δεύτερο, ανεξάρτητο δίχτυ ασφαλείας για το ενδεχόμενο μελλοντικής αλλαγής
    // στο drawdown.
    const floorPrice = input.entryPrice * PROFIT_FLOOR_SCALE;
    const stopPrice = Math.max(peak * (1 - EXIT_TIER_2_DRAWDOWN_PCT), floorPrice);
    if (input.currentPrice <= stopPrice) {
      // Ίδια διόρθωση με το stop_loss πιο πάνω — ποτέ καλύτερα από το threshold, ποτέ
      // χειρότερα από την πραγματική παρατηρημένη τιμή.
      const exitPrice = Math.min(stopPrice, input.currentPrice);
      return {
        exit: { exitReason: 'trailing_stop', exitPrice },
        newPeakPriceSinceEntry: peak,
        newTrailingActive: trailingActive,
      };
    }
  }

  return { exit: null, newPeakPriceSinceEntry: peak, newTrailingActive: trailingActive };
}

import type { Candle } from '../gmgn/kline.js';

/**
 * 2026-10-04 (αίτημα χρήστη) — ανάλυση της ΠΟΡΕΙΑΣ τιμής κάθε paper trade και
 * προσομοίωση εναλλακτικών εξόδων πάνω σε 1m candles (ήδη αγκυρωμένα στην τιμή εισόδου
 * σε SOL, βλ. exitResolver.anchorCandlesToEntryPrice). Καθαρές συναρτήσεις — τις καλεί το
 * scripts/exit-path-analysis.ts.
 *
 * ΣΥΝΤΗΡΗΤΙΚΗ υπόθεση σε κάθε candle: δεν ξέρουμε αν μέσα στο λεπτό ήρθε πρώτα το low ή
 * το high, οπότε ελέγχουμε ΠΡΩΤΑ το low (stop) και ΜΕΤΑ το high (κέρδος). Έτσι τα
 * νούμερα δεν βγαίνουν ποτέ καλύτερα από την πραγματικότητα λόγω της ανάλυσης του 1m.
 */

export const MINUTE_MS = 60_000;
export const HORIZON_MS = 24 * 60 * MINUTE_MS;
/** Ίδιο με το σημερινό argus: trailing ενεργό στο +50%, −25% από το peak, floor +10%. */
export const TRAIL_ACTIVATION = 1.5;
export const TRAIL_DRAWDOWN = 0.25;
export const TRAIL_FLOOR = 1.1;

/** Candles μέσα στο παράθυρο [entry, entry+24h], ταξινομημένα. Το candle που περιέχει
 * την είσοδο (timestamp ≤ entry < timestamp+1m) μένει έξω: η τιμή του πριν την είσοδο
 * είναι άγνωστη, και το anchor έχει ήδη γίνει στο close του. */
export function windowCandles(candles: readonly Candle[], entryAtMs: number, horizonMs = HORIZON_MS): Candle[] {
  return candles
    .filter((c) => c.timestamp >= entryAtMs && c.timestamp < entryAtMs + horizonMs)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export interface PathStats {
  /** Μέγιστο high / entry (π.χ. 2.3 = +130%). null χωρίς candles. */
  maxMultiple: number | null;
  /** Λεπτά ως το πρώτο candle με high ≥ +50%. null αν δεν έφτασε ποτέ. */
  minutesToTrail: number | null;
  /** Βαθύτερο low / entry ΠΡΙΝ το +50% (ή σε όλο το παράθυρο αν δεν έφτασε ποτέ). */
  minBeforeTrail: number | null;
  /** close / entry στο candle που περιέχει entry+N λεπτά (null αν δεν υπάρχει candle ως τότε). */
  at: Record<number, number | null>;
}

export const CHECKPOINTS_MIN = [15, 30, 60, 120] as const;

/** Τελευταίο close στο ή πριν το t — αν το token δεν είχε trades, η τιμή μένει η τελευταία. */
function closeAt(candles: readonly Candle[], t: number): number | null {
  let last: number | null = null;
  for (const c of candles) {
    if (c.timestamp > t) break;
    last = c.close;
  }
  return last;
}

export function pathStats(candles: readonly Candle[], entryPrice: number, entryAtMs: number): PathStats {
  const at: Record<number, number | null> = {};
  if (candles.length === 0 || !(entryPrice > 0)) {
    for (const m of CHECKPOINTS_MIN) at[m] = null;
    return { maxMultiple: null, minutesToTrail: null, minBeforeTrail: null, at };
  }
  let maxHigh = 0;
  let minLow = Infinity;
  let trailAt: number | null = null;
  for (const c of candles) {
    // low πρώτα: μια βύθιση στο ίδιο λεπτό με την ενεργοποίηση μετράει ΠΡΙΝ από αυτή.
    if (trailAt === null) minLow = Math.min(minLow, c.low);
    maxHigh = Math.max(maxHigh, c.high);
    if (trailAt === null && c.high >= entryPrice * TRAIL_ACTIVATION) trailAt = c.timestamp;
  }
  const lastTs = candles.at(-1)!.timestamp;
  for (const m of CHECKPOINTS_MIN) {
    const t = entryAtMs + m * MINUTE_MS;
    // Μόνο αν τα δεδομένα φτάνουν ως εκεί, αλλιώς «άγνωστο» αντί για μια παλιά τιμή.
    const c = t <= lastTs + MINUTE_MS ? closeAt(candles, t) : null;
    at[m] = c === null ? null : c / entryPrice;
  }
  return {
    maxMultiple: maxHigh / entryPrice,
    minutesToTrail: trailAt === null ? null : Math.max(0, (trailAt - entryAtMs) / MINUTE_MS),
    minBeforeTrail: minLow === Infinity ? null : minLow / entryPrice,
    at,
  };
}

export type ExitMode =
  /** Σημερινό: όλη η θέση σε trailing (+50% ενεργοποίηση, −25% από peak, floor +10%). */
  | 'trail'
  /** Μισή πώληση στο +50%, το υπόλοιπο σε trailing. */
  | 'half_tp'
  /** 25% στο +100%, 25% στο +200%, το υπόλοιπο με stop στην τιμή εισόδου (μετά το 1ο TP). */
  | 'ladder';

export interface ExitParams {
  /** π.χ. 0.3 = stop στο −30% από την είσοδο. */
  stopPct: number;
  /** Αν σε τόσα λεπτά η θέση δεν έχει «πιάσει» (trailing/1ο TP), κλείνει. null = μόνο 24h. */
  timeLimitMin: number | null;
  mode: ExitMode;
}

export interface SimResult {
  /** Μέσος πολλαπλασιαστής εξόδου (σταθμισμένος ανά μέρος της θέσης): out / in. */
  multiple: number;
  reason: 'stop' | 'trail' | 'time_limit' | 'horizon' | 'no_data' | 'breakeven';
  /** Λεπτά ως την ΤΕΛΙΚΗ έξοδο. */
  minutes: number;
}

/**
 * Προσομοίωση εξόδου σε candles ήδη στο παράθυρο (windowCandles). Τιμές εξόδου:
 * - stop: στο όριο, ή στο open αν το candle άνοιξε ήδη κάτω από αυτό (gap).
 * - trailing: στο όριο από το ΠΡΟΗΓΟΥΜΕΝΟ peak (low πρώτα), μετά ενημέρωση peak με το high.
 * - χρονικό όριο: στο open του πρώτου candle μετά το όριο.
 * - 24h / τέλος δεδομένων: στο τελευταίο close.
 */
export function simulateExit(candles: readonly Candle[], entryPrice: number, entryAtMs: number, p: ExitParams): SimResult {
  if (candles.length === 0 || !(entryPrice > 0)) return { multiple: 1, reason: 'no_data', minutes: 0 };
  const stop = entryPrice * (1 - p.stopPct);
  let remaining = 1; // μέρος της θέσης που μένει
  let realized = 0; // άθροισμα (μέρος × πολλαπλασιαστής) όσων πουλήθηκαν
  let peak = entryPrice;
  let trailing = false; // trail/half_tp: ενεργό trailing στο υπόλοιπο
  let ladderStep = 0; // ladder: πόσα TP έχουν γίνει
  const minutes = (c: Candle) => Math.max(0, (c.timestamp - entryAtMs) / MINUTE_MS);
  const sell = (fraction: number, price: number) => {
    realized += fraction * (price / entryPrice);
    remaining -= fraction;
  };
  const done = (reason: SimResult['reason'], c: Candle, price: number): SimResult => {
    sell(remaining, price);
    return { multiple: realized, reason, minutes: minutes(c) };
  };
  const engaged = () => (p.mode === 'ladder' ? ladderStep > 0 : trailing);

  for (const c of candles) {
    // 1) χρονικό όριο: μόνο αν η θέση δεν έχει «πιάσει» ακόμα.
    if (p.timeLimitMin !== null && !engaged() && c.timestamp >= entryAtMs + p.timeLimitMin * MINUTE_MS) {
      return done('time_limit', c, c.open);
    }
    // 2) κάτω πλευρά πρώτα (συντηρητικά).
    if (p.mode === 'ladder' && ladderStep > 0) {
      if (c.low <= entryPrice) return done('breakeven', c, Math.min(entryPrice, c.open));
    } else if (trailing) {
      const trailStop = Math.max(peak * (1 - TRAIL_DRAWDOWN), entryPrice * TRAIL_FLOOR);
      if (c.low <= trailStop) return done('trail', c, Math.min(trailStop, c.open));
    } else if (c.low <= stop) {
      return done('stop', c, Math.min(stop, c.open));
    }
    // 3) πάνω πλευρά.
    peak = Math.max(peak, c.high);
    if (p.mode === 'ladder') {
      if (ladderStep === 0 && c.high >= entryPrice * 2) {
        sell(0.25, entryPrice * 2);
        ladderStep = 1;
      }
      if (ladderStep === 1 && c.high >= entryPrice * 3) {
        sell(0.25, entryPrice * 3);
        ladderStep = 2;
      }
    } else if (!trailing && c.high >= entryPrice * TRAIL_ACTIVATION) {
      trailing = true;
      if (p.mode === 'half_tp') sell(0.5, entryPrice * TRAIL_ACTIVATION);
    }
    // 4) αν μετά το νέο peak το close είναι ήδη κάτω από το trailing όριο, βγαίνουμε στο close.
    if (p.mode !== 'ladder' && trailing) {
      const trailStop = Math.max(peak * (1 - TRAIL_DRAWDOWN), entryPrice * TRAIL_FLOOR);
      if (c.close <= trailStop) return done('trail', c, c.close);
    }
  }
  const last = candles.at(-1)!;
  return done('horizon', last, last.close);
}

/** PnL σε SOL για θέση `sizeSol` με έξοδο `multiple` και συνολικό κόστος `roundTripFeesPct` επί της εισόδου. */
export function simPnlSol(multiple: number, sizeSol: number, roundTripFeesPct: number): number {
  return sizeSol * multiple - sizeSol - sizeSol * roundTripFeesPct;
}

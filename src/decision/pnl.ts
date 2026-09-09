import { PAPER_ASSUMED_FEES_PCT } from './paperTradingConfig.js';

export interface PnlResult {
  pnlPct: number;
  pnlSol: number;
  pnlNetPct: number;
}

/**
 * Μία, κοινή υλοποίηση — χρησιμοποιείται και από το periodic exit-resolver (candle-based)
 * και από το realtime exit handler (tick-based). Πριν την εξαγωγή εδώ, ο ίδιος τύπος
 * ζούσε μόνο inline μέσα στο exitResolver.ts — δύο ανεξάρτητες υλοποιήσεις του ίδιου
 * υπολογισμού θα ρίσκαραν να αποκλίνουν με τον καιρό (π.χ. κάποιος να ξεχάσει το
 * PAPER_ASSUMED_FEES_PCT στη μία από τις δύο).
 */
export function computePnl(
  entryPrice: number,
  exitPrice: number,
  bankrollAtEntry: number | null,
  intendedSizePct: number | null,
): PnlResult {
  const pnlPct = (exitPrice - entryPrice) / entryPrice;
  const pnlSol = (bankrollAtEntry ?? 0) * (intendedSizePct ?? 0) * pnlPct;
  const pnlNetPct = pnlPct - PAPER_ASSUMED_FEES_PCT;
  return { pnlPct, pnlSol, pnlNetPct };
}

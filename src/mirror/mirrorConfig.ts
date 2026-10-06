/**
 * MIRROR route (2026-09-30, ρητή απόφαση χρήστη) — ρυθμίσεις. Βλ. migration 0023 και
 * mirrorDecision.ts για τους κανόνες.
 */

/**
 * 2026-10-06, ρητή απόφαση χρήστη: «σταμάτα το /mirror, δε θέλω άλλα data για τώρα — μη
 * διαγράψεις τίποτα». Με false: καμία πηγή (PumpPortal routing, Helius, GMGN poll), κανένα
 * shadow tick/expiry, τα mirror wallets δεν γίνονται subscribe. Πίνακες, δεδομένα, κώδικας
 * και οι εντολές /mirror /unmirror /mirrors μένουν (απαντούν ότι είναι σε παύση).
 */
export const MIRROR_ENABLED = false;

/** Μόνο paper μέχρι να δούμε αποτελέσματα (ρητή απόφαση). Το live θα είναι ξεχωριστό βήμα. */
export const MIRROR_MODE = 'paper' as const;

/** Pump.fun bonding curve + PumpSwap (μετά το graduation). Οτιδήποτε άλλο αγνοείται. */
export const MIRROR_ALLOWED_POOLS: readonly string[] = ['pump', 'pump-amm'];

export const MIRROR_DEFAULT_BUY_SOL = 0.1;

/** Σταθερό ποσό ανά αγορά (κάθε αγορά του wallet = μία δική μας). Από env `MIRROR_BUY_SOL`
 * ώστε να αλλάζει χωρίς κώδικα· άκυρη/κενή τιμή → 0.1. */
export function mirrorBuySol(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MIRROR_BUY_SOL'];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : MIRROR_DEFAULT_BUY_SOL;
}

/** Πώληση ≥ 99% του υπολοίπου του wallet = πλήρης έξοδος (κλείνουμε όλη τη θέση). */
export const MIRROR_FULL_EXIT_PCT = 0.99;

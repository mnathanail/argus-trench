/**
 * Σχήμα επιβεβαιωμένο με πραγματικό call 2026-09-09 (subscribeAccountTrade, txType=buy).
 * Καμία υπόθεση εδώ δεν είναι θεωρητική — όλα τα πεδία παρατηρήθηκαν σε πραγματικό event.
 *
 * ΔΕΝ υπάρχει πεδίο timestamp — το PumpPortal δεν το στέλνει. Χρησιμοποιούμε τη δική μας
 * ώρα λήψης (το feed είναι σχεδόν στιγμιαίο, ~500-800ms πίσω από το on-chain block).
 *
 * ΔΕΝ υπάρχει έτοιμο πεδίο τιμής — υπολογίζεται από το bonding-curve state
 * (vSolInBondingCurve/vTokensInBondingCurve). Αυτό ισχύει ΜΟΝΟ όσο pool==='pump' (το
 * token είναι ακόμα στη bonding curve, δεν έχει "αποφοιτήσει" σε πραγματικό DEX) — αν
 * χρειαστεί ποτέ να το χειριστούμε post-migration, θα χρειαστεί διαφορετική φόρμουλα.
 */
export interface PumpPortalTradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;
  solAmount: number;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  pool: string;
}

/**
 * Ξεχωρίζει ένα πραγματικό trade event από τα άλλα μηνύματα που στέλνει το ίδιο
 * websocket (π.χ. `{"message":"Successfully subscribed to keys."}` — επιβεβαιωμένο
 * πραγματικό μήνυμα, το βλέπουμε σε κάθε subscribe). Επιστρέφει null αντί να πετάξει σε
 * οτιδήποτε δεν αναγνωρίζει — ένα απρόσμενο μήνυμα δεν πρέπει ποτέ να ρίξει τη σύνδεση.
 */
export function parseTradeEvent(raw: unknown): PumpPortalTradeEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.mint !== 'string' ||
    typeof obj.traderPublicKey !== 'string' ||
    (obj.txType !== 'buy' && obj.txType !== 'sell') ||
    typeof obj.tokenAmount !== 'number' ||
    typeof obj.solAmount !== 'number' ||
    typeof obj.vTokensInBondingCurve !== 'number' ||
    typeof obj.vSolInBondingCurve !== 'number' ||
    typeof obj.marketCapSol !== 'number' ||
    typeof obj.pool !== 'string' ||
    typeof obj.signature !== 'string'
  ) {
    return null;
  }

  return {
    signature: obj.signature,
    mint: obj.mint,
    traderPublicKey: obj.traderPublicKey,
    txType: obj.txType,
    tokenAmount: obj.tokenAmount,
    solAmount: obj.solAmount,
    vTokensInBondingCurve: obj.vTokensInBondingCurve,
    vSolInBondingCurve: obj.vSolInBondingCurve,
    marketCapSol: obj.marketCapSol,
    pool: obj.pool,
  };
}

/**
 * Η τρέχουσα τιμή στη bonding curve ΜΕΤΑ από αυτό το trade — null αν το token δεν είναι
 * πια σε 'pump' pool (μετακόμισε σε πραγματικό DEX, διαφορετική φόρμουλα τιμής,
 * ανεπιβεβαίωτο ακόμα πώς μοιάζει το event σε αυτή την περίπτωση).
 */
export function priceFromTradeEvent(event: PumpPortalTradeEvent): number | null {
  if (event.pool !== 'pump') return null;
  if (event.vTokensInBondingCurve <= 0) return null;
  return event.vSolInBondingCurve / event.vTokensInBondingCurve;
}

/**
 * Σχήμα επιβεβαιωμένο με πραγματικό call 2026-09-09 (subscribeAccountTrade, txType=buy).
 * Καμία υπόθεση εδώ δεν είναι θεωρητική — όλα τα πεδία παρατηρήθηκαν σε πραγματικό event.
 *
 * ΔΕΝ υπάρχει πεδίο timestamp — το PumpPortal δεν το στέλνει. Χρησιμοποιούμε τη δική μας
 * ώρα λήψης (το feed είναι σχεδόν στιγμιαίο, ~500-800ms πίσω από το on-chain block).
 *
 * ΔΕΝ υπάρχει έτοιμο πεδίο τιμής — υπολογίζεται από το bonding-curve state
 * (vSolInBondingCurve/vTokensInBondingCurve). Αυτό ισχύει ΜΟΝΟ όσο pool==='pump' (το
 * token είναι ακόμα στη bonding curve, δεν έχει "αποφοιτήσει" σε πραγματικό DEX).
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-27, πραγματικό incident: επιβεβαιώθηκε (Railway log, 657/693
 * "unrecognized" μηνύματα σε ένα μόνο παράθυρο 13 ωρών) ότι μετά το "αποφοίτημα" ενός
 * token από τη bonding curve σε πραγματικό DEX/AMM, το PumpPortal ΔΕΝ σταματά να στέλνει
 * trade events γι' αυτό — απλά παραλείπει ΕΝΤΕΛΩΣ τα 4 bonding-curve πεδία
 * (vTokensInBondingCurve/vSolInBondingCurve/marketCapSol/pool) από το payload, αντί να τα
 * στείλει με άλλες/null τιμές. Το ίδιο ακριβώς token (πραγματικό παράδειγμα:
 * BPHarSVwpav5SpxMoqb9cePBnCM1PAznBS1Srqohpump) παρατηρήθηκε να αλλάζει από το πλήρες
 * σχήμα στο μειωμένο ΜΕΣΑ στο ίδιο log, μόνιμα — απόδειξη ότι είναι δυναμικό γεγονός
 * migration, όχι στατική ιδιομορφία ανά token. Το παλιό, αυστηρό parseTradeEvent
 * απέρριπτε ΣΙΩΠΗΛΑ (null) κάθε τέτοιο event πριν καν φτάσει στο decideEntry/
 * realtimeExitHandler — δηλαδή ΚΑΝΕΝΑ trade σε ήδη αποφοιτημένο token δεν έφτανε ποτέ
 * στο pipeline μας, ό,τι κι αν έδειχνε (π.χ. ένα πραγματικό smart_money_buy). Τα 4
 * πεδία γίνονται προαιρετικά εδώ ακριβώς γι' αυτό — η απουσία τους είναι πλέον ένα
 * ΑΝΑΓΝΩΡΙΣΜΕΝΟ, όχι απορριπτέο, σχήμα. priceFromTradeEvent παρακάτω τα αντιμετωπίζει
 * ήδη σαν "δεν υπάρχει τιμή" (ίδιο μονοπάτι με pool!=='pump'), και το downstream
 * (decideEntry's no_realtime_price / isUnpriceableNonSellEvent's needs_manual_exit)
 * χειριζόταν ΗΔΗ σωστά μια τιμή null — δεν χρειάστηκε καμία αλλαγή στη λογική απόφασης,
 * μόνο εδώ στο parsing layer.
 */
export interface PumpPortalTradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: 'buy' | 'sell';
  tokenAmount: number;
  solAmount: number;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  pool?: string;
}

/**
 * Ξεχωρίζει ένα πραγματικό trade event από τα άλλα μηνύματα που στέλνει το ίδιο
 * websocket (π.χ. `{"message":"Successfully subscribed to keys."}` — επιβεβαιωμένο
 * πραγματικό μήνυμα, το βλέπουμε σε κάθε subscribe). Επιστρέφει null αντί να πετάξει σε
 * οτιδήποτε δεν αναγνωρίζει — ένα απρόσμενο μήνυμα δεν πρέπει ποτέ να ρίξει τη σύνδεση.
 *
 * Τα 4 bonding-curve πεδία (vTokensInBondingCurve/vSolInBondingCurve/marketCapSol/pool)
 * είναι ΠΡΟΑΙΡΕΤΙΚΑ — βλ. σχόλιο 2026-09-27 πάνω στο interface. Μόνο τα βασικά
 * trade-identity πεδία παραμένουν υποχρεωτικά.
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
    typeof obj.signature !== 'string'
  ) {
    return null;
  }

  // Προαιρετικά — αν υπάρχουν πρέπει να είναι σωστού τύπου, αλλά η απουσία τους δεν
  // απορρίπτει το event (βλ. σχόλιο 2026-09-27 πάνω στο interface).
  if (
    (obj.vTokensInBondingCurve !== undefined && typeof obj.vTokensInBondingCurve !== 'number') ||
    (obj.vSolInBondingCurve !== undefined && typeof obj.vSolInBondingCurve !== 'number') ||
    (obj.marketCapSol !== undefined && typeof obj.marketCapSol !== 'number') ||
    (obj.pool !== undefined && typeof obj.pool !== 'string')
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
    vTokensInBondingCurve: obj.vTokensInBondingCurve as number | undefined,
    vSolInBondingCurve: obj.vSolInBondingCurve as number | undefined,
    marketCapSol: obj.marketCapSol as number | undefined,
    pool: obj.pool as string | undefined,
  };
}

/**
 * Η τρέχουσα τιμή στη bonding curve ΜΕΤΑ από αυτό το trade — null αν το token δεν είναι
 * πια σε 'pump' pool (μετακόμισε σε πραγματικό DEX, διαφορετική φόρμουλα τιμής) Ή αν
 * λείπουν τα bonding-curve πεδία εντελώς (το ΙΔΙΟ πραγματικό σενάριο, βλ. σχόλιο
 * 2026-09-27 πάνω στο interface — και τα δύο σημαίνουν "δεν έχουμε φόρμουλα τιμής εδώ").
 */
export function priceFromTradeEvent(event: PumpPortalTradeEvent): number | null {
  if (event.pool !== 'pump') return null;
  if (event.vTokensInBondingCurve === undefined || event.vSolInBondingCurve === undefined) return null;
  if (event.vTokensInBondingCurve <= 0) return null;
  return event.vSolInBondingCurve / event.vTokensInBondingCurve;
}

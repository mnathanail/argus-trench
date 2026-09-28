/**
 * Σχήμα επιβεβαιωμένο με πραγματικό call 2026-09-09 (subscribeAccountTrade, txType=buy).
 * Καμία υπόθεση εδώ δεν είναι θεωρητική — όλα τα πεδία παρατηρήθηκαν σε πραγματικό event.
 *
 * ΔΕΝ υπάρχει πεδίο timestamp — το PumpPortal δεν το στέλνει. Χρησιμοποιούμε τη δική μας
 * ώρα λήψης (το feed είναι σχεδόν στιγμιαίο, ~500-800ms πίσω από το on-chain block).
 *
 * ΔΕΝ υπάρχει έτοιμο πεδίο τιμής — υπολογίζεται από το bonding-curve state
 * (vSolInBondingCurve/vTokensInBondingCurve) όσο pool==='pump', αλλιώς από το ίδιο το
 * trade (solAmount/tokenAmount) — βλ. priceFromTradeEvent.
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
 * ΑΝΑΓΝΩΡΙΣΜΕΝΟ, όχι απορριπτέο, σχήμα. Από 2026-09-27 (αργότερα την ίδια μέρα) το
 * priceFromTradeEvent δίνει τιμή και σε αυτά, από solAmount/tokenAmount — βλ. εκεί.
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
 * Κάτω από αυτό το ποσό SOL, ένα trade σε graduated token ΔΕΝ δίνει τιμή — dust trades
 * (π.χ. 0.000987 SOL, παρατηρημένο στα logs) έχουν fees/rounding που κάνουν το
 * solAmount/tokenAmount αναξιόπιστο, και μία τέτοια παράλογη τιμή θα μπορούσε να
 * πυροδοτήσει ψευδές stop-loss/trailing.
 */
export const MIN_SOL_FOR_TRADE_PRICE = 0.01;

/**
 * Τιμή του `source_channel` στο trigger_wallet_snapshot_json των realtime σημάτων.
 * ΠΡΟΣΟΧΗ (2026-09-28): οι τιμές αυτών των trades (entry/peak/exit) είναι σε SOL ανά
 * token — ΟΧΙ σε USD όπως οι GMGN τιμές (kline, gate snapshot). Όποιος τις συγκρίνει με
 * GMGN δεδομένα πρέπει πρώτα να τις φέρει στην ίδια μονάδα (βλ. exitResolver.ts).
 */
export const REALTIME_SOURCE_CHANNEL = 'pumpportal_websocket';

/**
 * true όταν το token έχει «αποφοιτήσει» από τη bonding curve: είτε `pool !== 'pump'`, είτε
 * λείπουν εντελώς τα bonding-curve πεδία (το πραγματικό post-graduation σχήμα, βλ.
 * σχόλιο 2026-09-27 πάνω στο interface).
 */
export function isGraduatedEvent(event: PumpPortalTradeEvent): boolean {
  return (
    event.pool !== 'pump' || event.vTokensInBondingCurve === undefined || event.vSolInBondingCurve === undefined
  );
}

/** Graduated trade κάτω από MIN_SOL_FOR_TRADE_PRICE — δεν δίνει τιμή, αλλά ΔΕΝ είναι
 * "μη τιμολογήσιμο token" (ο caller πρέπει απλά να το αγνοήσει, όχι να παγώσει trade). */
export function isDustGraduatedTrade(event: PumpPortalTradeEvent): boolean {
  return isGraduatedEvent(event) && event.solAmount < MIN_SOL_FOR_TRADE_PRICE;
}

/**
 * Η τιμή του token (SOL ανά token) σε αυτό το trade.
 *
 * - Bonding curve: τα reserves ΜΕΤΑ το trade (vSol/vTokens) — ακριβής spot τιμή.
 * - Graduated (ΑΛΛΑΓΗ 2026-09-27, ρητή απόφαση χρήστη): το PumpPortal δεν στέλνει
 *   reserves, οπότε χρησιμοποιούμε την πραγματική τιμή εκτέλεσης solAmount/tokenAmount.
 *   Ίδιες μονάδες με το bonding-curve (SOL ανά token). Η μέση τιμή εκτέλεσης ενός AMM
 *   trade βρίσκεται πάντα ανάμεσα στην τιμή πριν και μετά το trade, άρα είναι λογική
 *   εκτίμηση της τρέχουσας τιμής (+ fees). Πριν, επέστρεφε null: κανένα entry σε
 *   graduated token, και live trades των οποίων το token αποφοιτούσε πάγωναν σε
 *   needs_manual_exit ΧΩΡΙΣ καμία αυτόματη προστασία.
 *
 * null: degenerate reserves, dust graduated trade, ή μη θετικό tokenAmount.
 */
export function priceFromTradeEvent(event: PumpPortalTradeEvent): number | null {
  if (!isGraduatedEvent(event)) {
    const vTokens = event.vTokensInBondingCurve as number;
    const vSol = event.vSolInBondingCurve as number;
    if (vTokens <= 0) return null;
    return vSol / vTokens;
  }
  if (event.solAmount < MIN_SOL_FOR_TRADE_PRICE || event.tokenAmount <= 0) return null;
  return event.solAmount / event.tokenAmount;
}

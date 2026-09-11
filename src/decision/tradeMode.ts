import type { TradeMode } from '../db/types.js';

/**
 * Καθαρή, τεσταρίσιμη απόφαση — δεν αγγίζει καθόλου δίκτυο/DB. Ο caller φέρνει το
 * πραγματικό, on-chain υπόλοιπο (βλ. verify-live-balance.ts για το πώς επιβεβαιώνουμε
 * ότι διαβάζεται σωστά) και το μέγεθος της θέσης, εδώ αποφασίζουμε μόνο.
 *
 * `'live'` ΜΟΝΟ αν υπάρχει αρκετό ΔΙΑΘΕΣΙΜΟ (όχι δεσμευμένο) πραγματικό κεφάλαιο για
 * ΟΛΟΚΛΗΡΟ το μέγεθος της θέσης — ποτέ μερική εκτέλεση. Όταν όχι, πέφτουμε σε `'paper'`
 * (καταγράφουμε το σήμα σαν να ανοίξαμε trade, καμία πραγματική συναλλαγή) — έτσι
 * συνεχίζουμε να μαζεύουμε δεδομένα ακόμα κι όταν το πραγματικό κεφάλαιο έχει εξαντληθεί.
 */
export function decideTradeMode(availableLiveBalanceSol: number, positionSizeSol: number): TradeMode {
  return availableLiveBalanceSol >= positionSizeSol ? 'live' : 'paper';
}

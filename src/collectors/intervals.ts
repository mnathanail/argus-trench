/**
 * Poll intervals, Φάση 1.
 *
 * Το budget είναι 20 weight/s κοινό. Με αυτά τα intervals ο σταθερός ρυθμός είναι:
 *   discovery  6 weight / 30s  = 0.2/s
 *   activity   3 × N wallets / 60s
 *   scoring    3 × M manual   / 300s
 * Για N=20 active wallets: 1.0/s. Άφθονος χώρος κάτω από τα 20/s — ο περιορισμός θα
 * εμφανιστεί όταν μεγαλώσει η watchlist, γι' αυτό ο scheduler λογάρει το cooldown.
 */
export const DISCOVERY_INTERVAL_MS = 30_000;

/**
 * Πιο αργό από το discovery επίτηδες: τα trades ενός wallet δεν εξαφανίζονται, ενώ ένα
 * νέο token μπορεί να περάσει από `near_completion` γρήγορα. Χάνουμε λίγο latency στο
 * trigger — ανεκτό στη Φάση 1, που δεν εκτελεί.
 */
export const WALLET_ACTIVITY_INTERVAL_MS = 60_000;

/** «Κάθε κύκλο» για τα manual wallets — αλλά όχι τόσο πυκνά που να τρώει το budget. */
export const MANUAL_SCORING_INTERVAL_MS = 300_000;

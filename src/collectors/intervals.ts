/**
 * Poll intervals, Φάση 1.
 *
 * Το budget είναι 20 weight/s κοινό. Με αυτά τα intervals ο σταθερός ρυθμός είναι:
 *   discovery  6 weight / 30s        = 0.2/s
 *   activity   3 × N active wallets  / 60s
 *   scoring    3 × N active wallets  / 300s
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

/**
 * Retry backoff για το wallet-activity — πιο ήπιο cap από το wallet-discovery (10min
 * αντί για 30min) γιατί αυτό εδώ είναι latency-sensitive: ένα trigger που καθυστερεί
 * ώρες χάνει την αξία του. Χωρίς ΚΑΝΕΝΑ backoff όμως, ένας γεμάτος κύκλος στο ίδιο 60s
 * ξαναχτυπά την ίδια συμφόρηση επ' αόριστον χωρίς ποτέ να πάρει ανάσα — παρατηρήθηκε
 * 8 συνεχόμενες αποτυχίες σε production πριν προστεθεί αυτό.
 */
export const WALLET_ACTIVITY_RETRY_BACKOFF_MS = [
  60_000, // 1η αποτυχία — ίδιο με πριν, μπορεί να ήταν παροδικό
  2 * 60_000, // 2η
  5 * 60_000, // 3η
  10 * 60_000, // 4η και κάθε επόμενη
] as const;

/**
 * Re-scoring για ΟΛΑ τα active wallets (κάθε source) — βλ. `collectors/scoring.ts`.
 * Όχι τόσο πυκνά που να τρώει το budget με N wallets × weight 3.
 */
export const WALLET_SCORING_INTERVAL_MS = 300_000;

/**
 * Σκόπιμη παύση ανάμεσα σε διαδοχικά per-item GMGN calls μέσα στον ΙΔΙΟ κύκλο ενός
 * loop — βλ. `util/delay.ts` για το πλήρες σκεπτικό/evidence. 300ms σκορπίζει μια ριπή
 * 6 κλήσεων σε ~1.8s αντί για σχεδόν ταυτόχρονα.
 */
export const WALLET_LOOP_PACING_MS = 300;

/**
 * Bootstrap/auto-discovery για νέα `source='smart_money'` wallets — βλ.
 * `collectors/walletDiscovery.ts`. Weekly επίτηδες, ΞΕΧΩΡΙΣΤΟ και πολύ πιο αργό από το
 * per-cycle re-scoring πιο πάνω: αυτό εδώ ψάχνει ΝΕΑ candidate wallets (holders weight 5
 * × ~25 tokens + stats weight 3 × N candidates — δεκάδες weight ανά run), το scoring
 * ξανα-μετρά ό,τι ΗΔΗ ξέρουμε (weight 3 ανά ήδη-active wallet). Ίδιος shared rate
 * limiter με όλα τα υπόλοιπα loops — δεν χρειάζεται δικό του budget reservation.
 *
 * ΣΗΜΕΙΩΣΗ: ο scheduler τρέχει κάθε loop ΜΙΑ φορά αμέσως στο ξεκίνημα (πριν τον πρώτο
 * interval sleep) — άρα κάθε restart του process (π.χ. Railway redeploy) προκαλεί ένα
 * άμεσο discovery pass, όχι μετά από μία εβδομάδα. Ίδιο υπάρχον pattern με τα άλλα
 * loops· εδώ είναι πιο αισθητό λόγω του μεγαλύτερου one-shot κόστους.
 */
export const WALLET_DISCOVERY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Retry backoff για το wallet-discovery μετά από αποτυχία (π.χ. rate limit πριν
 * ολοκληρωθεί ένας πλήρης κύκλος) — αυξανόμενο αντί για σταθερό 60s, ώστε ένα δομικά
 * ακριβό run που δεν προλαβαίνει να χωρέσει στο shared budget να μη ξαναχτυπάει τον
 * ίδιο τοίχο κάθε λεπτό επ' αόριστον. Reset στο μηδέν μόλις πετύχει έστω ένας πλήρης
 * κύκλος — βλ. `scheduler.ts`.
 */
export const WALLET_DISCOVERY_RETRY_BACKOFF_MS = [
  60_000, // 1η αποτυχία
  5 * 60_000, // 2η
  15 * 60_000, // 3η
  30 * 60_000, // 4η και κάθε επόμενη
] as const;

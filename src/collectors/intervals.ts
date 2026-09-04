/**
 * Poll intervals, Φάση 1.
 *
 * Το budget είναι 20 weight/s κοινό. Με αυτά τα intervals ο σταθερός ρυθμός είναι:
 *   discovery  6 weight / 30s        = 0.2/s
 *   activity   3 × 4 wallets        / 60s (round-robin, όχι όλο το watchlist)
 *   scoring    3 × N active wallets  / 300s
 * Για N=20 active wallets: 1.0/s. Άφθονος χώρος κάτω από τα 20/s — ο περιορισμός θα
 * εμφανιστεί όταν μεγαλώσει η watchlist, γι' αυτό ο scheduler λογάρει το cooldown.
 */
export const DISCOVERY_INTERVAL_MS = 120_000;
export const DISCOVERY_REQUEST_PACING_MS = 1_000;
export const DISCOVERY_INITIAL_DELAY_MS = 0;

export const DISCOVERY_RETRY_BACKOFF_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
] as const;

/**
 * Πιο αργό από το discovery επίτηδες: τα trades ενός wallet δεν εξαφανίζονται, ενώ ένα
 * νέο token μπορεί να περάσει από `near_completion` γρήγορα. Χάνουμε λίγο latency στο
 * trigger — ανεκτό στη Φάση 1, που δεν εκτελεί.
 */
export const WALLET_ACTIVITY_INTERVAL_MS = 60_000;
export const WALLET_ACTIVITY_LOOP_PACING_MS = 1_000;
/** Περιορίζει το burst· όλο το watchlist περνάει κυκλικά σε διαδοχικά ticks. */
export const WALLET_ACTIVITY_WALLETS_PER_CYCLE = 2;
/**
 * 50 → 200 (2026-09-04): σκόπιμη προτεραιότητα φάσης — τώρα θέλουμε ΟΓΚΟ σημάτων για να
 * επιβεβαιώσουμε ότι πιάνουμε σωστά σήματα, όχι throughput κλεισίματος. Trade-off ρητό:
 * δεν αλλάζει καθόλου πόσο γρήγορα κλείνει το exit-resolver (παραμένει η ίδια, αργή
 * ουρά όσο διαρκεί το ξεχωριστό GMGN rate-limit ζήτημα) — απλά επιτρέπει να συσσωρευτεί
 * μεγαλύτερο backlog ανοιχτών trades αντί να μπλοκάρει εντελώς νέα signals στο 50.
 */
export const WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE = 200;
export const WALLET_ACTIVITY_INITIAL_DELAY_MS = 5_000;

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
export const WALLET_SCORING_LOOP_PACING_MS = 1_000;
export const WALLET_SCORING_INITIAL_DELAY_MS = 15_000;
export const WALLET_SCORING_RETRY_BACKOFF_MS = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
] as const;

/**
/**
 * Exit-resolver για paper_trades (log_only, Φάση 1). Τραβάμε ΠΛΗΡΕΣ price history
 * (market kline) από entry μέχρι τώρα, όχι μόνο τρέχουσα τιμή — άρα η συχνότητα δεν
 * επηρεάζει ΠΟΤΕ/ΣΕ ΤΙ ΤΙΜΗ χτυπήθηκε ένα tier, μόνο πόσο γρήγορα το μαθαίνουμε.
 *
 * ⚠️ 60 λεπτά → 15 λεπτά (2026-09-01, real incident): με throughput
 * EXIT_RESOLVER_TRADES_PER_CYCLE/ώρα, ένα burst νέων signals (πραγματικό παράδειγμα: 34
 * μέσα σε 2 λεπτά) δημιουργεί ουρά που δεν αδειάζει ποτέ — τα παλαιότερα trades είναι
 * πάντα πρώτα στη σειρά (`listOpenTrades` ORDER BY entry_at) και δεν "φεύγουν" μέχρι να
 * κλείσουν, άρα νεότερα trades μπορεί να μην ελεγχθούν ΟΥΤΕ ΜΙΑ φορά για ώρες. 4×
 * συχνότερο, ΙΔΙΟ batch size (αποδεδειγμένα ασφαλές στο rate limit, 5/5 καθαροί κύκλοι)
 * — προτιμότερο από μεγαλύτερο batch, που θα μεγάλωνε το μέγεθος κάθε burst αντί απλά
 * να το επαναλαμβάνει συχνότερα.
 */
export const EXIT_RESOLVER_INTERVAL_MS = 15 * 60 * 1000;
export const EXIT_RESOLVER_LOOP_PACING_MS = 1_000;
export const EXIT_RESOLVER_INITIAL_DELAY_MS = 45_000;
export const EXIT_RESOLVER_RETRY_BACKOFF_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
] as const;

/**
 * Πόσα ανοιχτά trades ελέγχει το exit-resolver ανά κύκλο — τα λιγότερο πρόσφατα
 * ελεγμένα πρώτα (`selectOpenTradesForCheck`, migration 0006 — rotation, όχι
 * `entry_at`), όχι όλα μαζί.
 *
 * Επιβεβαιωμένο real incident 2026-09-01: με 14-40+ ταυτόχρονα ανοιχτά trades, κάθε ένα
 * μέχρι `EXIT_RESOLVER_MAX_SELL_PAGES` σελίδες στο `/v1/user/wallet_activity`, το
 * σύνολο ήταν αρκετό να κρατήσει το endpoint σε συνεχές 429 για 8+ ώρες — και το ίδιο
 * endpoint χρησιμοποιεί ΚΑΙ το wallet-activity, άρα το πρόβλημα δεν έμενε τοπικό στο
 * exit-resolver. Batching εδώ, ίδιο σκεπτικό με το `WALLET_ACTIVITY_WALLETS_PER_CYCLE`.
 *
 * ⚠️ 10 → 3 (2026-09-04, real incident): ακόμα και με batching, 12 συνεχόμενες
 * αποτυχίες σε 10 ώρες — ΠΟΤΕ ένα καθαρό "closed=X" σε ολόκληρο το διάστημα. Αιτία:
 * όταν ο κύκλος χτυπάει 429 στο 1ο-2ο trade (rethrowIfRateLimited σταματά ΟΛΟΚΛΗΡΟ τον
 * κύκλο), τα υπόλοιπα 8-9 trades του batch μένουν εντελώς ανέγγιχτα — ένα μεγάλο batch
 * σπάνια ολοκληρώνεται, άρα trades στο τέλος του batch ουσιαστικά δεν ελέγχονται ποτέ.
 * Μικρότερο batch = πιο συχνά ολοκληρωμένοι κύκλοι, ακόμα κι αν κάθε ένας κάνει
 * λιγότερη δουλειά — προτιμότερο από ένα batch που σχεδόν ποτέ δεν τελειώνει.
 * Πείραμα, όχι αποδεδειγμένη λύση — παρακολούθησε αν επιτέλους εμφανίζεται
 * "[exit-resolver] ... closed=" στα logs.
 */
export const EXIT_RESOLVER_TRADES_PER_CYCLE = 3;

/**
 * Ξεχωριστό, πιο αργό pacing ΜΟΝΟ για το wallet-discovery holders/stats loop.
 * Επιβεβαιωμένο (2026-08-28, 2ωρο log): με το κοινό 300ms, wallet-activity/scoring
 * (weight 3/call) έγιναν 100%/98% υγιή, αλλά το wallet-discovery (weight 5/call στο
 * holders — `token_top_holders`) συνέχισε 100% αποτυχία, 9 φορές στη σειρά, πάντα στο
 * ίδιο endpoint, RATE_LIMIT_EXCEEDED. Υπόθεση: το όριο είναι πιο αυστηρό ανά
 * weight/δευτερόλεπτο, όχι μόνο ανά αίτημα — το ίδιο 300ms στέλνει περισσότερο βάρος/s
 * σε weight-5 calls απ' ό,τι σε weight-3. Το wallet-discovery είναι weekly/background,
 * ΟΧΙ latency-sensitive — μηδενικό κόστος να είναι πολύ πιο αργό.
 */
export const WALLET_DISCOVERY_LOOP_PACING_MS = 1_500;

/**
 * Bootstrap/auto-discovery για νέα `source='smart_money'` wallets — βλ.
 * `collectors/walletDiscovery.ts`. ΞΕΧΩΡΙΣΤΟ και πιο αργό από το per-cycle re-scoring
 * πιο πάνω: αυτό εδώ ψάχνει ΝΕΑ candidate wallets (holders weight 5 × ~10 tokens +
 * stats weight 3 × N candidates — 100-150+ weight ανά run), το scoring ξανα-μετρά ό,τι
 * ΗΔΗ ξέρουμε (weight 3 ανά ήδη-active wallet). Ίδιος shared rate limiter με όλα τα
 * υπόλοιπα loops — δεν χρειάζεται δικό του budget reservation.
 *
 * Ωριαίο, ΟΧΙ weekly (άλλαξε 2026-08-28, δοκιμαστικά — αρχικό σχέδιο ήταν weekly, πριν
 * φτιαχτεί το `WALLET_DISCOVERY_LOOP_PACING_MS`). Ο αρχικός λόγος για weekly ήταν το
 * burst-cost ανά κύκλο, όχι ο μέσος όρος: σε ωριαία βάση, 100-150 weight/h ≈ 0.03/s —
 * αμελητέο πάνω σε shared budget 20/s. Το πραγματικό ρίσκο ήταν πάντα το burst μέσα σε
 * λίγα δευτερόλεπτα, που ήδη διορθώθηκε με το pacing. "Ωριαίο" ΔΕΝ σημαίνει back-to-back
 * χωρίς κενό — κράτα το κενό, αλλιώς ανταγωνίζεται μόνιμα τα latency-sensitive
 * activity/scoring loops.
 *
 * ΣΗΜΕΙΩΣΗ: ο scheduler τρέχει κάθε loop ΜΙΑ φορά αμέσως στο ξεκίνημα (πριν τον πρώτο
 * interval sleep) — άρα κάθε restart του process (π.χ. Railway redeploy) προκαλεί ένα
 * άμεσο discovery pass, πέρα από το κανονικό ωριαίο interval.
 */
export const WALLET_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;
export const WALLET_DISCOVERY_INITIAL_DELAY_MS = 30_000;

/**
 * Retry policy για το wallet-discovery μετά από αποτυχία: καμία δεύτερη προσπάθεια μέσα
 * στο ίδιο hourly window, ώστε ένα rate limit να μη συναγωνίζεται τα latency-sensitive
 * loops. Η επόμενη προσπάθεια γίνεται μετά από μία ώρα.
 */
export const WALLET_DISCOVERY_RETRY_BACKOFF_MS = [
  60 * 60 * 1000, // Κάθε αποτυχία — επόμενη προσπάθεια στο επόμενο hourly window
] as const;

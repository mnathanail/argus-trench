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
 * 50 → 200 (2026-09-04) → 800 (2026-09-10): με την είσοδο πλέον δουλειά του realtime
 * websocket (όχι πια GMGN polling μέσω wallet-activity.ts, αφαιρέθηκε από τα
 * προγραμματισμένα loops — παραμένει στον κώδικα σαν fallback), αυτό το όριο δεν
 * προστατεύει πια από GMGN rate limits· είναι απλά ένα γενικό ανώτατο όριο συνολικού
 * ανοιχτού exposure. Σε paper trading, χωρίς πραγματικό κεφάλαιο σε κίνδυνο, δεν έχει
 * νόημα να μπλοκάρει τόσο νωρίς — ανεβαίνει σημαντικά ώστε να μη χαθεί κανένα σήμα ενώ
 * το periodic exit-resolver αδειάζει το (ξεχωριστό, ακόμα GMGN-based) backlog timeouts.
 */
export const WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE = 800;
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
 *
 * 5min → 15min (2026-09-13): φάση δοκιμών του live trading — αυτό ήταν ο μεγαλύτερος
 * καταναλωτής rate-limit budget στο project (weight 3 ΑΝΑ wallet, ΧΩΡΙΣ batch — με 108
 * ενεργά wallets, ~324 weight κάθε κύκλο). Repeated 429 από αυτό το loop συνέβαλε σε
 * μηδενισμό του κοινού bucket ακριβώς τη στιγμή που δοκιμάζαμε το πρώτο πραγματικό
 * swap. Τα scores δεν αλλάζουν αρκετά μέσα σε λίγα λεπτά ώστε να δικαιολογούν τόσο
 * συχνό re-scoring — 15 λεπτά αφήνει αρκετό, αδιάκοπο χρόνο στο bucket να ανακάμψει.
 */
export const WALLET_SCORING_INTERVAL_MS = 900_000;
export const WALLET_SCORING_LOOP_PACING_MS = 1_000;
export const WALLET_SCORING_INITIAL_DELAY_MS = 15_000;
export const WALLET_SCORING_RETRY_BACKOFF_MS = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
] as const;
/**
 * ΝΕΟ 2026-09-22 — real incident: η watchlist έφτασε 186 wallets (155 active + 31
 * below_threshold), δηλαδή 558 weight ΣΕ ΕΝΑΝ κύκλο (weight 3/wallet, `portfolio
 * stats`) — πάνω από 20× το leaky-bucket budget (rate=20/capacity=20) ΑΚΟΜΑ ΚΙ ΧΩΡΙΣ
 * κανένα άλλο loop να τρέχει ταυτόχρονα, προκαλώντας επαναλαμβανόμενο
 * RATE_LIMIT_BANNED σε πολλαπλά, άσχετα loops (κάθε νέο αίτημα μέσα στο ήδη ενεργό ban
 * το επεκτείνει κατά 5-60s). Cap + rotation (βλ. `listWalletsForScoring`) αντί για
 * "όλα κάθε φορά" — 40 wallets/κύκλο σε interval 900s σημαίνει ρυθμό ~1 πλήρους
 * ανανέωσης κάθε ~56 λεπτά με τη σημερινή watchlist, αποδεκτό αφού τα scores δεν
 * αλλάζουν αρκετά μέσα σε λίγα λεπτά ώστε να χρειάζονται συχνότερο (ίδιο σκεπτικό με
 * το 2026-09-13 interval bump πιο πάνω). Ρύθμισε ΠΡΟΣ ΤΑ ΚΑΤΩ αν η watchlist ξαναμεγαλώσει
 * σημαντικά — 40×3=120 weight/κύκλο παραμένει μέσα στο budget ΑΚΟΜΑ ΚΙ ΑΝ ένα άλλο loop
 * τρέξει στο ίδιο δευτερόλεπτο.
 */
export const WALLET_SCORING_WALLETS_PER_CYCLE = 40;

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

/**
 * `track smartmoney` collector (2026-09-20, `collectors/gmgnSmartMoney.ts`) — δεύτερο,
 * ανεξάρτητο trigger-κανάλι πλάι στο layer 3, βλ. σχόλιο εκεί για το πλήρες σκεπτικό.
 *
 * Weight 1 ΣΥΝΟΛΙΚΑ ανά κύκλο για το ίδιο το `track smartmoney` call (όχι ανά wallet,
 * σε αντίθεση με WALLET_ACTIVITY, weight 3/wallet) — 30s: αρκετά συχνό ώστε ένα φρέσκο
 * smartmoney buy να μην περιμένει πολύ πριν ελεγχθεί το gate.
 *
 * ⚠️ ΔΙΟΡΘΩΣΗ 2026-09-23 (real incident, ΙΔΙΑ ΜΕΡΑ με ένα ήδη διορθωμένο rate-limit
 * incident στο wallet-scoring): το πιο πάνω "weight 1 ΣΥΝΟΛΙΚΑ" ΔΕΝ μετρούσε το
 * holder-risk enrichment (`token holders`, weight 5/token) που προστέθηκε ΑΡΓΟΤΕΡΑ
 * (2026-09-22, βλ. gmgnSmartMoney.ts) — ένα ξεχωριστό, πολύ πιο ακριβό call ΑΝΑ φρέσκο
 * trade μέσα στον ΙΔΙΟ κύκλο, χωρίς κανένα `delay()` ανάμεσα σε διαδοχικά calls (σε
 * αντίθεση με WALLET_SCORING_LOOP_PACING_MS/WALLET_ACTIVITY_LOOP_PACING_MS που ήδη
 * υπήρχαν αλλού ακριβώς γι' αυτό το φαινόμενο). Παρατηρήθηκαν κύκλοι με `new=45`
 * φρέσκα trades — δηλαδή έως 45 διαδοχικά weight-5 calls (225 weight) μέσα σε ένα μόνο
 * 30s tick, χωρίς παύση. Πολλαπλά, άσχετα routes (`token_top_holders`,
 * `user/smartmoney`, `user/info`) έπαιρναν `RATE_LIMIT_BANNED` σχεδόν ταυτόχρονα —
 * συνεπές με burst-πίεση σε αυτό το σημείο, όχι με υπέρβαση του μέσου weight budget.
 * Fix: `GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS` πιο κάτω, ίδιο pattern με τα άλλα loops.
 *
 * ⚠️ ΣΥΝΕΧΕΙΑ 2026-09-23 — το pacing ΜΟΝΟ ΔΕΝ αρκούσε: logs ~1 ώρα ΜΕΤΑ το deploy του
 * pacing fix έδειξαν το ΙΔΙΟ πρόβλημα να συνεχίζεται (`RATE_LIMIT_BANNED` σε
 * wallet-scoring στο `user/wallet_stats`, discovery στο `/v1/trenches`, ΚΑΙ πάλι σε
 * gmgn-smartmoney) — παρότι το wallet-scoring fix από την προηγούμενη μέρα (βλ.
 * `WALLET_SCORING_WALLETS_PER_CYCLE`) δουλεύει σωστά μόνο του (`scored=40 failures=0`).
 * Ρίζα: το pacing σκορπάει τα calls ΜΕΣΑ στον χρόνο αλλά ΔΕΝ μειώνει το ΣΥΝΟΛΙΚΟ weight
 * που ζητάει ένας κύκλος — με `new=44-50` φρέσκα trades παρατηρημένα ΑΚΟΜΑ ΚΑΙ μετά το
 * pacing fix, ένας μόνο κύκλος μπορεί να ζητήσει έως 250 weight (50×5) από τον
 * **shared, process-wide** `TokenBucket` (βλ. `gmgn/exec.ts` — ΕΝΑ instance, capacity 20,
 * για ΟΛΑ τα routes/loops μαζί), δηλαδή >12x τη χωρητικότητά του. Even paced στο 1
 * call/s, αυτό είναι ένα ~50s backlog που καβαλάει το επόμενο 30s tick (νέα φρέσκα trades
 * προστίθενται πάνω σε ήδη-εκκρεμές backlog) — ο bucket μένει σχεδόν άδειος σχεδόν
 * μόνιμα. Το `TokenBucket.block()` (καλείται σε ΚΑΘΕ 429, `gmgn/exec.ts`) μηδενίζει τα
 * tokens ΚΑΙ ενεργοποιεί `RECOVERY_REFILL_PER_SECOND=1` (αντί για 20/s) για 60s ΜΕΤΑ —
 * ΚΑΘΟΛΙΚΑ, για ΟΛΑ τα routes, όχι μόνο για το route που έπιασε το 429. Όσο το
 * gmgn-smartmoney backlog παραμένει μεγάλο, μονοπωλεί την trickle-ροή του recovery
 * window (η ουρά του `TokenBucket` είναι FIFO με ίδιο priority=0 default — βλ.
 * `rateLimiter.ts` — άρα δεν υπάρχει fair-share ανάμεσα σε loops), αφήνοντας
 * wallet-scoring/discovery (πολύ πιο μικρό, ήδη λελογισμένο weight ανά κύκλο) να
 * λιμοκτονούν και ΑΥΤΑ να πέφτουν σε 429 — εξηγεί γιατί ΗΔΗ διορθωμένα loops
 * ξαναχτυπήθηκαν από ΕΝΑ πρόβλημα αλλού. Fix: `GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE`
 * πιο κάτω — bound στο ΣΥΝΟΛΙΚΟ αριθμό holder-risk κλήσεων ανά κύκλο, ίδιο pattern με
 * `WALLET_SCORING_WALLETS_PER_CYCLE`. Τα trades πέρα από το cap καταγράφονται κανονικά
 * (`recordSignal` ΔΕΝ σταματάει) με `holder_risk_checked: false` — ίδια φιλοσοφία
 * "απουσία στοιχείων δεν είναι απόδειξη κινδύνου" με το ήδη υπάρχον rate-limit skip.
 */
export const GMGN_SMARTMONEY_INTERVAL_MS = 30_000;
export const GMGN_SMARTMONEY_INITIAL_DELAY_MS = 10_000;
export const GMGN_SMARTMONEY_RETRY_BACKOFF_MS = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
] as const;
/** Παύση ανάμεσα σε διαδοχικά holder-risk (`token holders`, weight 5) calls μέσα στο
 * ίδιο fresh-trades loop — βλ. σχόλιο πιο πάνω. Ίδια τιμή με τα υπόλοιπα per-item loops. */
export const GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS = 1_000;
/**
 * Μέγιστος αριθμός holder-risk (`token holders`, weight 5) ελέγχων ΑΝΑ κύκλο — βλ. σχόλιο
 * "ΣΥΝΕΧΕΙΑ 2026-09-23" πιο πάνω. 12 × 5 = 60 weight/κύκλο μέγιστο, δηλαδή έως ~20s
 * pacing-delay στη χειρότερη περίπτωση (12 × 1s + ίδιο το fetch round-trip) — μένει ΚΑΤΩ
 * από το 30s `GMGN_SMARTMONEY_INTERVAL_MS` ώστε οι κύκλοι να ΜΗΝ αλληλεπικαλύπτονται, ΚΑΙ
 * αφήνει αρκετό headroom στον shared 20/s bucket για τα υπόλοιπα loops (wallet-scoring,
 * discovery, walletActivity) να μη λιμοκτονούν κατά τη διάρκεια ενός recovery window. Τα
 * trades πέρα από το cap παίρνουν `holder_risk_checked: false` (ίδιο με ένα rate-limit
 * skip) — ΔΕΝ αποκλείονται, απλά δεν εμπλουτίζονται· `recordSignal` προχωράει κανονικά.
 * Rotation δεν χρειάζεται εδώ (σε αντίθεση με το wallet-scoring cap): δεν υπάρχει
 * "σειρά προτεραιότητας" ανάμεσα σε φρέσκα trades μέσα στον ίδιο κύκλο — παίρνουμε τα
 * πρώτα N με τη σειρά που έφτασαν, τα υπόλοιπα απλά καταγράφονται χωρίς εμπλουτισμό.
 */
export const GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE = 12;

/**
 * Ημερήσια αναφορά στο Telegram — μία φορά κάθε 24 ώρες. Η ΩΡΑ (00:05 τοπική ώρα
 * Αθήνας) υπολογίζεται στο main.ts μέσω `msUntilNextAthensTime`, όχι εδώ — χρειάζεται
 * το πραγματικό "τώρα" τη στιγμή του process start, το οποίο δεν το ξέρει ένα module με
 * σταθερές. Δεν αγγίζει κανένα GMGN endpoint — καθαρά δικά μας δεδομένα, δε χρειάζεται
 * retryBackoff/rate-limit πρόνοια σαν τα υπόλοιπα loops.
 */
export const DAILY_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Live strategy reconciler (2026-09-17, incident #1193 — βλ. migration 0013) — περιοδικά
 * ελέγχει τα ελάχιστα, ήδη ανοιχτά `mode='live'` trades με ενεργό native GMGN order
 * (`order strategy list`, weight 1/trade). Δεν χτίζει καν το candidate set από τίποτα
 * βαρύ — μόνο τα λίγα (Φάση 4: 1-2 concurrent cap) trades που έχουν
 * `native_order_active=true`. Αρκετά συχνό ώστε ένα πραγματικό close να ανιχνευτεί
 * γρήγορα (επηρεάζει kill-switch/reserved-capital ελευθέρωση), αλλά ΟΧΙ tick-rate — αυτό
 * είναι watchdog πάνω σε ΑΣΦΑΛΕΙΑ, όχι στο πρωτεύον exit mechanism: ο δικός μας tracker
 * (realtimeExitHandler.ts) παραμένει ο πρωτεύων decision engine ακόμα κι όσο ένα native
 * order είναι συνδεδεμένο (ρητή απόφαση χρήστη 2026-09-17, ίδια μέρα, βλ. σχόλιο εκεί) —
 * το native order υπάρχει μόνο για την περίπτωση που το δικό μας process/feed πέσει.
 */
export const LIVE_STRATEGY_RECONCILER_INTERVAL_MS = 2 * 60 * 1000;
export const LIVE_STRATEGY_RECONCILER_LOOP_PACING_MS = 500;
export const LIVE_STRATEGY_RECONCILER_INITIAL_DELAY_MS = 20_000;
export const LIVE_STRATEGY_RECONCILER_RETRY_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
] as const;

/**
 * Live trade watchdog (2026-09-17, incident #1193 — δεύτερο, ανεξάρτητο fix της ίδιας
 * μέρας). Ο `liveStrategyReconciler` πιο πάνω καλύπτει ΜΟΝΟ trades με ενεργό native GMGN
 * order· ένα live trade ΧΩΡΙΣ ενεργό native order (π.χ. αν το `attachLiveNativeOrder`
 * απέτυχε στο entry, ή αν το reconciler το απενεργοποίησε ήδη ως fallback) δεν είχε
 * ΚΑΝΕΝΑ περιοδικό safety net — μόνο το realtime websocket path, που δεν έχει ακόμα
 * heartbeat/staleness ανίχνευση (pumpportalConnection.ts). Αν το feed «παγώσει» σιωπηλά
 * (χωρίς formal 'close' event), μια πραγματική θέση θα έμενε ανοιχτή on-chain, εντελώς
 * εκτός παρακολούθησης, επ' αόριστον.
 *
 * Αυτό το collector διαβάζει το ΠΡΑΓΜΑΤΙΚΟ on-chain token balance (`portfolio
 * token-balance`, weight 1/trade — το φθηνότερο διαθέσιμο route) για ΚΑΘΕ ανοιχτό
 * `mode='live'` trade, ΑΝΕΞΑΡΤΗΤΑ από native_order_active. ΠΟΤΕ δεν υπολογίζει/γράφει
 * simulated pnl (αυτό ήταν ακριβώς το bug του #1193) — μόνο σημαδεύει
 * `needs_manual_exit` όταν βρει balance=0 χωρίς ποτέ να έχει καταγραφεί πραγματική
 * πώληση, ώστε άνθρωπος να το κλείσει χειροκίνητα με τα πραγματικά νούμερα.
 *
 * Interval πιο αραιό από τον reconciler (5 λεπτά αντί 2) — αυτό είναι τρίτο, εφεδρικό
 * δίχτυ ασφαλείας (websocket πρωτεύον, native order δεύτερο, αυτό τρίτο), όχι κύριο
 * exit mechanism, και το `portfolio token-balance` κόστος μεγαλώνει γραμμικά με τον
 * αριθμό ανοιχτών live trades — δεν έχει νόημα να «τρέχει» πιο συχνά από όσο μπορεί να
 * ανιχνεύσει ένα πραγματικό stuck-feed πρόβλημα.
 */
export const LIVE_TRADE_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
export const LIVE_TRADE_WATCHDOG_LOOP_PACING_MS = 500;
export const LIVE_TRADE_WATCHDOG_INITIAL_DELAY_MS = 30_000;
export const LIVE_TRADE_WATCHDOG_RETRY_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
] as const;


/**
 * Φάση 1 log-only paper trading (CLAUDE.md: mode='log_only' είναι ήδη μέρος της Φάσης 1,
 * όχι Φάση 3) — σταθερές που χρειάζεται το entry/exit simulation.
 */

/**
 * Placeholder bankroll σε SOL για το log_only sizing. Δεν επηρεάζει τίποτα πραγματικό
 * (καμία συναλλαγή γίνεται) — απλά κάνει το `intended_size_pct` (1%, ήδη επιβεβαιωμένο)
 * να μεταφράζεται σε απόλυτο ποσό, ώστε το `assumed_slippage_pct` να έχει νόημα σε σχέση
 * με το μέγεθος της pool liquidity. Άλλαξέ το όποτε υπάρχει πραγματικός αριθμός.
 */
export const PAPER_BANKROLL_SOL = 10;

export const PAPER_POSITION_SIZE_PCT = 0.01;

export const PAPER_ASSUMED_SLIPPAGE_PCT = 0.03;
export const PAPER_ASSUMED_LATENCY_MS = 3_000;

/**
 * ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #5): ανέβηκε από 1% σε 2%. Το 1% δεν κάλυπτε καν το
 * pump.fun's δικό του ~1% ανά πλευρά (είσοδος+έξοδος οπότε ~2% μόνο απ' αυτό), πόσο
 * μάλλον το GMGN routing fee, το `--auto-slippage` και τα priority/tip fees στο swap.ts.
 * Σε μια μικρή θέση (π.χ. 0.05 SOL) τα fixed κόστη (tip/priority) είναι ένα σημαντικό
 * ποσοστό. Το 2% παραμένει συντηρητική εκτίμηση, ΟΧΙ μετρημένο νούμερο — δεν υπάρχει
 * ακόμα αρκετό δείγμα κλεισμένων live trades ώστε να παραχθεί αξιόπιστα ένα πραγματικό
 * round-trip fee από `actual_entry_amount_sol` έναντι του ονομαστικού μεγέθους θέσης.
 * Να αναθεωρηθεί όταν υπάρχουν αρκετά live δεδομένα.
 */
/** ΑΛΛΑΓΗ 2026-10-04, ρητή απόφαση χρήστη: 2% → 4.5% = πραγματικό κόστος ανά γύρο
 * (pump.fun 1.25% × 2 + GMGN 1% × 2), ώστε το paper να δείχνει ό,τι θα δείξει το live. */
export const PAPER_ASSUMED_FEES_PCT = 0.045;

/**
 * Exit plan, ίδιο με το `condition_orders_json` που αποθηκεύεται στο entry — δύο
 * μηχανισμοί μαζί (CLAUDE.md, layer "Exit decision"):
 *   - Tier 1: fixed take-profit στο +50%, πουλάει το μισό (ΜΟΝΟ στο `conditionOrdersJson()`
 *     paper-only scale-out plan πιο κάτω — ΠΟΤΕ πραγματικά εκτελεσμένο έτσι στο checkTick/
 *     resolveExit, εκεί το tier1 πάντα έκλεινε ΟΛΟΚΛΗΡΗ τη θέση, βλ. σχόλιο 2026-09-22
 *     στο EXIT_TIER_2_ACTIVATION_SCALE πιο κάτω).
 *   - Tier 2: trailing. **ΑΛΛΑΓΗ 2026-09-22**: ενεργοποιείται πλέον στο +50% (ήταν +100%),
 *     closes στο -25% από το peak μετά την ενεργοποίηση (ήταν -40%), με ένα ελάχιστο
 *     κατοχυρωμένο κέρδος +10% (PROFIT_FLOOR_SCALE) — βλ. τα σχόλια στις τρεις σταθερές
 *     πιο κάτω για το γιατί.
 * Το exit-resolver αντιμετωπίζει όποιο από τα δύο (ή wallet-exit-signal, ή timeout)
 * συμβεί ΠΡΩΤΟ χρονικά ως πλήρες κλείσιμο της (απλοποιημένης, ενιαίας) simulated θέσης —
 * δε μοντελοποιούμε split 50/50 θέσεις σε ξεχωριστά rows στο v1.
 */
export const EXIT_TIER_1_PRICE_SCALE = 1.5; // +50%

/**
 * ΑΛΛΑΓΗ 2026-09-22 (πραγματικό feedback χρήστη: "το trailing_stop σχεδόν ποτέ δεν
 * πυροδοτείται, τα trades κλείνουν στο +50% από το tier1"). Root cause επιβεβαιωμένο στον
 * κώδικα, όχι υπόθεση: με activation στο +100%, ΚΑΘΕ ανοδική πορεία περνάει αναγκαστικά
 * πρώτα από το [+50%, +100%) — δηλαδή από το tier1 exit window. Σε ένα tick-by-tick (ή
 * candle-by-candle) feed, το tier1 «κλέβει» σχεδόν πάντα την έξοδο πριν προλάβει ποτέ να
 * ενεργοποιηθεί το trailing (μόνο ένα ΜΟΝΟ tick που πηδάει απευθείας από <1.5x σε >=2x θα
 * το απέφευγε — σχεδόν ανύπαρκτο στην πράξη). Άρα το trailing ήταν ουσιαστικά dead code στο
 * κανονικό μονοπάτι, όχι θέμα ταχύτητας websocket vs GMGN native order όπως αρχικά
 * υποτέθηκε (βλ. ανάλυση 2026-09-22): το native order (`liveExitConditionOrders` πιο κάτω)
 * ΔΕΝ έχει καν tier1 config, γι' αυτό φαινόταν "πιο έξυπνο" σε γρήγορα pumps — απουσία cap,
 * όχι ταχύτητα.
 *
 * ΔΙΟΡΘΩΣΗ: activation πλέον στο ΙΔΙΟ σημείο με το tier1 (+50%). Με τη σειρά ελέγχου του
 * checkTick/resolveExit (τιer2-activation πριν το tier1-check), το tier1 ΠΑΥΕΙ ουσιαστικά
 * να πυροδοτείται ποτέ — trailing παίρνει τον έλεγχο από το +50% και μετά, σε ΚΑΘΕ trade
 * που φτάνει εκεί. `EXIT_TIER_1_PRICE_SCALE` παραμένει ορισμένη (ιστορικός λόγος: παίζει
 * ρόλο ΜΟΝΟ στο απίθανο σενάριο ενός tick που πηδάει απευθείας <1.5x → exit πριν προλάβει
 * να ελεγχθεί ξανά, βλ. checkTick's σειρά ελέγχων) αλλά στην πράξη είναι πλέον σπάνια
 * ενεργή διαδρομή, όχι το κύριο exit path όπως πριν.
 *
 * ΕΦΑΡΜΟΓΗ: ΠΑΝΤΟΥ (log_only/paper/live) — checkTick/resolveExit είναι κοινός κώδικας
 * πάνω σε αυτές τις σταθερές, καμία per-mode διαφοροποίηση (ρητή επιλογή χρήστη
 * 2026-09-22, απλούστερο από το να προστεθεί νέο mode-branching σε ήδη ευαίσθητο exit
 * path). `liveExitConditionOrders()` πιο κάτω διαβάζει τις ΙΔΙΕΣ σταθερές, άρα το native
 * GMGN order παίρνει αυτόματα το ίδιο ενωρίτερο activation.
 */
export const EXIT_TIER_2_ACTIVATION_SCALE = 1.5; // +50% (ήταν +100%)

/**
 * ΑΛΛΑΓΗ 2026-09-22, μαζί με το activation πιο πάνω — ΚΡΙΣΙΜΟ να αλλάξουν μαζί: ενεργοποίηση
 * τόσο νωρίς (+50%) ΜΕ το παλιό φαρδύ 40% drawdown θα σήμαινε ότι ένα trade που μόλις
 * αγγίζει +50-55% και καταρρέει θα έκλεινε σε ΖΗΜΙΑ (π.χ. peak +50% × 0.6 = -10% από entry
 * — επιβεβαιωμένο με υπολογισμό, βλ. session 2026-09-22), αντιστρέφοντας ακριβώς αυτό που
 * θέλουμε (secure gains, όχι τα μετατρέπουμε σε ζημιά). Με 25% drawdown, το ΧΕΙΡΟΤΕΡΟ
 * δυνατό σενάριο (peak ακριβώς στο ελάχιστο +50% activation) δίνει stop στο +12.5% —
 * μαθηματικά αδύνατο να καταλήξει σε ζημιά όσο activation παραμένει >= +50%
 * (χρειάζεται peak >= activation/(1-drawdown) = 50%/0.75 = 66.7%... όχι, ο σωστός τύπος
 * είναι: peak*(1-drawdown) >= entry <=> peak >= entry/(1-drawdown), και με peak_min=+50%
 * το πηλίκο βγαίνει πάντα θετικό για drawdown<=0.5*safety-margin — βλ. PROFIT_FLOOR_SCALE
 * πιο κάτω για το ρητό, δεύτερο δίχτυ ασφαλείας που ΔΕΝ εξαρτάται από αυτόν τον υπολογισμό).
 */
export const EXIT_TIER_2_DRAWDOWN_PCT = 0.25; // -25% από το peak μετά την ενεργοποίηση (ήταν -40%)

/**
 * ΝΕΟ 2026-09-22 — δεύτερο, ανεξάρτητο δίχτυ ασφαλείας πάνω από το EXIT_TIER_2_DRAWDOWN_PCT:
 * μόλις το trailing ενεργοποιηθεί, ο υπολογισμένος stop ΔΕΝ επιτρέπεται ποτέ να πέσει κάτω
 * από αυτό το ελάχιστο κατοχυρωμένο κέρδος (`entryPrice * PROFIT_FLOOR_SCALE`), όσο χαμηλά
 * κι αν πάει το `peak * (1 - EXIT_TIER_2_DRAWDOWN_PCT)`. Με τις τρέχουσες τιμές (+50%
 * activation, 25% drawdown) το floor είναι ΗΔΗ μαθηματικά αδρανές — κάθε ενεργοποιημένο
 * trailing δίνει ελάχιστο +12.5%, πάνω από το +10% floor. Κρατιέται ρητά ως κώδικας
 * (όχι μόνο ως νούμερο-σύμπτωση) ώστε μια μελλοντική αλλαγή στο drawdown (π.χ. πίσω σε
 * 0.35-0.40 για να «τρέξουν» περισσότερο τα κέρδη) να ΜΗΝ ξαναφέρει σιωπηλά το ίδιο bug —
 * το +10% παραμένει η σκληρή εγγύηση ό,τι κι αν αλλάξει το drawdown. Χρησιμοποιείται με
 * `Math.max(peak * (1 - drawdown), entryPrice * PROFIT_FLOOR_SCALE)` στο checkTick.ts/
 * exitResolver.ts. ΔΕΝ εκφράζεται εγγενώς στο GMGN `profit_stop_trace` API (δεν έχει
 * τέτοιο "min guaranteed profit" concept) — το native order (liveExitConditionOrders
 * πιο κάτω) παραμένει ΧΩΡΙΣ αυτό το floor, ο δικός μας tracker/checkTick είναι η μόνη
 * πηγή αλήθειας γι' αυτό. Το native order παραμένει καθαρά dead-man's-switch backup
 * (ίδιο ρόλο με πριν), ελαφρώς λιγότερο ασφαλές σε αυτή τη συγκεκριμένη άκρη περίπτωση.
 */
export const PROFIT_FLOOR_SCALE = 1.1; // +10% ελάχιστο κατοχυρωμένο κέρδος μετά την ενεργοποίηση

/**
 * Νέο 2026-09-11, πρώτη φορά πραγματικό κεφάλαιο. -50% από το ENTRY (όχι από peak,
 * διαφορετικό από το EXIT_TIER_2_DRAWDOWN_PCT) — καθαρή προστασία downside, ελέγχεται
 * πρώτο απ' όλα στο checkTick. Το GMGN CLI υποστηρίζει ήδη native `stop_loss` order
 * type (`order strategy create --sub-order-type stop_loss`) που θα εκτελούνταν από τη
 * ΔΙΚΗ ΤΟΥΣ υποδομή, ανεξάρτητα από το αν το δικό μας process είναι ζωντανό — πιο
 * robust μακροπρόθεσμα, αλλά εντελώς ανεπιβεβαίωτο ακόμα στην πράξη. Ξεκινάμε με τον
 * δικό μας, ήδη δοκιμασμένο μηχανισμό (checkTick) — το native GMGN stop_loss είναι
 * σκόπιμα ένα ΕΠΟΜΕΝΟ, ξεχωριστό βήμα, όχι κάτι που τρέχουμε να προλάβουμε τώρα.
 */
/**
 * ΑΛΛΑΓΗ 2026-10-04, ρητή απόφαση χρήστη: −50% → −30%. exit-path-analysis (--active-only,
 * 168 trades, 30″ candles, προσομοίωση επιβεβαιωμένη 93% με το paper): το −30% κόβει μόνο
 * 9% των νικητών (το −20% 18%), και βγαίνει καλύτερο και στις μέρες train ΚΑΙ στις test.
 * Δεν πήγαμε στο −20% γιατί στο live το stop εκτελείται 1–2″ αργότερα, σε χειρότερη τιμή.
 */
export const STOP_LOSS_PCT = 0.3;

/**
 * ΝΕΟ 2026-10-04, ρητή απόφαση χρήστη: θέση που σε 30′ ΔΕΝ έχει ενεργοποιήσει trailing
 * κλείνει (exit_reason 'time_limit'). Μετρημένο: 9/10 νικητές πιάνουν +50% μέσα σε 15′,
 * ενώ τα «νεκρά» trades έληγαν στις 24h στο −17% κατά μέσο όρο. Ελέγχεται σε κάθε tick
 * (decideForTick). Token χωρίς κανένα trade δεν αλλάζει τιμή στη bonding curve — κλείνει
 * στο επόμενο tick του, ή στο 24ωρο timeout όπως πριν.
 */
export const NO_PROGRESS_EXIT_MS = 30 * 60 * 1000;

/**
 * ΝΕΟ 2026-10-04, ρητή απόφαση χρήστη: αγορά wallet κάτω από 0.3 SOL ΔΕΝ δίνει σήμα
 * (skip 'wallet_buy_too_small', πριν από το on-demand gate — γλιτώνει και τα GMGN calls).
 * exit-path-analysis: αρνητικό και στις μέρες train ΚΑΙ στις test (−0.02 SOL/trade) — οι
 * μικρές «δοκιμαστικές» αγορές είναι κακά σήματα.
 */
export const MIN_WALLET_BUY_SOL = 0.3;

export const EXIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Πρώτη φορά πραγματικό κεφάλαιο (2026-09-11) — ξεκινάμε με 1 SOL, 5% ανά trade,
 * ΣΤΑΘΕΡΟ ποσό (όχι % του τρέχοντος διαθέσιμου, που θα συρρικνωνόταν με κάθε trade) —
 * απλούστερο να σκεφτείς, ίδιο πνεύμα με το PAPER_BANKROLL_SOL/PAPER_POSITION_SIZE_PCT.
 * ΞΕΧΩΡΙΣΤΕΣ σταθερές από τις PAPER_* — σκόπιμα, ώστε να μπορούν να αλλάξουν ανεξάρτητα
 * στο μέλλον (π.χ. αν αυξηθεί το πραγματικό bankroll χωρίς να αλλάξει η παραδοχή
 * μεγέθους για τα ιστορικά/hypothetical trades).
 */
export const LIVE_BANKROLL_SOL = 1;
export const LIVE_POSITION_SIZE_PCT = 0.05;
export const LIVE_POSITION_SIZE_SOL = LIVE_BANKROLL_SOL * LIVE_POSITION_SIZE_PCT;

/**
 * Από το GMGN's δικό τους reference "AI Trader" demo (gmgn-demos/aitrader, εξετάστηκε
 * 2026-09-11) — δικές τους, ήδη σκεπτόμενες επιλογές για ρίσκο σε live trading:
 *   kill_switch_consec_losses: 3, daily_loss_cap_sol: 0.5 (πάνω σε 10 SOL equity — 5%)
 * Το `daily_loss_cap` εδώ ΔΕΝ είναι απλή αναλογία (0.05 SOL θα ήταν πολύ σφιχτό —
 * μία μόνο ζημιά stop-loss στο μισό μιας θέσης θα το έφτανε) — υπολογισμένο ώστε να
 * αφήνει περιθώριο για ~5 stop-lossed trades πριν σταματήσει, όχι 2.
 * kill-switch: ΣΤΑΘΕΡΟ μέχρι χειροκίνητο reset, ΟΧΙ αυτόματη επαναφορά — ρητή απόφαση
 * χρήστη 2026-09-11, βλ. liveRiskGate.ts + migration 0010.
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-18: ανέβηκε 3→10, ρητό αίτημα χρήστη μετά το real incident 2026-09-17
 * (τρεις μικρές, ανεξάρτητες, μη ασυνήθιστες ζημιές — 1194 stop_loss -0.0286, 1195/1196
 * exit_signal -0.0133/-0.0027 SOL, σύνολο -0.045 SOL, πολύ κάτω από το daily cap — έκλεισαν
 * το live trading sticky μέχρι χειροκίνητο /resume_live). Με το ~98.6% collapse base rate
 * (CLAUDE.md), 3 συνεχόμενες ζημιές είναι στατιστικά αναμενόμενες πολύ συχνά και δεν
 * υποδεικνύουν από μόνες τους σπασμένη στρατηγική — το 3 ήταν πολύ ευαίσθητο για το
 * πραγματικό προφίλ ρίσκου εδώ. Το `LIVE_DAILY_LOSS_CAP_SOL` παρέμεινε τότε το κύριο, πιο
 * αξιόπιστο guardrail (μετράει πραγματικό μέγεθος ζημιάς, όχι απλά αριθμό trades στη
 * σειρά).
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-19: ανέβηκε 0.15→0.50 SOL (50% του LIVE_BANKROLL_SOL=1), ρητό αίτημα
 * χρήστη. Πραγματικό εύρημα: στις 2026-09-19 το σύνολο ζημιών σε live trades έφτασε
 * 0.330 SOL μέσα στην ίδια Athens ημέρα (37 κλεισμένα live trades, μείγμα κερδών/ζημιών —
 * βλ. `getTodayRealizedLossSol`), υπερβαίνοντας το τότε όριο 0.15 SOL και μπλοκάροντας
 * σωστά (`checkLiveRiskGate` → `mode='log_only'`) κάθε νέο σήμα μέχρι αλλαγή
 * ημερολογιακής ημέρας Αθήνας — καμία εξαίρεση/μαντεψιά, ο κώδικας δούλεψε όπως
 * σχεδιάστηκε. Το 0.15 αποδείχθηκε στην πράξη πολύ σφιχτό για το πραγματικό ημερήσιο
 * trading volume σε αυτή τη φάση (πολλαπλά μικρά live trades/ημέρα, όχι μόνο 1-2) — το
 * 0.50 αφήνει ρεαλιστικό περιθώριο χωρίς να αχρηστεύει το guardrail. Sticky ΜΕΧΡΙ αλλαγή
 * ημέρας παραμένει (καμία αλλαγή reset-λογικής) — το `/resume_live`-style χειροκίνητο
 * reset παραμένει ξεχωριστό, μόνο για το kill-switch (`clearLiveHalt`), όχι για το daily
 * cap, που πάντα ξεκίναγε ξανά μόνο του την επόμενη Athens ημέρα.
 */
export const LIVE_KILL_SWITCH_CONSEC_LOSSES = 10;

/**
 * Live entries σε ήδη «αποφοιτημένα» tokens (εκτός bonding curve, PumpSwap/AMM).
 *
 * 2026-09-27, ρητή απόφαση χρήστη: μέχρι τότε αυτά τα σήματα απορρίπτονταν εντελώς
 * (`no_realtime_price`). Από εκείνη τη μέρα έχουν τιμή (solAmount/tokenAmount, βλ.
 * priceFromTradeEvent) και ανοίγουν ΜΟΝΟ paper, για 1-2 μέρες δοκιμής. Μετά τρέχουμε
 * `npm run graduated-report` — αν τα αποτελέσματα είναι θετικά, γίνεται true (live, με
 * paper fallback όπως κάθε άλλο σήμα), αλλιώς μένει false.
 */
/* ΑΛΛΑΓΗ 2026-09-29 (ρητή απόφαση χρήστη, graduated-report: 118 trades, −0.38 SOL): με
 * false, τα σήματα σε graduated tokens ΑΓΝΟΟΥΝΤΑΙ ΕΝΤΕΛΩΣ — ούτε live ούτε paper. */
export const LIVE_ON_GRADUATED_TOKENS = false;

/**
 * "4B" trailing — ΜΟΝΟ σε shadow mode (2026-09-28, ρητή απόφαση χρήστη), βλ. migration
 * 0017 και realtime/shadowExit.ts. ΔΕΝ επηρεάζει καμία πραγματική έξοδο.
 *
 * - GRACE: τα πρώτα X ms μετά την αγορά το trailing ΔΕΝ βγαίνει (το stop-loss ισχύει).
 * - CONFIRM: μετά το grace, η τιμή πρέπει να ΜΕΙΝΕΙ κάτω από το trailing stop για X ms
 *   συνεχόμενα (όχι ένα tick) πριν την έξοδο· αν ανέβει ξανά πάνω, το ρολόι μηδενίζει.
 *
 * Αφορμή: trade 6442 βγήκε σε στιγμιαία πτώση 25%, 19″ μετά την αγορά, στο +104% — το
 * token πήγε ~×23. Συντηρητικές αρχικές τιμές· ρύθμιση με βάση το shadow report.
 */
export const TRAILING_GRACE_MS = 60_000;
export const TRAILING_CONFIRM_MS = 10_000;
export const LIVE_DAILY_LOSS_CAP_SOL = 0.5;

export function conditionOrdersJson(): Record<string, unknown>[] {
  return [
    { order_type: 'profit_stop', price_scale: '50', sell_ratio: '50' },
    {
      order_type: 'profit_stop_trace',
      price_scale: '100',
      sell_ratio: '100',
      drawdown_rate: '40',
    },
  ];
}

/**
 * Το ΠΡΑΓΜΑΤΙΚΟ exit plan που περνάει στο `swap --condition-orders` για `mode='live'`
 * trades (2026-09-17, incident #1193 — βλ. migration 0013). ΣΚΟΠΙΜΑ ΔΙΑΦΟΡΕΤΙΚΟ από το
 * `conditionOrdersJson()` πιο πάνω: εκείνο περιγράφει ένα scale-out (50% στο tier1 +
 * trailing στο υπόλοιπο) — καλή στρατηγική αφ' εαυτής, αλλά ΔΕΝ ταιριάζει με το πώς
 * μοντελοποιούμε μια θέση αλλού (ΕΝΑ paper_trades row, ΕΝΑ pnl_sol/pnl_pct, κλείνει
 * ΜΙΑ φορά — βλ. checkTick/resolveExit's ρητή σύμβαση "tier2 πάντα υπερισχύει, ποτέ
 * partial fill"). Ένα partial tier1-sell θα άφηνε τη θέση "μισοκλειστή" με τρόπο που το
 * σημερινό schema δεν αναπαριστά καθόλου.
 *
 * Αντ' αυτού: ΜΟΝΟ trailing (ενεργοποίηση +50% από 2026-09-22, 25% drawdown από peak,
 * ΟΛΟΚΛΗΡΗ η θέση) + stop_loss (-50% από entry, ΟΛΟΚΛΗΡΗ η θέση) — ακριβώς οι ίδιες
 * τιμές/σημασιολογία με το δικό μας checkTick (διαβάζει τις ΙΔΙΕΣ σταθερές πιο πάνω,
 * καμία διπλή τιμή να ξεσυγχρονιστεί), ώστε το native order και το δικό μας watchdog να
 * συμφωνούν πάντα για το ΠΟΤΕ θα έκλεινε η θέση, ακόμα κι όταν αναλαμβάνει το ένα από τα
 * δύο.
 *
 * ⚠️ ΔΕΝ έχει το `PROFIT_FLOOR_SCALE` δίχτυ ασφαλείας (βλ. σχόλιο εκεί) — το GMGN
 * `profit_stop_trace` δεν έχει τέτοιο "ελάχιστο κατοχυρωμένο κέρδος" concept, μόνο
 * activation-price + drawdown-rate. Με τις τρέχουσες τιμές αυτό είναι ήδη αβλαβές
 * (+50%/25% δίνει μαθηματικά ελάχιστο +12.5%, πάνω από το floor ούτως ή άλλως), αλλά αν
 * ποτέ το drawdown ξανασφίξει/χαλαρώσει, το native order ΔΕΝ θα πάρει αυτόματα το ίδιο
 * floor προστασία που παίρνει ο δικός μας tracker — μένει καθαρά dead-man's-switch
 * backup, ελαφρώς λιγότερο ασφαλές σε αυτή τη συγκεκριμένη άκρη περίπτωση.
 */
export function liveExitConditionOrders(): Record<string, unknown>[] {
  return [
    {
      order_type: 'profit_stop_trace',
      side: 'sell',
      price_scale: String(Math.round((EXIT_TIER_2_ACTIVATION_SCALE - 1) * 100)), // '50' = +50% (ήταν '100')
      drawdown_rate: String(Math.round(EXIT_TIER_2_DRAWDOWN_PCT * 100)), // '25' = -25% από peak (ήταν '40')
      sell_ratio: '100',
    },
    {
      order_type: 'loss_stop',
      side: 'sell',
      price_scale: String(Math.round(STOP_LOSS_PCT * 100)), // '50' = -50% από entry
      sell_ratio: '100',
    },
  ];
}

/**
 * On-demand gate (2026-09-28, ρητή απόφαση χρήστη) — βλ. decision/onDemandGate.ts.
 * Όταν ένα wallet μας αγοράζει token ΧΩΡΙΣ καμία αξιολόγηση gate, το ελέγχουμε εκείνη
 * τη στιγμή αντί να χάσουμε το σήμα (μετρημένη καθυστέρηση πριν: 20–26′ από τη δημιουργία).
 * ΑΛΛΑΓΗ 2026-09-29, ρητή απόφαση χρήστη: LIVE_ON_DEMAND_GATE = true. Report εκείνης της
 * μέρας (42 on-demand vs 36 κανονικά, ίδια περίοδος): είσοδος 0.7′ vs 12.9′ μετά τη
 * δημιουργία, market cap 43 vs 98 SOL, διάμεσο −5.5% vs −5.9%, μέσο +1.7% vs +10.4%.
 * ΑΛΛΑΓΗ 2026-09-30, ρητή απόφαση χρήστη: πίσω σε paper (false). on-demand-gate-report:
 * 100 trades, −0.39 SOL, διάμεσο −7.0% — ξανακρίνεται με το exit_signal εκτός.
 */
export const ON_DEMAND_GATE_ENABLED = true;
// ΑΛΛΑΓΗ 2026-10-04, ρητή απόφαση χρήστη: ξανά true — με τα ενεργά wallets το on-demand
// είναι το καλύτερο gate (+0.012 SOL/trade έναντι +0.005 του discovery, exit-path-analysis).
export const LIVE_ON_DEMAND_GATE = true;

/**
 * ΝΕΟ 2026-10-05, ρητή απόφαση χρήστη: live ΜΟΝΟ με on-demand — οι είσοδοι μέσω discovery
 * μένουν paper. Πρώτη μέρα με τους νέους κανόνες: discovery 1/11 wins, −0.28 SOL (μπαίνει
 * ~13′ μετά τη γέννηση, ~100 SOL mcap — η κίνηση έχει ήδη γίνει), on-demand 14/27, +0.18.
 */
export const LIVE_DISCOVERY_GATE = false;

/**
 * 2026-09-30, ρητή απόφαση χρήστη: ΔΕΝ πουλάμε όταν πουλάει το wallet που αντιγράφουμε
 * (exit_signal) — ούτε σε πρώιμες ούτε σε κανονικές αγορές, live και paper. Η έξοδος
 * γίνεται μόνο από trailing (+50% / −25%, floor +10%), stop-loss −50% και 24h timeout.
 * Τεκμηρίωση (no-exit-signal-report, shadow με τα ίδια ticks): πρώιμες 28 trades — διάμεσο
 * −2.1% → +17.6%, +0.17 SOL· κανονικές 24 trades — διάμεσο −3.0% → +14.0%, +0.19 SOL (χωρίς
 * το ψεύτικο #6779). Το πούλημα του wallet περνά πλέον ως απλό price tick.
 */
export const EXIT_ON_COPIED_WALLET_SELL = false;
/** Ανώτατο όριο on-demand ελέγχων/λεπτό (κάθε έλεγχος = 2 GMGN calls, weight 1+1). */
export const ON_DEMAND_GATE_MAX_PER_MINUTE = 20;
/** Προτεραιότητα στον κοινό GMGN limiter: πάνω από όλα τα collectors, κάτω από τα swaps (1000). */
export const ON_DEMAND_GATE_PRIORITY = 900;

/**
 * Holder-risk έλεγχος σε κάθε realtime αγορά (2026-09-29, ρητή απόφαση χρήστη) — βλ.
 * decision/holderRiskCheck.ts για την τεκμηρίωση του ορίου (≥50% → −92.9%, n=460, από το
 * κανάλι GMGN smart money).
 *  - 'record': ελέγχεται και καταγράφεται (paper_trades.entry_timing_json.holder_risk),
 *    ΔΕΝ μπλοκάρει, και τρέχει παράλληλα με την αγορά (καμία καθυστέρηση).
 *  - 'block': ελέγχεται ΠΡΙΝ την αγορά (~0.5–1″), και σήματα με risk ≥ 50% απορρίπτονται.
 *
 * Ανά πηγή gate (ρητή απόφαση χρήστη, ίδια μέρα):
 *  - discovery → 'block' ΑΜΕΣΩΣ: ίδιος πληθυσμός με το κανάλι όπου τεκμηριώθηκε το όριο
 *    (tokens που είχαν ήδη περάσει το gate του discovery).
 *  - on_demand → 'record': πρώιμες είσοδοι (~1′ από τη δημιουργία), όπου οι holders είναι
 *    αναγκαστικά κυρίως snipers/bots — το όριο μπορεί να μην ισχύει εκεί. Γίνεται 'block'
 *    μόνο αν το `npm run holder-risk-report` δείξει ✅.
 */
export type HolderRiskMode = 'record' | 'block';
export const HOLDER_RISK_ENTRY_MODE: Readonly<Record<'discovery' | 'on_demand', HolderRiskMode>> = {
  discovery: 'block',
  on_demand: 'record',
};

-- Πραγματικά ποσά (SOL) για live trades — αντικαθιστούν την ανάγκη για assumed_fees_pct
-- σε live trades: το πραγματικό pnl_sol υπολογίζεται απευθείας από τη διαφορά
-- πραγματικού υπολοίπου πριν/μετά, όχι από ποσοστιαία παραδοχή. NULL για paper/log_only
-- trades (καμία πραγματική εκτέλεση να μετρηθεί).
ALTER TABLE paper_trades ADD COLUMN actual_entry_amount_sol NUMERIC;
ALTER TABLE paper_trades ADD COLUMN actual_exit_amount_sol NUMERIC;

-- Καταγραφή ΚΑΘΕ αποτυχημένης πραγματικής προσπάθειας swap — entry (πέφτουμε σε paper,
-- καμία πραγματική έκθεση) ή exit (η θέση ήδη ανοιχτή με πραγματικό κεφάλαιο,
-- χρειάζεται χειροκίνητη προσοχή). Ξεχωριστός πίνακας, όχι στήλες στο paper_trades:
-- μπορεί να υπάρξουν πολλαπλές αποτυχημένες προσπάθειες για το ΙΔΙΟ trade πριν την
-- επιτυχή, χειροκίνητη. `paper_trade_id` NULL όταν η αποτυχία ήταν στο entry πριν καν
-- υπάρξει trade row.
CREATE TABLE trade_execution_errors (
  id                 BIGSERIAL PRIMARY KEY,
  paper_trade_id     BIGINT REFERENCES paper_trades(id),
  token_address      TEXT NOT NULL,
  action             TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
  attempted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_sol         NUMERIC,
  error_message      TEXT NOT NULL,
  error_detail_json  JSONB
);
CREATE INDEX idx_trade_execution_errors_trade ON trade_execution_errors(paper_trade_id);
CREATE INDEX idx_trade_execution_errors_token ON trade_execution_errors(token_address);

-- Όταν μια πραγματική πώληση αποτυγχάνει, η θέση ΠΑΡΑΜΕΝΕΙ ανοιχτή (πραγματικό κεφάλαιο
-- ακόμα εκτεθειμένο) αλλά χρειάζεται χειροκίνητη προσοχή — ρητή απόφαση χρήστη
-- 2026-09-15: "θα γίνεται χειροκίνητη προσπάθεια", άρα το αυτόματο exit-checking ΔΕΝ
-- πρέπει να ξαναδοκιμάσει μόνο του. Sticky flag· καθαρίζει μόνο όταν η χειροκίνητη
-- προσπάθεια πετύχει (βλ. scripts/close-manual-exit.ts).
ALTER TABLE paper_trades ADD COLUMN needs_manual_exit BOOLEAN NOT NULL DEFAULT false;

-- Ένα πραγματικό live sell μπορεί να πάρει έως ~30" (confirmation polling, βλ.
-- gmgn/swap.ts). Το exit-checking κλειδώνει ανά trade ΜΟΝΟ για τη σύντομη διάρκεια
-- μιας απόφασης — αν κρατούσαμε το lock/transaction ανοιχτό για ολόκληρη τη διάρκεια
-- του swap, ένα δεύτερο, γρήγορο tick στο ίδιο ενεργό token θα έμενε μπλοκαρισμένο
-- (ή θα εξαντλούσε το connection pool). Αντ' αυτού: σημαδεύουμε την απόπειρα ΕΔΩ,
-- ελευθερώνουμε το lock, εκτελούμε το swap ΕΚΤΟΣ transaction — ένα δεύτερο tick που
-- φτάνει ενώ αυτό είναι ακόμα πρόσφατο (βλ. LIVE_EXIT_ATTEMPT_STALE_MS) το αγνοεί,
-- αντί να προσπαθήσει ΚΑΙ αυτό δική του πώληση στην ΙΔΙΑ θέση ταυτόχρονα.
ALTER TABLE paper_trades ADD COLUMN exit_attempt_started_at TIMESTAMPTZ;

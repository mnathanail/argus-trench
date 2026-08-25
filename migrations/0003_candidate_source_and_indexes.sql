-- ArgusTrench — candidate provenance + missing FK indexes

-- Το `market trenches` gated call επιστρέφει ΜΟΝΟ survivors: τα tokens που κόπηκαν από
-- τα server-side filters δεν εμφανίζονται πουθενά στο response. Άρα το decision_log δε
-- μπορεί να γράψει skipped_gate rows από αυτό. Το καλύπτουμε με δεύτερο, ungated call
-- ανά κύκλο, όπου εφαρμόζουμε τα ίδια thresholds client-side.
--
-- Τα δύο calls ΔΕΝ έχουν την ίδια στατιστική σημασία:
--   gated_pool    — survivors από όλο το βάθος του pool (μετρημένο: 60 vs 15 στο window),
--                   αλλά χωρίς ορατότητα στους rejects
--   sample_window — τα ~60 πιο πρόσφατα, ΚΑΙ passes ΚΑΙ fails· η μόνη πηγή skipped_gate,
--                   αλλά sample και όχι πλήρης πληθυσμός
--
-- Χωρίς αυτή τη στήλη, η ανάλυση της Φάσης 2 θα διάβαζε το sampling frame ως πλήρη
-- κατανομή και θα υπολόγιζε λάθος pass-rate. Επίτηδες NOT NULL χωρίς default: ο writer
-- πρέπει να δηλώνει ρητά προέλευση, να μη σιωπηλά κληρονομεί λάθος ετικέτα.
ALTER TABLE decision_log
  ADD COLUMN candidate_source TEXT NOT NULL,
  ADD CONSTRAINT chk_decision_log_candidate_source
    CHECK (candidate_source IN ('gated_pool', 'sample_window'));

-- Το pass-rate ανά logic_version είναι το βασικό ερώτημα του tuning, πάντα ανά provenance.
CREATE INDEX idx_decision_log_source_version
  ON decision_log(candidate_source, logic_version, gate_passed);

-- Δύο FK columns χωρίς index. Το δεύτερο το χτυπάμε συχνά ("τι έκανε αυτό το wallet").
CREATE INDEX idx_paper_trades_decision_log ON paper_trades(decision_log_id);
CREATE INDEX idx_decision_log_trigger_wallet ON decision_log(trigger_wallet_address);

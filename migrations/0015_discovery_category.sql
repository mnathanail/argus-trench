-- ArgusTrench — ξεχωριστή στήλη για το pump.fun lifecycle stage (new_creation /
-- near_completion / completed), ανεξάρτητη από το candidate_source

-- Μέχρι τώρα το discovery.ts καλούσε ΜΟΝΟ `category: 'near_completion'` (ο default στο
-- runDiscoveryCycle), άρα ΚΑΘΕ υπάρχον decision_log row είναι, στην πράξη, από εκείνη
-- την κατηγορία — το backfill πιο κάτω είναι γεγονός, όχι υπόθεση.
--
-- `category` (lifecycle stage: πόσο κοντά είναι το token στο bonding-curve completion)
-- και `candidate_source` (provenance: πώς το είδαμε — gated server-side filter ή
-- ungated sample) είναι ΔΥΟ ανεξάρτητες διαστάσεις, όχι μία. Ένα πραγματικό token
-- μπορεί να περάσει από new_creation σε near_completion ΚΑΙ ΤΑ ΔΥΟ μέσα σε ώρες —
-- πρόκειται για διαφορετικές, ΓΝΗΣΙΕΣ παρατηρήσεις στον χρόνο, όχι για διπλότυπα της
-- ίδιας αξιολόγησης. Γι' αυτό το conflate σε ένα ενιαίο candidate_source (π.χ.
-- 'new_creation_gated_pool') θα ήταν λάθος: θα ανάγκαζε δύο ανεξάρτητες μεταβλητές
-- (lifecycle stage × provenance) σε μία, μπερδεύοντας μελλοντική ανάλυση.
--
-- Επίτηδες NOT NULL με DEFAULT (σε αντίθεση με το candidate_source στο 0003, που ήταν
-- NOT NULL ΧΩΡΙΣ default): εκεί δεν υπήρχε ΚΑΝΕΝΑ ήδη υπάρχον row να πάρει default τιμή
-- με νόημα (ήταν η πρώτη φορά που καταγραφόταν προέλευση). Εδώ ΥΠΑΡΧΟΥΝ ήδη χιλιάδες
-- rows, και ΟΛΑ γνωρίζουμε με βεβαιότητα ότι είναι 'near_completion' — ένα explicit
-- backfill θα έκανε ακριβώς το ίδιο πράγμα με μεγαλύτερο ρίσκο (batch UPDATE σε μεγάλο
-- πίνακα) χωρίς κανένα όφελος ακρίβειας.
ALTER TABLE decision_log
  ADD COLUMN category TEXT NOT NULL DEFAULT 'near_completion',
  ADD CONSTRAINT chk_decision_log_category
    CHECK (category IN ('new_creation', 'near_completion', 'completed'));

-- Το DEFAULT παραμένει μόνιμα (ΔΕΝ κάνουμε DROP DEFAULT μετά το backfill, σε αντίθεση
-- με συνήθη migration πρακτική) — κάθε μελλοντικός caller που ξεχάσει να περάσει
-- category ρητά θα πάρει τη σωστή, τρέχουσα προεπιλογή του discovery.ts
-- (`category ?? 'near_completion'`), όχι NULL/σφάλμα. Το `candidate_source` δεν έχει
-- default επίτηδες (θέλαμε να σκάσει αν ξεχαστεί) — εδώ ο κίνδυνος είναι αντίστροφος:
-- ένα ξεχασμένο category θα έπρεπε να σημαίνει "ό,τι κάναμε πάντα", όχι σφάλμα.

-- Το unique key ΠΡΕΠΕΙ να συμπεριλάβει category: χωρίς αυτό, μια νέα new_creation
-- αξιολόγηση για ένα token που βρίσκεται ΗΔΗ στο near_completion με το ΙΔΙΟ
-- candidate_source θα συγκρουόταν στο idx_decision_log_candidate_identity και θα
-- αντικαθιστούσε σιωπηλά τη μία lifecycle-stage παρατήρηση με την άλλη.
DROP INDEX idx_decision_log_candidate_identity;
CREATE UNIQUE INDEX idx_decision_log_candidate_identity
  ON decision_log(token_address, logic_version, candidate_source, category);

-- Ίδιο σκεπτικό με idx_decision_log_source_version (0003) — pass-rate ανά provenance
-- ΚΑΙ ανά lifecycle stage είναι πλέον ξεχωριστά ερωτήματα.
CREATE INDEX idx_decision_log_category_version
  ON decision_log(category, logic_version, gate_passed);

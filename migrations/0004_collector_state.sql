-- ArgusTrench — state που χρειάζονται οι collector loops (Φάση 1)

-- ── decision_log: ένα row ανά candidate, όχι ανά poll tick ────────────────────────────
-- Ένα token μένει στο trenches για ώρες, άρα το βλέπουμε σε δεκάδες διαδοχικούς κύκλους.
-- Χωρίς dedup, το decision_log θα μέτραγε poll ticks αντί για candidates και κάθε
-- pass-rate query θα ήταν λάθος.
--
-- Το κλειδί περιλαμβάνει candidate_source ΕΠΙΤΗΔΕΣ: ένα token μπορεί να εμφανιστεί ΚΑΙ
-- στο gated ΚΑΙ στο ungated call. Αν dedup-άραμε μόνο σε (token, logic_version), η μία
-- από τις δύο παρατηρήσεις θα χανόταν και το pass-rate εκείνης της πηγής θα ήταν
-- υπολογισμένο σε ελλιπές δείγμα — δηλαδή θα χαλούσε ακριβώς η μέτρηση για την οποία
-- προστέθηκε το candidate_source στο 0003.
CREATE UNIQUE INDEX idx_decision_log_candidate_identity
  ON decision_log(token_address, logic_version, candidate_source);

-- Κρατάμε πόσες φορές το ξαναείδαμε και πότε τελευταία, χωρίς να αποθηκεύουμε ολόκληρη
-- χρονοσειρά. Το evaluated_at μένει «πρώτη φορά που το αξιολογήσαμε».
ALTER TABLE decision_log
  ADD COLUMN last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN evaluation_count  INTEGER     NOT NULL DEFAULT 1;

-- ── watchlist_wallets: cursor ανά wallet ──────────────────────────────────────────────
-- Το `portfolio activity` επιστρέφει πάντα τα πιο πρόσφατα trades. Χωρίς cursor, κάθε
-- κύκλος θα ξανα-παρήγαγε τα ΙΔΙΑ buys ως νέα triggers.
ALTER TABLE watchlist_wallets
  ADD COLUMN last_seen_tx_hash      TEXT,
  ADD COLUMN last_seen_activity_at  TIMESTAMPTZ;

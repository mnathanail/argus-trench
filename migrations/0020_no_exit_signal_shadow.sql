-- 2026-09-29 — δεύτερη shadow δοκιμή (ρητή απόφαση χρήστη): «χωρίς exit_signal».
-- Ίδια λογική εξόδου με τη σημερινή (trailing +50% / −25% από κορυφή, floor +10%,
-- stop-loss −50%, timeout 24h) ΑΛΛΑ χωρίς να πουλάμε όταν πουλάει το wallet που
-- αντιγράφουμε. Ερώτημα: αν αφήναμε το trailing να δουλέψει, θα βγάζαμε περισσότερα;
-- Γράφεται ΜΟΝΟ εδώ — ποτέ δεν επηρεάζει πραγματική έξοδο. Report: npm run no-exit-signal-report.
ALTER TABLE paper_trades
  ADD COLUMN nosig_tracked          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN nosig_peak_price       NUMERIC,
  ADD COLUMN nosig_trailing_active  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN nosig_breach_since     TIMESTAMPTZ,
  ADD COLUMN nosig_exit_reason      TEXT,
  ADD COLUMN nosig_exit_price       NUMERIC,
  ADD COLUMN nosig_exit_at          TIMESTAMPTZ;

CREATE INDEX idx_paper_trades_nosig_open
  ON paper_trades (token_address)
  WHERE nosig_tracked AND nosig_exit_at IS NULL;

-- 2026-09-28 — shadow δοκιμή του "4B" trailing (grace period + επιβεβαίωση), ρητή απόφαση
-- χρήστη. Αφορμή: trade 6442 (3RNy7erx…) βγήκε στο +104% με trailing_stop 19″ μετά την
-- αγορά, σε μια στιγμιαία πτώση 25% από το peak — το token πήγε αργότερα ~×23.
--
-- Κάθε νέο trade (live και paper) βγαίνει ΚΑΝΟΝΙΚΑ με τη σημερινή λογική. Παράλληλα, στα
-- ΙΔΙΑ ticks, καταγράφεται πού ΘΑ είχε βγει το 4B — ανεξάρτητα από την πραγματική έξοδο,
-- ώστε να συγκριθούν trade-προς-trade πάνω στα ίδια tokens (`npm run trailing-shadow-report`).
-- Καμία από αυτές τις στήλες δεν επηρεάζει πραγματικές αποφάσεις.
ALTER TABLE paper_trades
  ADD COLUMN shadow_tracked          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN shadow_peak_price       NUMERIC,
  ADD COLUMN shadow_trailing_active  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN shadow_breach_since     TIMESTAMPTZ,
  ADD COLUMN shadow_exit_reason      TEXT,
  ADD COLUMN shadow_exit_price       NUMERIC,
  ADD COLUMN shadow_exit_at          TIMESTAMPTZ;

-- Γρήγορη εύρεση των shadows που χρειάζονται ακόμα ticks, ανά token.
CREATE INDEX idx_paper_trades_shadow_open
  ON paper_trades (token_address)
  WHERE shadow_tracked AND shadow_exit_at IS NULL;

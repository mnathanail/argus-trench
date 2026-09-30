-- 2026-09-30 (αίτημα χρήστη): σκιά trailing στις mirror θέσεις. Κάθε mirror θέση παρακολουθεί
-- και την τιμή του token (PumpPortal token ticks) και καταγράφει πού θα είχε βγει με τους
-- κανόνες του argus (trailing +50%/−25%, floor +10%, stop-loss −50%, 24h timeout), με είσοδο
-- την ΠΡΩΤΗ αγορά (MIRROR_BUY_SOL). ΔΕΝ επηρεάζει ποτέ την πραγματική (paper) θέση.
ALTER TABLE mirror_positions
  ADD COLUMN shadow_entry_price     NUMERIC,
  ADD COLUMN shadow_peak_price      NUMERIC,
  ADD COLUMN shadow_last_price      NUMERIC,
  ADD COLUMN shadow_trailing_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN shadow_exit_price      NUMERIC,
  ADD COLUMN shadow_exit_reason     TEXT,
  ADD COLUMN shadow_exit_at         TIMESTAMPTZ,
  ADD COLUMN shadow_pnl_sol         NUMERIC,
  ADD COLUMN shadow_pnl_pct         NUMERIC;

CREATE INDEX idx_mirror_positions_shadow_active ON mirror_positions (token_address)
  WHERE shadow_entry_price IS NOT NULL AND shadow_exit_reason IS NULL;

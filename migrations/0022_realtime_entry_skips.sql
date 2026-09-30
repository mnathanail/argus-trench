-- 2026-09-30 (ρητό αίτημα χρήστη): κάθε realtime αγορά ενός ΔΙΚΟΥ ΜΑΣ wallet που ΔΕΝ έγινε
-- trade, με τον λόγο. Μέχρι τώρα ο λόγος γραφόταν μόνο στο console ([realtime-entry-skip]) και
-- χανόταν σε κάθε deploy — το wallet-buys-check έδειξε 84/121 Pump.fun tokens ενός wallet
-- (chriskogias) χαμένα χωρίς να μπορούμε να πούμε γιατί. pool / has_curve_data κρατιούνται
-- επειδή η κύρια υπόθεση είναι ότι κάποια Pump.fun tokens έρχονται από το PumpPortal με
-- διαφορετικό pool ή χωρίς bonding-curve πεδία και περνιούνται για graduated.
-- Αγορές από wallets εκτός watchlist (token subscriptions) ΔΕΝ γράφονται.
CREATE TABLE realtime_entry_skips (
  id              BIGSERIAL PRIMARY KEY,
  skipped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  wallet_address  TEXT NOT NULL,
  token_address   TEXT NOT NULL,
  reason          TEXT NOT NULL,
  pool            TEXT,
  has_curve_data  BOOLEAN NOT NULL,
  sol_amount      NUMERIC,
  market_cap_sol  NUMERIC,
  detail_json     JSONB
);
CREATE INDEX idx_realtime_entry_skips_wallet ON realtime_entry_skips (wallet_address, skipped_at);
CREATE INDEX idx_realtime_entry_skips_token  ON realtime_entry_skips (token_address);

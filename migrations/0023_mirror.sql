-- 2026-09-30 (ρητή απόφαση χρήστη): MIRROR route — ακριβής αντιγραφή των θέσεων συγκεκριμένων
-- wallets που ορίζει ο χρήστης (/mirror). Κανόνες (ίδιοι με το σχέδιο του hermes-copyist):
-- σταθερό ποσό ανά αγορά (MIRROR_BUY_SOL, default 0.1), αντιγραφή ΚΑΘΕ αγοράς και κάθε
-- (μερικής) πώλησης στο ίδιο %, μία θέση ανά token, μόνο Pump.fun/PumpSwap, χωρίς gate,
-- χωρίς stop-loss (βγαίνουμε μόνο όταν βγαίνει εκείνος), paper πρώτα.
-- Ένα mirror wallet ΔΕΝ δίνει σήματα στο κανονικό argus (realtimeEntryHandler το αγνοεί)
-- και δεν απενεργοποιείται ποτέ αυτόματα από το scoring.

ALTER TABLE watchlist_wallets
  ADD COLUMN copy_mode TEXT NOT NULL DEFAULT 'signal'
    CONSTRAINT chk_watchlist_wallets_copy_mode CHECK (copy_mode IN ('signal', 'mirror'));

CREATE TABLE mirror_positions (
  id                 BIGSERIAL PRIMARY KEY,
  wallet_address     TEXT NOT NULL,
  token_address      TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  sol_in             NUMERIC NOT NULL DEFAULT 0,   -- ό,τι βάλαμε συνολικά (όλες οι αγορές)
  sol_out            NUMERIC NOT NULL DEFAULT 0,   -- ό,τι πήραμε συνολικά (όλες οι πωλήσεις)
  tokens_held        NUMERIC NOT NULL DEFAULT 0,
  buy_count          INTEGER NOT NULL DEFAULT 0,
  sell_count         INTEGER NOT NULL DEFAULT 0,
  target_tokens_est  NUMERIC,                      -- υπόλοιπο του wallet μετά το τελευταίο event
  last_price_sol     NUMERIC,                      -- SOL ανά token (PumpPortal), όχι USD
  pnl_sol            NUMERIC,
  pnl_pct            NUMERIC,
  close_reason       TEXT
);
-- Μία ανοιχτή θέση ανά token (δεύτερο mirror wallet στο ίδιο token → καταγράφεται, δεν παίζεται).
CREATE UNIQUE INDEX uq_mirror_positions_open_token ON mirror_positions (token_address) WHERE status = 'open';
CREATE INDEX idx_mirror_positions_wallet ON mirror_positions (wallet_address, opened_at);

-- ΚΑΘΕ trade event mirror wallet και τι κάναμε (buy / sell / ignored_*), για πλήρη ιχνηλασία.
CREATE TABLE mirror_events (
  id                 BIGSERIAL PRIMARY KEY,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  wallet_address     TEXT NOT NULL,
  token_address      TEXT NOT NULL,
  tx_type            TEXT NOT NULL,
  signature          TEXT NOT NULL,
  sol_amount         NUMERIC,
  token_amount       NUMERIC,
  new_token_balance  NUMERIC,
  pool               TEXT,
  price_sol          NUMERIC,
  action             TEXT NOT NULL,
  position_id        BIGINT REFERENCES mirror_positions(id),
  our_sol            NUMERIC,
  our_tokens         NUMERIC,
  sell_pct           NUMERIC,
  detail_json        JSONB,
  CONSTRAINT uq_mirror_events_signature UNIQUE (signature, wallet_address)
);
CREATE INDEX idx_mirror_events_wallet ON mirror_events (wallet_address, received_at);
CREATE INDEX idx_mirror_events_position ON mirror_events (position_id);

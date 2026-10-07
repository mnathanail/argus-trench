-- ArgusTrench — 2026-10-07: watchlist μόνο από wallets που κέρδισαν σε τοπ tokens.
-- wallet_winner_hits: ένα row ανά (wallet, νικητής token) όπου το wallet μπήκε νωρίς
-- (0.5–60′ μετά τη δημιουργία) και έβγαλε ≥3× / ≥ $300. Ανανεώνεται σε κάθε σάρωση.
-- winner_tokens: ποια τοπ tokens σαρώθηκαν και πότε (για να μην ξαναπληρώνουμε GMGN).
CREATE TABLE wallet_winner_hits (
  wallet_address  TEXT NOT NULL,
  token_address   TEXT NOT NULL,
  token_symbol    TEXT,
  token_ath_usd   NUMERIC,
  multiple        NUMERIC NOT NULL,
  profit_usd      NUMERIC,
  cost_usd        NUMERIC,
  entry_min       NUMERIC,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, token_address)
);
CREATE INDEX idx_wallet_winner_hits_seen ON wallet_winner_hits (first_seen_at);

CREATE TABLE winner_tokens (
  token_address   TEXT PRIMARY KEY,
  token_symbol    TEXT,
  ath_usd         NUMERIC,
  created_at_unix BIGINT,
  traders_seen    INTEGER NOT NULL DEFAULT 0,
  hits            INTEGER NOT NULL DEFAULT 0,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

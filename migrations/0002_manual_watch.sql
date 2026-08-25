-- ArgusTrench — manual wallet watching (score history / trend tracking)
-- watchlist_wallets.source ήδη υποστηρίζει 'manual' — καμία αλλαγή εκεί απαραίτητη.

CREATE TABLE wallet_score_history (
  id              BIGSERIAL PRIMARY KEY,
  wallet_address  TEXT NOT NULL REFERENCES watchlist_wallets(address),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  win_rate        NUMERIC(5,4),
  pnl_multiplier  NUMERIC(10,4),
  trade_count     INTEGER
);

CREATE INDEX idx_wallet_score_history_wallet
  ON wallet_score_history(wallet_address, recorded_at);

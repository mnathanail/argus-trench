-- ArgusTrench — initial schema
-- Βασισμένο στο σχεδιασμό που περιγράφεται στο CLAUDE.md

CREATE TABLE watchlist_wallets (
  id                BIGSERIAL PRIMARY KEY,
  address           TEXT NOT NULL UNIQUE,
  chain             TEXT NOT NULL DEFAULT 'sol',
  source            TEXT NOT NULL,                 -- smart_money / kol / manual
  win_rate          NUMERIC(5,4),
  pnl_multiplier    NUMERIC(10,4),
  trade_count       INTEGER,
  active            BOOLEAN NOT NULL DEFAULT true,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_at  TIMESTAMPTZ
);

CREATE TABLE decision_log (
  id                            BIGSERIAL PRIMARY KEY,
  token_address                 TEXT NOT NULL,
  chain                         TEXT NOT NULL DEFAULT 'sol',
  evaluated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  logic_version                 TEXT NOT NULL,
  gate_snapshot_json            JSONB NOT NULL,
  gate_passed                   BOOLEAN NOT NULL,
  gate_fail_reason              TEXT,
  trigger_type                  TEXT,              -- smart_money_buy / kol_call / none
                                                     -- kol_call: reserved για v2, ανενεργό στο v1
  trigger_wallet_address        TEXT REFERENCES watchlist_wallets(address),
  trigger_wallet_snapshot_json  JSONB,
  decision                      TEXT NOT NULL,      -- entered / skipped_gate / skipped_no_trigger / skipped_bankroll_limit
  decision_reason_text          TEXT,
  linked_trade_id               BIGINT
);

CREATE TABLE paper_trades (
  id                          BIGSERIAL PRIMARY KEY,
  decision_log_id             BIGINT NOT NULL REFERENCES decision_log(id),
  token_address                TEXT NOT NULL,
  chain                        TEXT NOT NULL DEFAULT 'sol',
  mode                         TEXT NOT NULL,       -- log_only / paper / live
  intended_size_pct            NUMERIC(5,4),
  bankroll_at_entry            NUMERIC(18,6),
  simulated_entry_price        NUMERIC(24,12),
  simulated_entry_amount_sol   NUMERIC(18,9),
  assumed_slippage_pct         NUMERIC(5,4),
  assumed_latency_ms           INTEGER,
  condition_orders_json        JSONB,
  entry_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                       TEXT NOT NULL DEFAULT 'open',   -- open / closed
  exit_reason                  TEXT,                -- tp_tier_1 / tp_tier_2 / trailing_stop / exit_signal / timeout
  exit_trigger_detail_json     JSONB,
  simulated_exit_price         NUMERIC(24,12),
  exit_at                      TIMESTAMPTZ,
  pnl_sol                      NUMERIC(18,9),
  pnl_pct                      NUMERIC(10,4),
  assumed_fees_pct             NUMERIC(5,4),
  pnl_net_pct                  NUMERIC(10,4)
);

ALTER TABLE decision_log
  ADD CONSTRAINT fk_decision_log_linked_trade
  FOREIGN KEY (linked_trade_id) REFERENCES paper_trades(id);

CREATE TABLE rejected_candidate_followup (
  id                                    BIGSERIAL PRIMARY KEY,
  decision_log_id                       BIGINT NOT NULL REFERENCES decision_log(id),
  checked_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
  price_change_pct_since_evaluation     NUMERIC(10,4),
  would_have_hit_profit_tier            BOOLEAN
);

CREATE INDEX idx_decision_log_token       ON decision_log(token_address);
CREATE INDEX idx_decision_log_evaluated   ON decision_log(evaluated_at);
CREATE INDEX idx_paper_trades_status      ON paper_trades(status);
CREATE INDEX idx_watchlist_active         ON watchlist_wallets(active);

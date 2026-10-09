-- ArgusTrench — 2026-10-09: «έξυπνη» βαθμολογία wallets (decision/walletScore.ts) + καταγραφή
-- κάθε αγοράς των wallets μας ανά token (για να μετρήσουμε το «2+ wallets στο ίδιο token»).

-- Μία γραμμή ανά wallet, ξαναϋπολογίζεται κάθε 5′ από τα κλειστά trades (καθαρά δεδομένα).
CREATE TABLE wallet_scores (
  wallet_address  TEXT PRIMARY KEY,
  trades          INTEGER NOT NULL,
  wins            INTEGER NOT NULL,
  weight          NUMERIC NOT NULL,   -- Σ βαρών απόσβεσης (≈ «ενεργά» trades)
  pnl_sol         NUMERIC NOT NULL,   -- άθροισμα σε SOL για 0.05 SOL/θέση (για ανάγνωση)
  mean_ret        NUMERIC NOT NULL,   -- εκτίμηση απόδοσης ανά trade (μετά από fees + κόστος εισόδου)
  sd_ret          NUMERIC NOT NULL,   -- αβεβαιότητα της εκτίμησης
  lcb_ret         NUMERIC NOT NULL,   -- κάτω όριο 80%
  ucb_ret         NUMERIC NOT NULL,   -- άνω όριο 90%
  slippage        NUMERIC NOT NULL,   -- κόστος εισόδου που υποθέσαμε για τα paper trades του
  status          TEXT NOT NULL,      -- proven / exploring / blocked
  reason          TEXT,
  last_trade_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Η ΠΡΩΤΗ αγορά κάθε wallet μας σε κάθε token (ό,τι κι αν έγινε μετά: trade, skip, μικρή αγορά),
-- με τη βαθμολογία του wallet εκείνη τη στιγμή. Οι επόμενες αγορές μόνο αυξάνουν buys/sol_total.
CREATE TABLE wallet_token_buys (
  token_address   TEXT NOT NULL,
  wallet_address  TEXT NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  buys            INTEGER NOT NULL DEFAULT 1,
  sol_total       NUMERIC NOT NULL DEFAULT 0,
  first_sol       NUMERIC,
  score_mean      NUMERIC,
  score_status    TEXT,
  PRIMARY KEY (token_address, wallet_address)
);
CREATE INDEX idx_wallet_token_buys_token_time ON wallet_token_buys (token_address, first_seen_at);

-- ArgusTrench — self-healing wallet-activity rotation
--
-- Το προηγούμενο round-robin (in-memory `nextWalletIndex` στο process) χάνεται σε κάθε
-- restart, και με ORDER BY added_at, τα πρώτα-προστεθέντα wallets (τα αρχικά manual)
-- ξαναπερνάνε πρώτα σε κάθε redeploy — τα πιο πρόσφατα smart_money wallets μπορεί να
-- μην προλαβαίνουν ποτέ να ελεγχθούν αν οι redeploys είναι συχνοί. Αντικαθίσταται με
-- selection βάσει "ποιος περιμένει περισσότερο" — self-healing, καμία κατάσταση να χαθεί.

ALTER TABLE watchlist_wallets ADD COLUMN last_activity_checked_at TIMESTAMPTZ;

-- 2026-09-29 — ρητή απόφαση χρήστη: καταγραφή του μέσου χρόνου κρατήματος κάθε wallet
-- (`portfolio stats` → pnl_stat.avg_holding_period, δευτερόλεπτα — ίδιο call με το scoring,
-- μηδενικό επιπλέον κόστος). Εύρημα ίδιας μέρας: wallets που πουλάνε σε < 2′ (snipers)
-- έδωσαν −0.34 SOL σε 187 αντιγραφές, όσα κρατάνε ≥ 2′ +0.09 SOL σε 42. Πρώτα καταγραφή
-- και κατανομή (`npm run wallet-holding-report`), μετά όριο για τη watchlist.
ALTER TABLE watchlist_wallets ADD COLUMN avg_holding_sec NUMERIC;
ALTER TABLE wallet_score_history ADD COLUMN avg_holding_sec NUMERIC;

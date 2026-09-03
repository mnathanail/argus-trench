-- ArgusTrench — προαιρετικό όνομα για wallets (π.χ. γνωστό public alias του κατόχου).
-- NULL για τα περισσότερα (ειδικά auto-discovered) — δεν ξέρουμε ποιος είναι.

ALTER TABLE watchlist_wallets ADD COLUMN name TEXT;

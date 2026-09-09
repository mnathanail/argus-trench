-- ArgusTrench — ζωντανό state για το event-driven exit μοντέλο (PumpPortal websocket).
--
-- Το σημερινό `resolveExit` δουλεύει με πλήρες ιστορικό candles σε ένα lookback — δεν
-- χρειάζεται να θυμάται τίποτα ανάμεσα σε κλήσεις. Το event-driven μοντέλο είναι
-- διαφορετικό: κάθε μεμονωμένο trade tick έρχεται μία φορά, πρέπει να θυμόμαστε το
-- υψηλότερο σημείο τιμής που έχουμε ήδη δει (peak_price_since_entry) και αν το trailing
-- έχει ήδη ενεργοποιηθεί (trailing_active), ώστε το ΕΠΟΜΕΝΟ tick να ξέρει πού βρισκόμαστε
-- χωρίς να χρειάζεται να ξαναδιαβάσει όλο το ιστορικό.
--
-- NULL/false για κάθε ήδη υπάρχον trade — το ήδη-υπάρχον periodic exit-resolver δεν τα
-- αγγίζει καθόλου, συνεχίζει να δουλεύει όπως πριν (παραμένει το δίχτυ ασφαλείας).

ALTER TABLE paper_trades ADD COLUMN peak_price_since_entry NUMERIC;
ALTER TABLE paper_trades ADD COLUMN trailing_active BOOLEAN NOT NULL DEFAULT false;

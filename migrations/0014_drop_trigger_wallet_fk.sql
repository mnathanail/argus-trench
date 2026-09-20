-- ArgusTrench — αφαίρεση FK constraint από decision_log.trigger_wallet_address
-- 2026-09-20 — προϋπόθεση για το νέο 'gmgn_smartmoney' trigger_type
-- (collectors/gmgnSmartMoney.ts): αυτό το κανάλι πυροδοτείται από GMGN's ΔΙΚΑ ΤΟΥ
-- tagged smart-money wallets (`track smartmoney`), ΟΧΙ από τη δική μας self-curated
-- watchlist_wallets — αυτά τα addresses ΔΕΝ είναι, και δεν πρέπει να είναι, μέσα σε
-- εκείνο τον πίνακα (θα μόλυνε τη σημασιολογία του watchlist_wallets.source, που
-- CLAUDE.md ορίζει αυστηρά ως smart_money/kol/manual — δικές μας, σκοραρισμένες ή
-- χειροκίνητα εμπιστευμένες εγγραφές).
--
-- Το αρχικό FK (migration 0001) είχε νόημα όσο ΚΑΘΕ trigger_wallet_address προερχόταν
-- αποκλειστικά από τη δική μας watchlist (layer 3: smart_money_buy). Τώρα που υπάρχει
-- δεύτερη, ανεξάρτητη πηγή σήματος εκτός αυτού του πίνακα, το constraint θα έκανε κάθε
-- INSERT ενός gmgn_smartmoney trigger να αποτυγχάνει με foreign-key violation.
--
-- Το column παραμένει TEXT, χωρίς αλλαγή τύπου — απλά δέχεται πλέον ΟΠΟΙΟΔΗΠΟΤΕ wallet
-- address, δικό μας ή όχι, ανάλογα με το trigger_type της ίδιας γραμμής. Οποιοδήποτε
-- μελλοντικό query πρέπει να φιλτράρει ρητά κατά trigger_type αν θέλει ΜΟΝΟ τα δικά μας
-- watchlist wallets, όχι να υποθέτει σιωπηλά ότι κάθε trigger_wallet_address υπάρχει
-- στο watchlist_wallets.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
    FROM pg_constraint
   WHERE conrelid = 'decision_log'::regclass
     AND contype = 'f'
     AND conkey = ARRAY[(
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'decision_log'::regclass AND attname = 'trigger_wallet_address'
     )];

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE decision_log DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

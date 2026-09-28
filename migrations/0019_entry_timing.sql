-- 2026-09-28 — μέτρηση ταχύτητας εισόδου (ρητό αίτημα χρήστη): πού πάει ο χρόνος από τη
-- στιγμή που βλέπουμε την αγορά του wallet μέχρι να ανοίξει το trade, και πόσο πληρώνουμε
-- σε τιμή γι' αυτό (τιμή σήματος vs εκτέλεσης). Γράφεται μία φορά στο openTrade για τα
-- realtime trades. Ανάλυση: `npm run entry-speed-report`.
ALTER TABLE paper_trades ADD COLUMN entry_timing_json JSONB;

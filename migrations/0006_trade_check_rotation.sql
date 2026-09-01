-- ArgusTrench — self-healing exit-resolver rotation
--
-- Το `ORDER BY entry_at ASC` (oldest-first) batching στο exit-resolver έχει το ίδιο
-- πρόβλημα που είχε το wallet-activity πριν τη migration 0005: αν οι παλαιότερες θέσεις
-- δεν είναι ακόμα κλείσιμες (δεν έφτασαν 24ω, κανένα tier), ο ίδιος μικρός πυρήνας
-- "κολλημένων" trades επιλέγεται ΣΕ ΚΑΘΕ κύκλο, εμποδίζοντας ΜΟΝΙΜΑ οποιοδήποτε νεότερο
-- trade να ελεγχθεί έστω και μία φορά. Επιβεβαιωμένο πραγματικό incident 2026-09-01:
-- `open=51 closed=0` σε 14 συνεχόμενους επιτυχημένους κύκλους, επί 8 ώρες, ΙΔΙΑ 5
-- tokens σε κάθε κύκλο. Ίδια λύση με τα wallets: rotation βάσει "ποιος περιμένει
-- περισσότερο", όχι στατική σειρά.

ALTER TABLE paper_trades ADD COLUMN last_checked_at TIMESTAMPTZ;

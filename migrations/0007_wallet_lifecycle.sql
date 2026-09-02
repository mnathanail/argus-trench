-- ArgusTrench — wallet lifecycle: auto-deactivate/reactivate βάσει score
--
-- Χρειάζεται να ξεχωρίσουμε "απενεργοποιήθηκε επειδή έπεσε το score" από "το έβγαλε ο
-- χρήστης χειροκίνητα με /unwatch" — αλλιώς ένα auto-reactivate θα μπορούσε να
-- παρακάμψει μια σκόπιμη χειροκίνητη απόφαση μόλις το score βελτιωθεί ξανά. Το
-- /unwatch παραμένει τελικό veto, ό,τι κι αν δείχνει το score μετά.

ALTER TABLE watchlist_wallets ADD COLUMN deactivated_reason TEXT;
-- NULL όταν active. 'manual' (μέσω /unwatch) ή 'below_threshold' (αυτόματο) όταν όχι.

-- Sticky kill-switch state για το live trading (2026-09-11). Ένα, μόνο row πάντα —
-- classic "singleton row" pattern. `halted_at IS NOT NULL` σημαίνει σταματημένο, ΜΕΝΕΙ
-- έτσι μέχρι χειροκίνητο reset (ρητή απόφαση χρήστη 2026-09-11: ΟΧΙ αυτόματη επαναφορά
-- μόλις σπάσει το σερί ζημιών — κάποιος πρέπει να δει γιατί έγιναν 3 ζημιές στη σειρά
-- πριν ξαναρχίσει, δεδομένου ότι είναι πλέον πραγματικό κεφάλαιο).
CREATE TABLE live_trading_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  halted_at TIMESTAMPTZ,
  halted_reason TEXT
);

INSERT INTO live_trading_state (id) VALUES (1);

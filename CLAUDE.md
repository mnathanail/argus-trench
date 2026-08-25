# ArgusTrench — GMGN / pump.fun Auto-Trading System — Project Memory

Repository: `argus-trench`

## Τι είναι αυτό
Σύστημα αυτόματου trading για Solana meme coins (pump.fun), βασισμένο στο GMGN skill
ecosystem (gmgn-cli), με στόχο: track wallets/tokens, entry/exit signals, phased rollout
από log-only έως live auto-trading.

## Αρχιτεκτονική — 6 layers
1. **Discovery & gate** — `gmgn-cli market trenches` με server-side min/max filters
   (rug_ratio, bundler_rate, insider_ratio, top_holder_rate, smart_degen_count,
   creator_created_open_ratio, twitter_rename_count). Αυτό ΕΙΝΑΙ το hard-gate — δε
   χτίζουμε δικό μας φιλτράρισμα πάνω από αυτό.
2. **Wallet curation** — standing, ανεξάρτητη διαδικασία, δύο παράλληλα μονοπάτια:
   - *Αυτόματο*: candidate wallets από `track smartmoney`/`kol` ή `token holders --tag
     smart_degen` πάνω σε ~20-30 πρόσφατα migrated/graduated tokens· wallets που
     εμφανίζονται σε >1 token βαραίνουν περισσότερο. Scoring μέσω `portfolio stats
     --wallet <addr>`, `active=true` μόνο αν `win_rate > 0.5 AND trade_count >= 15`
     (αποφεύγει false positives από 2-3 τυχερά trades). Weekly re-scoring.
   - *Χειροκίνητο*: ο χρήστης προσθέτει wallets που ήδη εμπιστεύεται — βλ. "Manual
     wallet watching" section παρακάτω.
   Και τα δύο αποθηκεύονται στο ίδιο `watchlist_wallets` table. ΔΕΝ εξαρτάται από
   "follow" μέσα στο GMGN UI.
3. **Signal triggers** — τομή των δύο παραπάνω ρευμάτων: trusted wallet (από τη λίστα
   μας) αγοράζει ένα token που έχει περάσει το gate. Πηγές: `track follow-wallet`
   (poll-based) + PumpPortal WebSocket `subscribeAccountTrade` (push, χαμηλό latency,
   συμπληρωματικό — όχι υποκατάστατο του GMGN).
4. **Exit decision** — δύο μηχανισμοί μαζί, όχι ένας:
   - Μηχανικό order τη στιγμή της αγοράς: `swap --condition-orders` με συνδυασμό
     `profit_stop` (fixed tier) + `profit_stop_trace` (trailing, με `drawdown_rate`).
   - Ενεργό exit-signal: `track smartmoney`/Smart Money Exit Signal — βγαίνεις όταν
     βγαίνουν τα wallets που ακολουθείς, ανεξάρτητα από τιμή.
5. **Εκτέλεση** — `gmgn-cli swap`. Ασφαλιστική δικλείδα: το `--yes` (headless mode)
   απαιτεί ρητά `GMGN_ALLOW_AUTOMATED_TRADES=1`. Αυτό ΕΙΝΑΙ το paper/live switch —
   μένει unset μέχρι Φάση 5.
6. **Καταγραφή & tuning** — Postgres (βλ. schema) + Telegram bot (υπάρχον stack).
   Feedback loop για backtesting/threshold tuning.

Σημείωση: layers 1-2 τρέχουν παράλληλα/συνεχώς ως background processes, όχι διαδοχικά
per-token. Layers 3-6 είναι το per-event pipeline.

## Decision philosophy (v1) — ΟΧΙ scoring/weighted model
Αποφασίστηκε ρητά να ΜΗΝ χρησιμοποιηθεί weighted score (αυθαίρετα βάρη). Αντ' αυτού:
- **Hard-gate cascade**: veto gates (security + dev reputation) — μη διαπραγματεύσιμα,
  καμία απόχρωση.
- **Wallet-following / consensus**: το entry trigger είναι κανόνας
  ("trusted wallet buy" + "πέρασε το gate" = entry), όχι αριθμητικό score.
- Scoring/ML model μπαίνει σε v2, ΜΟΝΟ αφού υπάρχουν πραγματικά labeled outcomes από
  το logging (όχι μαντεμένα βάρη σήμερα).

## Skills σε χρήση (από τα 40+ στο gmgn.ai/ai/skills_market)
- **Core v1 (25 skills)**: Token Security Check, Liquidity Pool Analysis, Top Holders,
  Dev Wallet Info, Dev Token Launch History, Token Overview, Wallet Holdings/P&L/Activity,
  Copy Trade Assessment, Pump.fun New/Near-Graduation Tokens, Token Kline Chart,
  Followed Wallet Activity, Smart Money Trades/Buy/Exit Signal, Buy with TP&SL,
  Trailing Take Profit/Stop Loss, Market/Limit Buy/Sell, Open/Cancel Order.
- **Deferred v2**: KOL Call/Trade Activity, Price Surge Signal (δεύτερο confirmation
  layer), OpenNews MCP, OpenTwitter MCP (narrative/sentiment layer), Top Traders,
  Smart Money/KOL Holders context, Migrated Tokens.
- **Skip**: Cooking/Launch skills (άλλη περίπτωση χρήσης — token deployment, όχι trading),
  Multi-Wallet Buy, Limit Buy/Sell (v1 είναι signal-triggered όχι price-triggered),
  Wallet Token Balance, Pump Claim Signal.

## Postgres schema — detailed logging design (v2, αντικαθιστά το απλό trade_log)
Βασική αρχή: καταγράφουμε ΚΑΘΕ candidate που αξιολογήθηκε, όχι μόνο ό,τι έγινε trade —
αλλιώς δεν υπάρχει τρόπος να μετρήσουμε αν τα gates είναι πολύ αυστηρά (χαμένοι winners)
ή πολύ χαλαρά, και το tuning στη Φάση 2-3 είναι τυφλό στο μισό πρόβλημα.

```sql
watchlist_wallets(address, chain, source, win_rate, pnl_multiplier, trade_count,
                   active, added_at, last_reviewed_at)

-- ΚΑΘΕ candidate που αξιολογήθηκε, trade ή όχι
decision_log(
  id, token_address, chain, evaluated_at,
  logic_version,                          -- tag των thresholds/κανόνων εκείνη τη στιγμή
  gate_snapshot_json,                     -- rug_ratio, bundler_rate, insider_ratio, top_holder_rate, smart_degen_count, creator_created_open_ratio, raw
  gate_passed,
  gate_fail_reason,                       -- π.χ. "rug_ratio 0.34 > max 0.2", null αν πέρασε
  trigger_type,                           -- smart_money_buy / kol_call / none (kol_call: reserved για v2, ανενεργό στο v1 — KOL Call Signal είναι Deferred)
  trigger_wallet_address,
  trigger_wallet_snapshot_json,           -- win_rate/pnl_multiplier ΤΗ ΣΤΙΓΜΗ εκείνη, όχι σήμερα
  decision,                               -- entered / skipped_gate / skipped_no_trigger / skipped_bankroll_limit
  decision_reason_text,                   -- human-readable, για γρήγορο scan / Telegram alert
  linked_trade_id                         -- FK, μόνο αν decision = entered
)

-- ΜΟΝΟ για ό,τι μπήκε
paper_trades(
  id, decision_log_id, token_address, chain, mode,       -- log_only / paper / live
  intended_size_pct, bankroll_at_entry,
  simulated_entry_price, simulated_entry_amount_sol,
  assumed_slippage_pct, assumed_latency_ms,               -- τίμιο paper trading = μοντελοποιεί καθυστέρηση, όχι instant fill
  condition_orders_json,                                  -- το exit plan που μπήκε τη στιγμή του entry
  entry_at, status,
  exit_reason,                                            -- tp_tier_1 / tp_tier_2 / trailing_stop / exit_signal / timeout
  exit_trigger_detail_json,                                -- π.χ. ποιο wallet έβγαλε το exit_signal
  simulated_exit_price, exit_at,
  pnl_sol, pnl_pct, assumed_fees_pct, pnl_net_pct
)

-- follow-up σε ό,τι ΔΕΝ πήραμε, για να μετράμε false negatives
rejected_candidate_followup(
  decision_log_id, checked_at,            -- π.χ. +1h, +24h μετά την αξιολόγηση
  price_change_pct_since_evaluation,
  would_have_hit_profit_tier              -- bool: θα κερδίζαμε αν το παίρναμε;
)
```
`decision_log` είναι το πιο κρίσιμο table — καταγράφει ΚΑΙ τα trades ΚΑΙ τα skipped
candidates, ώστε το backtesting/tuning να βλέπει ολόκληρη την εικόνα από την πρώτη μέρα,
όχι μόνο τη μεροληπτική όψη των όσων εκτελέστηκαν.

## Manual wallet watching (χρήστης-provided, migration 0002)
Πέρα από το αυτόματο discovery, ο χρήστης μπορεί να προσθέσει wallets που θέλει να
παρακολουθεί απευθείας:
- **Πώς μπαίνουν**: Telegram bot commands `/watch <address>` (source='manual',
  active=true αμέσως — ΔΕΝ περνάει το αυτόματο threshold win_rate/trade_count,
  εμπιστευόμαστε την κρίση του χρήστη) και `/unwatch <address>`.
- **Score πάντα από GMGN, όχι cached μόνιμα**: κάθε manual wallet ξανα-σκοράρεται
  (`portfolio stats`) σε ΚΑΘΕ polling κύκλο (όχι weekly όπως τα auto-discovered).
  Καταγράφεται σε νέο table `wallet_score_history` ώστε να φαίνεται τάση, όχι μόνο
  στιγμιότυπο:
  ```sql
  wallet_score_history(id, wallet_address, recorded_at,
                        win_rate, pnl_multiplier, trade_count)
  ```
- **Ορατότητα**: `/score <address>` on-demand μέσω Telegram (δείχνει και το trend από
  το history table). Επιπλέον, proactive alert όταν το score ενός manual wallet πέσει
  κάτω από το ίδιο floor του auto-discovery (win_rate < 0.5) — προτείνει review, ΔΕΝ
  το απενεργοποιεί μόνο του (ο χρήστης αποφασίζει για ό,τι πρόσθεσε ο ίδιος).
- "Real-time" εδώ σημαίνει: στην ίδια συχνότητα polling με το υπόλοιπο σύστημα — το
  GMGN `portfolio stats` δεν έχει websocket/push endpoint, άρα δεν υπάρχει true
  streaming score.

## Phased rollout
0. Setup & instrumentation (API key, plugin install, logging σκελετός)
1. Read-only signal collection (καμία συναλλαγή, μόνο logging)
2. Backtesting & threshold tuning πάνω σε πραγματικά logged δεδομένα
3. Paper trading (πλήρες decision engine, simulated fills)
4. Μικρό live κεφάλαιο (αυστηρό position sizing)
5. Σταδιακή κλιμάκωση

## Bankroll management (το πραγματικό lever, όχι τα signals) — επιβεβαιωμένα νούμερα
~98.6% των pump.fun tokens καταρρέουν κάτω από ελάχιστη liquidity — κανένα φίλτρο δεν
εξαφανίζει αυτό το base rate, μόνο το μειώνει. Guardrails:
- **1% του κεφαλαίου ανά θέση**, fixed-fractional (ΠΟΤΕ αυξανόμενο μετά από wins —
  αυτό θα ήταν martingale-style sizing, αντίθετο με 98.6% failure rate). Ανεβαίνει
  ΜΟΝΟ αφού η Φάση 2 (backtesting) δείξει μετρήσιμο edge, όχι επειδή "πάει καλά".
- **Concurrent positions cap: 5-10 σε paper trading**, για breadth (χρειάζεσαι όγκο
  ώστε να μη μπερδεύεις κακή τύχη με κακή στρατηγική). **1-2 ξεχωριστά, χαμηλότερο
  cap στη Φάση 4 (μικρό live κεφάλαιο)** — πρώτα επιβεβαιώνεις ότι η live εκτέλεση
  ταιριάζει με τις παραδοχές του paper mode, πριν ανοίξεις πολλαπλές θέσεις με
  πραγματικά λεφτά.
- Daily loss circuit breaker, μόνιμα ενεργό — ακριβές ποσοστό παραμένει ανοιχτό.
- Όλα τα παραπάνω config values, δεμένα με το `logic_version` του `decision_log` —
  όταν αλλάζουν μετά το backtesting, το ιστορικό δείχνει ποιοι κανόνες ίσχυαν ανά trade.

## Υπάρχον stack (να ενσωματωθεί, όχι να αντικατασταθεί)
Railway (hosting) · PostgreSQL · Telegram bot (alerts) · Helius WebSocket (διαθέσιμο ως
backup/redundancy, όχι απαραίτητο πλέον για pump.fun discovery — το καλύπτει το GMGN
trenches) · PumpPortal WebSocket `subscribeAccountTrade` (νέο, για low-latency wallet
triggers, συμπληρωματικό στο GMGN).

## Ό,τι μένει ακόμα ανοιχτό
- **Daily loss circuit breaker**: η αρχή είναι επιβεβαιωμένη (μόνιμα ενεργό), το
  ακριβές ποσοστό όχι ακόμα.
Τα υπόλοιπα (bankroll %, watchlist bootstrap, concurrent caps) επιβεβαιώθηκαν — βλ.
"Bankroll management" και "Wallet curation" (layer 2) παραπάνω.

## Runtime & environment variables (πρόταση προς επιβεβαίωση στην πρώτη session)
- **Runtime**: Node.js/TypeScript — ταιριάζει με το gmgn-cli (npm package) και το δικό
  σου υπάρχον skillset. ΔΕΝ έχει ρητά επιβεβαιωθεί μέσα στη συζήτηση — απλά η προφανής
  προεπιλογή. Επιβεβαίωσε ή άλλαξέ το στην πρώτη Claude Code session.
- **Project `.env`**: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `GMGN_ALLOW_AUTOMATED_TRADES`
  (unset/false by default — αυτό είναι το paper/live switch).
- **ΟΧΙ στο project `.env`**: το `GMGN_API_KEY` δε ζει εκεί. Το `gmgn-cli` διαχειρίζεται
  το δικό του config global, στο `~/.config/gmgn/.env`, μέσω `config --apply <key>` —
  ανεξάρτητο από το project. Αν αργότερα κληθεί το GMGN REST απευθείας αντί για το CLI
  (βλ. σημείωση στο layer "Εκτέλεση"), τότε θα χρειαστεί ΚΑΙ στο project `.env`.
- **Telegram bot**: να επιβεβαιωθεί αν επαναχρησιμοποιείται το bot/token του υπάρχοντος
  pump.fun project ή αν φτιάχνεται νέο — ανάμειξη alerts από δύο projects στο ίδιο bot
  μπορεί να μπερδεύει.

## Setup που μένει χειροκίνητο (μία φορά)
Λογαριασμός GMGN → `gmgn-cli config` (Ed25519 keypair + link) → `config --apply <key>`
→ binding trading wallet. Τίποτα άλλο δε χρειάζεται χειροκίνητο κλικ μέσα στο GMGN UI —
το wallet curation ζει εξ ολοκλήρου στο δικό μας Postgres.

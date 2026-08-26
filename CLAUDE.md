# ArgusTrench — GMGN / pump.fun Auto-Trading System — Project Memory

Repository: `argus-trench`

## Τι είναι αυτό
Σύστημα αυτόματου trading για Solana meme coins (pump.fun), βασισμένο στο GMGN skill
ecosystem (gmgn-cli), με στόχο: track wallets/tokens, entry/exit signals, phased rollout
από log-only έως live auto-trading.

## Αρχιτεκτονική — 6 layers
1. **Discovery & gate** — `gmgn-cli market trenches` με server-side min/max filters
   (rug_ratio, bundler_rate, insider_ratio, top_holder_rate, smart_degen_count,
   creator_created_open_ratio, twitter_rename_count). Όλα ΕΠΙΒΕΒΑΙΩΜΕΝΑ ως πραγματικά
   flags — βλ. "Verified CLI contract". Αυτό ΕΙΝΑΙ το hard-gate.
   **Δύο calls ανά κύκλο, όχι ένα** (μετρημένο 2026-08-25, `near_completion` / sol):
   - *Gated call* → το actionable candidate set. Το server-side filtering φτάνει πολύ
     βαθύτερα στο pool: 60 qualifying Pump.fun tokens, ενώ το ungated window περιείχε
     μόνο 15 από αυτά. Χωρίς αυτό χάνουμε 4× candidates.
   - *Ungated call* → η ΜΟΝΗ πηγή `skipped_gate` rows. Το gated response επιστρέφει
     αποκλειστικά survivors· τα κομμένα tokens δεν εμφανίζονται πουθενά. Εφαρμόζουμε τα
     ίδια thresholds client-side πάνω στο window και γράφουμε ΚΑΙ passes ΚΑΙ fails.

   Άρα το "δε χτίζουμε δικό μας φιλτράρισμα" ισχύει για το τι **εκτελούμε**, όχι για το
   τι **καταγράφουμε** — αλλιώς το `decision_log` δε γράφει ποτέ skipped_gate και το
   tuning της Φάσης 2 μένει τυφλό (βλ. `candidate_source`, migration 0003).
   Φάση 1: **`--launchpad-platform Pump.fun` μόνο** — ένα launchpad, καθαρότερο dataset.
2. **Wallet curation** — standing, ανεξάρτητη διαδικασία, δύο παράλληλα μονοπάτια:
   - *Αυτόματο*: candidate wallets από `track smartmoney`/`kol` ή `token holders --tag
     smart_degen` πάνω σε ~20-30 πρόσφατα migrated/graduated tokens· wallets που
     εμφανίζονται σε >1 token βαραίνουν περισσότερο. Scoring μέσω `portfolio stats
     --wallet <addr>`, `active=true` μόνο αν `win_rate > 0.5 AND trade_count >= 15`
     (αποφεύγει false positives από 2-3 τυχερά trades). Σχεδιασμός: weekly re-scoring
     ειδικά για τα auto-discovered, ξεχωριστά/πιο αργά από τα manual — **δεν έχει
     υλοποιηθεί ακόμα**, γιατί δεν υπάρχει καν collector που να παράγει auto-discovered
     wallets σήμερα (το `track smartmoney`/`kol` discovery του παραπάνω παραγράφου
     είναι ακόμα ανοιχτό). Μέχρι να χτιστεί, το ενιαίο scoring loop (βλ. "Manual wallet
     watching" → `wallet_score_history`) σκοράρει ΟΠΟΙΟΔΗΠΟΤΕ active wallet, όποιου
     source, στο ίδιο interval — άρα το table δεν είναι manual-only, ανεξάρτητα από
     αυτό το ανοιχτό σχέδιο για διαφορετική cadence ανά source.
     ⚠️ **Το `portfolio stats` ΔΕΝ κάνει batch** (δοκιμασμένο 2026-08-25, και με
     `--wallet A B` και με `--wallet A --wallet B`): επιστρέφει ένα object, μόνο για το
     πρώτο wallet, παρά το help text "supports multiple wallets". Άρα το scoring κοστίζει
     **3 weight ανά wallet**. Το `portfolio profits` όντως κάνει batch (`{list:[...]}`,
     1–100 wallets, weight 3) αλλά **δεν** περιέχει `pnl_stat`, δηλαδή δεν δίνει win rate —
     άρα δεν υποκαθιστά το `stats` για τον κανόνα μας. Το per-cycle re-scoring είναι
     ρεαλιστικό όσο η watchlist είναι μικρή, όχι επειδή μπαίνουν σε ένα call.
   - *Χειροκίνητο*: ο χρήστης προσθέτει wallets που ήδη εμπιστεύεται — βλ. "Manual
     wallet watching" section παρακάτω.
   Και τα δύο αποθηκεύονται στο ίδιο `watchlist_wallets` table. ΔΕΝ εξαρτάται από
   "follow" μέσα στο GMGN UI.
3. **Signal triggers** — τομή των δύο παραπάνω ρευμάτων: trusted wallet (από τη λίστα
   μας) αγοράζει ένα token που έχει περάσει το gate.
   ⚠️ **Το `track follow-wallet` ΔΕΝ κάνει γι' αυτό** (επιβεβαιωμένο 2026-08-25): το
   resolve-άρει τη λίστα από τα follows του GMGN account που είναι δεμένο στο API key,
   δηλαδή εξαρτάται από το GMGN UI — αυτό που ρητά απορρίπτουμε στο layer 2. Θέλει και
   signed auth. Το `track smartmoney`/`kol` μένει χρήσιμο, αλλά για GMGN-tagged wallets,
   όχι για τη λίστα μας.
   Πηγή για ΤΑ ΔΙΚΑ ΜΑΣ wallets: **`portfolio activity --wallet <addr> --type buy`,
   polled ανά wallet** (paginated, με `next` cursor). Κόστος 1 request/wallet/κύκλο αντί
   για 1 συνολικά — μπαίνει στα μαθηματικά του rate limit, βλ. "Verified CLI contract".
   Συμπληρωματικά: PumpPortal WebSocket `subscribeAccountTrade` (push, χαμηλό latency —
   όχι υποκατάστατο του GMGN, και όχι πριν υπάρχει δουλεύον pipeline).
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

## Verified CLI contract (gmgn-cli 1.5.8, επιβεβαιωμένο 2026-08-25)
Ό,τι είναι εδώ έχει επαληθευτεί με πραγματικά calls, όχι διαβασμένο από docs. Τα skills
(`.agents/skills/`) περιγράφουν το **raw API**· το CLI κανονικοποιεί αλλού.

**Setup**: `npm install -g gmgn-cli` (global, όχι project dep) → `gmgn-cli config --check`
(exit 0 = ok, 1 = unconfigured) → `gmgn-cli config` (γεννά Ed25519 keypair, δίνει URL) →
`gmgn-cli config --apply <KEY>`. Γράφει `~/.config/gmgn/.env` (`GMGN_API_KEY` +
`GMGN_PRIVATE_KEY`) και `~/.config/gmgn/keypair.pem`, perms 600.

**Παγίδες όπου το documentation διαφωνεί με την πραγματικότητα:**
- Το response key είναι **`near_completion`**, ΟΧΙ `pump`. Το skill doc δηλώνει
  κατηγορηματικά το αντίθετο ("always returns this category under the key `pump`").
  Κώδικας γραμμένος από το doc θα διάβαζε σιωπηλά `undefined`.
- Top-level keys χωρίς `data` wrapper: `{ new_creation, near_completion, completed }`.
- **Το `--limit` αγνοείται** — ζήτησα 3, πήρα 60. Response ~250KB, 89 fields/item.
  Το payload size δεν είναι ελέγξιμο.
- **`private_vault_hold_rate` είναι 0 σε όλα τα results** — άχρηστο ως filter.
- Τα numeric fields στο `trenches` είναι JSON **numbers**. Στο `portfolio activity` όμως
  τα `token_amount` / `cost_usd` / `price_usd` είναι **strings**, και στο `kline` τα prices
  επίσης strings. **Μη γενικεύεις ανά driver — είναι ανά endpoint.** Ο adapter έχει μία
  `toNumber` που δέχεται και τα δύο.
- Στο `portfolio activity` τα πεδία είναι **`event_type`** και **`tx_hash`** — το doc λέει
  `type` και `transaction_hash`. Το `timestamp` είναι number (unix seconds).
- **Ο αριθμός των fields δεν είναι σταθερός**: το ίδιο `trenches` call έδωσε 89 fields/item
  και λίγο αργότερα 97. Γι' αυτό κρατάμε το `raw` αυτούσιο στο `gate_snapshot_json` και
  επικυρώνουμε μόνο ό,τι χρησιμοποιούμε.

**Flag → field mapping** (τα ονόματα ΔΕΝ ταιριάζουν, ο adapter θέλει ρητό table):

| Filter flag | Field στο response |
|---|---|
| `--max-top-holder-rate` | `top_10_holder_rate` |
| `--max-insider-ratio` | `suspected_insider_hold_rate` |
| `--max-bundler-rate` | `bundler_trader_amount_rate` |
| `--max-rug-ratio` | `rug_ratio` |
| `--min-smart-degen-count` | `smart_degen_count` |
| `--max-creator-created-open-ratio` | `creator_created_open_ratio` |
| `--max-twitter-rename-count` | `twitter_rename_count` |

**Rate limits** — leaky bucket `rate=20 capacity=20`, **κοινός σε όλα τα routes** (άρα ένα
βαρύ poll κλέβει budget από τα άλλα). Weights: `trenches` 3, `signal` 3, `hot-searches` 3,
`kline` 2, `trending` 1, `search` 1, `portfolio activity` 3, `portfolio stats` 3,
`portfolio profits` 3, `portfolio holdings` 5, `portfolio info` 1, `track smartmoney` 1,
`track kol` 1, `track follow-wallet` 3.
Το two-call discovery κοστίζει 6/κύκλο. Ακριβά είναι τα per-wallet routes: `portfolio
activity` **και** `portfolio stats` είναι weight 3 **ανά wallet** και κανένα από τα δύο δε
κάνει batch. 50 wallets σε activity = 150 weight = 7.5s στο πλήρες rate· άλλα 150 αν
σκοράρουμε τα ίδια. Μόνο το `portfolio profits` κάνει πραγματικά batch (100 wallets,
weight 3) — αλλά δίνει P&L, όχι win rate.
Πρακτικός κανόνας: το budget των 20/s το τρώνε τα wallets, όχι το discovery. Στο 429: διάβασε `X-RateLimit-Reset` header ή `reset_at` στο body.
**ΜΗΝ κάνεις naive retry** — κάθε request μέσα στο cooldown επεκτείνει το ban κατά 5s,
έως 5 λεπτά. Ο adapter θέλει token bucket, όχι retry loop.

**IPv6 δεν υποστηρίζεται** — δίνει 401/403 με σωστά credentials. Έλεγχος πριν το Railway
deploy: αν το `https://ipv6.icanhazip.com` απαντά, το outbound βγαίνει από IPv6.

**`portfolio stats` — η σημασιολογία του scoring (κρίσιμο, επιβεβαιωμένο 2026-08-25):**
- Το win rate **ΔΕΝ** είναι top-level `win_rate`· είναι **`pnl_stat.winrate`**.
- Υπολογίζεται πάνω σε **tokens/θέσεις, όχι σε trades**: τα buckets `pnl_lt_nd5_num`,
  `pnl_nd5_0x_num`, `pnl_0x_2x_num`, `pnl_2x_5x_num`, `pnl_gt_5x_num` αθροίζουν ακριβώς
  σε `pnl_stat.token_num` (μετρημένο: 0+497+549+16+4 = 1066 = token_num).
- Άρα το `trade_count >= 15` του κανόνα μας δένει με **`pnl_stat.token_num`**, ΟΧΙ με
  `buy + sell`. Στο ίδιο wallet: token_num 1066 vs buy+sell 5080. Αν βάζαμε το δεύτερο,
  αριθμητής και παρονομαστής θα μέτραγαν διαφορετικά πράγματα και το threshold θα ήταν
  ~5× χαλαρότερο απ' όσο νομίζουμε.
- ⚠️ **Το `pnl_multiplier` του schema είναι misnomer**: η πηγή είναι `realized_profit_pnl`,
  που είναι **ratio/ROI** (0.3264 = +32.6%), όχι πολλαπλασιαστής (θα ήταν 1.33). Το
  αποθηκεύουμε ως έχει. Αν κάποτε το διαβάσει κώδικας ως multiplier, θα υποτιμήσει
  δραματικά — δεν μετονομάστηκε για να μη σπάσει το υπάρχον schema, αλλά ΠΡΟΣΟΧΗ.
- Χρήσιμο bonus: `pnl_stat.avg_holding_period` (δευτερόλεπτα) ξεχωρίζει sniper bot από
  πραγματικό trader· τα pnl buckets δίνουν κατανομή, όχι μόνο μέσο όρο.

**Fields που δεν ήταν στο αρχικό σχέδιο και αξίζουν σκέψη ως gate v2** (υπάρχουν και ως
`--min-*`/`--max-*` flags): `entrapment_ratio`, `top70_sniper_hold_rate`,
`fresh_wallet_rate`, `bot_degen_rate`/`bot_count`, `dev_team_hold_rate`, `progress`
(bonding curve), `--min-created`/`--max-created` (ηλικία token, unit suffix υποχρεωτικό:
`30s`/`5m`). Copycat detection: `twitter_dup`, `website_dup`, `telegram_dup`, `image_dup`,
`twitter_rename_count`, `twitter_del_post_token_count`. Dev reputation: `fund_from_address`
(πηγή χρηματοδότησης creator), `creator_token_status`, `is_wash_trading`, `cto_flag`.
Υπάρχει και `--filter-preset safe|smart-money|strict` — το `strict` είναι σχεδόν το gate μας.

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
  decision,                               -- entered / signal_logged / skipped_gate / skipped_no_trigger / skipped_bankroll_limit
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

**Το `decision` δεν έχει CHECK constraint** — είναι TEXT με σχόλιο. Γι' αυτό προστέθηκε η
τιμή **`signal_logged`** χωρίς migration: στη Φάση 1 ο κανόνας εισόδου ενεργοποιείται
(gate πέρασε ΚΑΙ trusted wallet αγόρασε) αλλά δεν εκτελείται συναλλαγή. Το
`skipped_no_trigger` γίνεται ψευδές μόλις υπάρχει trigger, και το `entered` θα υπονοούσε
θέση που δεν άνοιξε ποτέ. Στη Φάση 3 αυτά τα rows είναι ακριβώς το σύνολο που θα γινόταν
`entered` με paper trade.

**Migration 0004 (collector state):**
- **Unique index `(token_address, logic_version, candidate_source)`** — ένα row ανά
  candidate ανά πηγή παρατήρησης, ΟΧΙ ανά poll tick. Ένα token μένει στο trenches για ώρες,
  άρα χωρίς dedup το `decision_log` θα μέτραγε poll ticks. Το `candidate_source` ανήκει στο
  κλειδί: ένα token εμφανίζεται και στο gated και στο ungated call, και αν dedup-άραμε μόνο
  σε (token, version) η μία παρατήρηση θα χανόταν, χαλώντας το pass-rate εκείνης της πηγής.
- `last_evaluated_at` + `evaluation_count` — πόσες φορές το ξαναείδαμε, χωρίς πλήρη
  χρονοσειρά. Το `evaluated_at` μένει «πρώτη φορά».
- `watchlist_wallets.last_seen_tx_hash` / `last_seen_activity_at` — cursor του activity
  polling. Χωρίς αυτό κάθε κύκλος ξανα-παράγει τα ίδια buys ως νέα triggers.
- Ο upsert έχει `WHERE decision <> 'entered'`: μόλις ένα row δεθεί με πραγματικό trade,
  επόμενος κύκλος δε πρέπει να το γυρίσει σε `skipped_*` και να αφήσει ορφανό trade.

**Migration 0003 πρόσθεσε `candidate_source`** (`gated_pool` / `sample_window`, NOT NULL
χωρίς default, με CHECK). Είναι απαραίτητο λόγω του two-call design του layer 1: τα δύο
calls ΔΕΝ έχουν την ίδια στατιστική σημασία. Το `gated_pool` δίνει survivors από όλο το
βάθος του pool αλλά μηδενική ορατότητα στους rejects· το `sample_window` δίνει και τα δύο
αλλά είναι sample, όχι πλήρης πληθυσμός. Χωρίς τη στήλη, η Φάση 2 θα υπολόγιζε pass-rate
πάνω σε ανάμεικτα sampling frames και θα έβγαζε λάθος συμπέρασμα για το πόσο αυστηρά
είναι τα gates.

## Manual wallet watching (χρήστης-provided, migration 0002)
Πέρα από το αυτόματο discovery, ο χρήστης μπορεί να προσθέσει wallets που θέλει να
παρακολουθεί απευθείας:
- **Bot**: `@shitcoin_intel_bot` ("Shitcoin Intel"). **Προϋπήρχε** — δεν φτιάχτηκε νέο, και
  ο χρήστης επιβεβαίωσε 2026-08-25 ότι αυτό είναι το σωστό, doubly confirmed 2026-08-26.
  Αναθεωρεί την προηγούμενη απόφαση "νέο bot" — παλιότερη, ασύμφωνη σημείωση στο
  "Runtime & environment variables" διορθώθηκε στο ίδιο commit. Αν αργότερα μπερδεύονται
  alerts με άλλο σύστημα στο ίδιο chat, το
  ξεχωρίζουμε τότε.
- **Authorization — fail closed**: το `TELEGRAM_CHAT_ID` είναι allowlist (comma-separated)
  και **κενό σημαίνει κανείς, όχι όλοι**. Το bot username είναι ανακαλύψιμο, οποιοσδήποτε
  μπορεί να του γράψει, και τα `/watch`/`/unwatch` γράφουν στη watchlist που τροφοδοτεί τα
  entry signals — δηλαδή ένα ανοιχτό bot είναι μονοπάτι για να βάλει τρίτος τα wallets του
  στη στρατηγική μας. Σε μη εξουσιοδοτημένο chat **δεν απαντάμε καθόλου** (μια απάντηση
  επιβεβαιώνει ότι το bot υπάρχει και ποιος το έχει) — μόνο log.
- **Πώς μπαίνουν**: Telegram bot command `/watch <address>` (source='manual',
  active=true αμέσως — ΔΕΝ περνάει το αυτόματο threshold win_rate/trade_count,
  εμπιστευόμαστε την κρίση του χρήστη). Το `/watch` κάνει πρώτα το upsert και μετά το
  scoring: αν το GMGN είναι κάτω, το wallet μπαίνει παρά ταύτα — το score είναι
  πληροφορία, όχι προϋπόθεση.
- **`/unwatch <address>` δουλεύει σε ΟΠΟΙΟΔΗΠΟΤΕ wallet, ανεξαρτήτως source**
  (διορθώθηκε 2026-08-26 — δεν ήταν ποτέ περιορισμένο στο repository layer, αλλά η
  τεκμηρίωση το περιέγραφε σαν manual-only εντολή). Λειτουργεί ως χειροκίνητο
  override/veto: ακόμα και ένα auto-discovered wallet που πέρασε το algorithmic
  threshold (`win_rate > 0.5 AND trade_count >= 15`) μπορεί να απενεργοποιηθεί
  χειροκίνητα. Το ιστορικό score παραμένει.
- ⚠️ **`wallet_score_history` καταγράφει ΚΑΘΕ re-score, ΟΠΟΙΟΥΔΗΠΟΤΕ active wallet —
  ΟΧΙ μόνο manual** (διορθώθηκε 2026-08-26· προηγούμενη διατύπωση εδώ έλεγε λάθος ότι
  το table είναι για τα manual wallets). Το layer 2 scoring loop σκοράρει ΟΛΑ τα
  active wallets σε κάθε κύκλο (`portfolio stats`, όχι cached μόνιμα), ανεξαρτήτως αν
  μπήκαν χειροκίνητα ή μέσω του αυτόματου discovery:
  ```sql
  wallet_score_history(id, wallet_address, recorded_at,
                        win_rate, pnl_multiplier, trade_count)
  ```
  Μία ξεχωριστή, πιο αργή (weekly) διαδικασία re-scoring αποκλειστικά για τα
  auto-discovered — όπως περιγράφεται στο "Αυτόματο" μονοπάτι του layer 2 πιο πάνω —
  **δεν έχει υλοποιηθεί ακόμα** (δεν υπάρχει καν collector που να παράγει
  auto-discovered wallets σήμερα). Μέχρι τότε, ΟΛΑ τα active wallets περνάνε από το
  ίδιο loop, στο ίδιο interval.
- **Ορατότητα**: `/score <address>` on-demand (δείχνει trend από το history table).
  `/watchlist` (alias: `/list`) λιστάρει ΟΛΑ τα active wallets — address, source, win
  rate, pnl, πλήθος θέσεων — ώστε να φαίνεται τι υπάρχει πριν αποφασίσεις `/unwatch`
  σε κάτι. Επιπλέον, proactive alert όταν το score ΟΠΟΙΟΥΔΗΠΟΤΕ active wallet πέσει
  κάτω από το floor του auto-discovery (win_rate < 0.5) — προτείνει review, ΔΕΝ
  το απενεργοποιεί μόνο του (ο χρήστης αποφασίζει, ακόμα και για wallets που δεν
  πρόσθεσε ο ίδιος — βλ. `/unwatch` παραπάνω).
- "Real-time" εδώ σημαίνει: στην ίδια συχνότητα polling με το υπόλοιπο σύστημα — το
  GMGN `portfolio stats` δεν έχει websocket/push endpoint, άρα δεν υπάρχει true
  streaming score.

## Phased rollout
0. ✅ Setup & instrumentation (API key, plugin install, logging σκελετός) — **έγινε**
1. 🚧 Read-only signal collection (καμία συναλλαγή, μόνο logging) — **υλοποιημένο**:
   3 collector loops (discovery 30s, wallet-activity 60s, wallet-scoring 300s) σε ένα
   process με κοινό cooldown, `logic_version = gate-v1-<hash των thresholds>`.
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

## Runtime & environment variables (ΕΠΙΒΕΒΑΙΩΜΕΝΑ 2026-08-25)
- **Runtime**: Node.js/TypeScript, ESM, strict. Επιβεβαιώθηκε. Deps σκόπιμα ελάχιστα:
  `pg` + `dotenv` + **`gmgn-cli`** (pinned exact `1.5.8`, όχι `^` — το contract του
  "Verified CLI contract" πιο πάνω είναι δεμένο σε αυτή την έκδοση, οπότε auto-upgrade
  θα μπορούσε να αλλάξει σιωπηλά συμπεριφορά που έχουμε ήδη τεκμηριώσει). **Tests:
  `node:test`** (built-in, μηδέν deps) — όχι vitest/jest.
  ⚠️ Το `gmgn-cli` είναι **regular dependency, ΟΧΙ global install** (διορθώθηκε
  2026-08-26 — ήταν global στο dev μηχάνημα, που θα έσπαγε σε Railway build χωρίς global
  npm state). Ο adapter (`src/gmgn/exec.ts`) λύνει το binary path module-relative
  (`node_modules/.bin/gmgn-cli`), όχι μέσω PATH — γιατί αν το process ξεκινήσει χωρίς
  `npm run`/`npm start` (π.χ. απευθείας `node dist/main.js`), το `node_modules/.bin` δεν
  είναι εγγυημένα στο PATH. Test κλειδώνει ότι το binary υπάρχει μετά `npm install`.
- **Process topology**: **ένα** Node process με internal scheduler για όλα (pollers, bot),
  όχι ξεχωριστά Railway services. Το σπάμε όταν υπάρξει πραγματικός λόγος κλιμάκωσης.
- **Deploy**: GitHub push στο `master` → Railway auto-deploy. Pre-deploy command
  `npm run migrate:prod` (compiled `dist/`, γιατί το `tsx` είναι devDependency και
  κόβεται στο production install). Commits **απευθείας στο master**, χωρίς branches.
- **Project `.env`** (τοπικά): `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `GMGN_ALLOW_AUTOMATED_TRADES` (unset/false by default — αυτό είναι το paper/live
  switch). Το `GMGN_API_KEY`/`GMGN_PRIVATE_KEY` ΔΕΝ μπαίνουν εδώ τοπικά — το `gmgn-cli`
  διαχειρίζεται δικό του config global, στο `~/.config/gmgn/.env`, μέσω
  `config --apply <key>`, ανεξάρτητο από το project.
- ⚠️ **Railway variables (διορθώθηκε 2026-08-26 — παλαιότερα εδώ έλεγε ότι δε
  χρειάζονται ποτέ στο project env, λάθος για production):** `GMGN_API_KEY` και
  `GMGN_PRIVATE_KEY` ΠΡΕΠΕΙ να μπουν ως Railway environment variables. Ένα ephemeral
  container δεν έχει persistent `~/.config`, και δεν υπάρχει interactive βήμα εκεί για
  `config --apply`. Επιβεβαιωμένο με άδειο `HOME`: το `gmgn-cli` διαβάζει αυτές τις δύο
  μεταβλητές απευθείας από process env αν υπάρχουν, και το `execFile` του adapter
  περνάει όλο το parent env στο child process by default — άρα αρκεί να οριστούν στο
  Railway dashboard, καμία αλλαγή κώδικα. Αν αργότερα κληθεί το GMGN REST απευθείας
  αντί για το CLI (βλ. layer "Εκτέλεση"), ήδη θα υπάρχουν εκεί.
- **Telegram bot**: `@shitcoin_intel_bot` ("Shitcoin Intel") — προϋπάρχον, ΣΚΟΠΙΜΑ
  reused, ΟΧΙ νέο. Επιβεβαιωμένο 2026-08-25, doubly confirmed 2026-08-26 (βλ. "Manual
  wallet watching" για το πλήρες σκεπτικό). Token ήδη configured στο project `.env`.

## Setup που μένει χειροκίνητο (μία φορά)
✅ **Έγινε 2026-08-25**: λογαριασμός GMGN → `gmgn-cli config` (Ed25519 keypair) →
`config --apply <key>`. Το `config --check` επιστρέφει 0.
✅ **Έγινε**: Telegram bot — `@shitcoin_intel_bot`, προϋπάρχον/reused (βλ. "Manual
wallet watching"). Token στο project `.env`, `TELEGRAM_CHAT_ID` γνωστό.
⬜ **Μένει**: binding trading wallet (χρειάζεται πριν τη Φάση 4, όχι για read-only).
Το `portfolio info` επιστρέφει `{"wallets": []}` — **κανένα wallet δεμένο**. Αυτό είναι
δεύτερο, ανεξάρτητο ασφαλιστικό πάνω από το `GMGN_ALLOW_AUTOMATED_TRADES`: ακόμα κι αν
κάτι καλέσει `swap`, δεν υπάρχει wallet να συναλλάξει. Κρατάμε το έτσι μέχρι τη Φάση 4.
Τίποτα άλλο δε χρειάζεται χειροκίνητο κλικ μέσα στο GMGN UI — το wallet curation ζει
εξ ολοκλήρου στο δικό μας Postgres.

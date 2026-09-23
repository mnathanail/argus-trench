# ArgusTrench — GMGN / pump.fun Auto-Trading System — Project Memory

Repository: `argus-trench`

## What this is
An automated trading system for Solana meme coins (pump.fun), built on the GMGN skill
ecosystem (gmgn-cli), aiming to: track wallets/tokens, generate entry/exit signals, and
phase the rollout from log-only up to live auto-trading.

## Architecture — 6 layers
1. **Discovery & gate** — `gmgn-cli market trenches` with server-side min/max filters
   (rug_ratio, bundler_rate, insider_ratio, top_holder_rate, smart_degen_count,
   creator_created_open_ratio, twitter_rename_count). All CONFIRMED as real
   flags — see "Verified CLI contract". This IS the hard gate.
   **Two calls per cycle, not one** (measured 2026-08-25, `near_completion` / sol):
   - *Gated call* → the actionable candidate set. Server-side filtering reaches much
     deeper into the pool: 60 qualifying Pump.fun tokens, while the ungated window only
     contained 15 of them. Without this we'd miss 4× the candidates.
   - *Ungated call* → the ONLY source of `skipped_gate` rows. The gated response returns
     exclusively survivors; filtered-out tokens never appear anywhere. We apply the
     same thresholds client-side on top of the window and write BOTH passes and fails.

   So "we don't build our own filtering" holds for what we **execute**, not for what we
   **log** — otherwise `decision_log` never records skipped_gate and Phase 2 tuning is
   blind (see `candidate_source`, migration 0003).
   Phase 1: **`--launchpad-platform Pump.fun` only** — one launchpad, cleaner dataset.
2. **Wallet curation** — a standing, independent process, two parallel paths:
   - *Automatic*: **implemented 2026-08-26** (`collectors/walletDiscovery.ts`), via
     `token holders --tag smart_degen` over ~20-30 recently **graduated** (`market
     trenches --type completed`, sorted by `complete_timestamp` — NOT
     `created_timestamp`) Pump.fun tokens.
     Wallets appearing in >1 token **don't block** ones that only appear in one — frequency
     is a scoring priority (multi-token candidates get scored first, since the throttled
     cycle may not get through everyone), not a hard filter, no schema change.
     Scoring via `portfolio stats --wallet <addr>`, INSERT (`ON CONFLICT DO NOTHING`,
     NEVER update) only if `pnl_stat.winrate > 0.5 AND pnl_stat.token_num >= 15` —
     otherwise skip, no inactive row. `ON CONFLICT DO NOTHING` protects twice over:
     it never downgrades an existing `manual` wallet to `smart_money`, and it never
     re-writes the score for an already-known `smart_money` wallet (that's the job of
     the unified wallet-scoring loop, not discovery — otherwise the logic would be
     duplicated).
     **Weekly = only the bootstrap of new candidates.** Once a wallet enters the
     watchlist, it gets re-scored on the SAME fast interval as all active wallets (see
     "Manual wallet watching" → `wallet_score_history`) — there is no separate, slower
     re-scoring cadence *exclusively* for already-discovered wallets, as a literal
     reading of "weekly re-scoring" above might imply. The single scoring loop scores
     ANY active wallet, regardless of source, on the same interval.
     ⚠️ **`--tag` is single-value, NOT repeatable** (unlike `market trenches
     --type`) — tested 2026-08-26. Getting BOTH `smart_degen` AND `renowned` needs two
     separate calls (double weight, 5+5 per token). `renowned` is supported
     (`includeRenowned` option) but is **off by default** exactly for this cost.
     ⚠️ **The response has BOTH `address` AND `account_address`** — `address` is the
     owner/wallet, `account_address` is the on-chain token account (ATA). Picking the
     wrong one would write ATA addresses into the watchlist instead of wallets.
     ⚠️ **`portfolio stats` does NOT batch** (tested 2026-08-25, both with
     `--wallet A B` and with `--wallet A --wallet B`): it returns a single object, only
     for the first wallet, despite the help text saying "supports multiple wallets". So
     scoring costs **3 weight per wallet**. `portfolio profits` does genuinely batch
     (`{list:[...]}`, 1–100 wallets, weight 3) but does **not** contain `pnl_stat`, i.e.
     it doesn't give win rate — so it doesn't substitute for `stats` for our rule.
     Per-cycle re-scoring is realistic as long as the watchlist stays small, not because
     they fit in one call.
   - *Manual*: the user adds wallets they already trust — see "Manual
     wallet watching" section below.
   Both are stored in the same `watchlist_wallets` table. It does NOT depend on
   "follow" inside the GMGN UI.
3. **Signal triggers** — two independent, parallel channels, not one:
   - **Our own watchlist** — the intersection of the two layer-2 streams above: a
     trusted wallet (from our list) buys a token that has passed the gate.
     ⚠️ **`track follow-wallet` does NOT work for this** (confirmed 2026-08-25): it
     resolves the list from the follows of the GMGN account tied to the API key,
     i.e. it depends on the GMGN UI — exactly what we explicitly reject in layer 2. It
     also needs signed auth.
     Source for OUR OWN wallets: **`portfolio activity --wallet <addr> --type buy`,
     polled per wallet** (paginated, with a `next` cursor). Cost is 1 request/wallet/cycle
     instead of 1 total — this factors into the rate-limit math, see "Verified CLI
     contract". Complementary: PumpPortal WebSocket `subscribeAccountTrade` (push, low
     latency — not a substitute for GMGN, and not before a working pipeline exists).
   - **GMGN's own platform-wide smart-money feed — implemented 2026-09-20**
     (`collectors/gmgnSmartMoney.ts`), via `track smartmoney`. Weight 1 **total per
     cycle**, not per wallet — the cheapest broad signal source available, and much
     broader than our self-curated watchlist (~100-150 addresses, expensive to grow).
     Runs every 30s (`GMGN_SMARTMONEY_INTERVAL_MS`), independent of the layer-2
     watchlist entirely: these are GMGN's own tagged wallets, never written into
     `watchlist_wallets` (that table stays reserved for wallets we curate — see below).
     Signals from this channel get their own `decision_log.trigger_type =
     'gmgn_smartmoney'`, kept deliberately distinct from `'smart_money_buy'` (our own
     watchlist) so the two channels' hit-rates can be measured independently before
     either is trusted more than the other. **Always `mode='log_only'` for now** — a
     brand-new, unvalidated signal source starts at the same read-only logging stage
     the whole system started at (see "Phased rollout"), not wired to paper or live
     trading yet.
     ⚠️ **`decision_log.trigger_wallet_address` lost its FK to `watchlist_wallets`**
     (migration 0014) to allow this — a GMGN smartmoney wallet is never one of ours, so
     the FK would reject every such trigger row outright. Existing display code already
     used `LEFT JOIN watchlist_wallets`, so a non-matching address just shows with no
     name (as it should) — nothing assumed an unconditional match.
   - `track kol` (weight 1, same shape as smartmoney) is documented and adapter-ready
     (`gmgn/trackSmartmoney.ts`'s pattern applies directly) but not yet wired to its own
     collector loop — natural next step once `gmgn_smartmoney`'s hit-rate is assessed.
   - **Holder-risk enrichment — implemented 2026-09-20** (`gmgn/holderRisk.ts`): for every
     fresh `gmgn_smartmoney` signal that passes the gate, one extra `token holders`
     call (no `--tag`, weight 5 — the most expensive route, now paid **per signal**
     instead of only during wallet-discovery bootstrap) computes the fraction of the
     tradeable float held by `bundler`/`rat_trader`/`sniper`-tagged wallets, mirroring
     only the risk-tag math of the `gmgn-holder-analysis` skill's Python script (NOT its
     full rating cascade — no dev-holding/airdrop/linked-funding checks). Stored on
     `triggerWalletSnapshot` as `holder_risk_pct` (`null` = unassessable/degenerate float
     or not checked, never treat as 0%) + `holder_risk_wallet_count` +
     `holder_risk_checked`. Never blocks the holders-enrichment step itself on failure:
     any error (rate limit or otherwise) records `null`. Because this runs inside the
     per-cycle loop over multiple fresh trades, a rate-limit hit on the first holders
     call disables further holders calls for the rest of that cycle
     (`rateLimitedThisCycle` in `gmgnSmartMoney.ts`) so consecutive calls don't extend
     the shared ban.
     ⚠️ **Now an active entry FILTER, not just logging — turned on 2026-09-22**
     (`HOLDER_RISK_MAX_PCT = 0.5` in `gmgnSmartMoney.ts`, `isHighHolderRisk()`). After 2
     days of pure logging (1136 closed signals), `holder_risk_pct` showed a clean,
     monotonic relationship with outcome: <10% risk → avg pnl **+10.5%** (n=35), 10–30%
     → -53.4% (n=110), 30–50% → -86.2% (n=272), **≥50% → -92.9% with a 1.7% win rate**
     (n=460, the single most common bucket). Signals with a KNOWN `riskPct >=
     HOLDER_RISK_MAX_PCT` are now skipped entirely BEFORE `recordSignal` — never written
     to `decision_log` at all, unlike `is_open_or_close` which remains logging-only.
     `null`/not-checked (~23% of the sample — rate limit, error, or degenerate float)
     does NOT exclude a signal: absence of data isn't evidence of risk, and the filter
     must not depend on whether an earlier trade in the same cycle happened to trip a
     rate limit. `runGmgnSmartMoneyCycle`'s result now includes `skippedHighRisk` for
     observability. Threshold may be tightened (e.g. <30%) after another day of data
     with the filter active — same collect-then-revisit pattern used throughout this
     channel's rollout.
   - The **cluster signal** concept from the `gmgn-track` skill (multiple tracked
     wallets buying the same token in a short window = stronger conviction than one) is
     NOT implemented in decision logic yet — noted as a follow-up, not built.
4. **Exit decision** — two mechanisms together, not one:
   - A mechanical order at the moment of purchase: `swap --condition-orders` combining
     `profit_stop` (fixed tier) + `profit_stop_trace` (trailing, with `drawdown_rate`).
   - An active exit signal: `track smartmoney`/Smart Money Exit Signal — exit when
     the wallets you follow exit, regardless of price.
5. **Execution** — `gmgn-cli swap`. Safety interlock: `--yes` (headless mode)
   explicitly requires `GMGN_ALLOW_AUTOMATED_TRADES=1`. This IS the paper/live switch —
   stays unset until Phase 5.
6. **Logging & tuning** — Postgres (see schema) + Telegram bot (existing stack).
   Feedback loop for backtesting/threshold tuning.

Note: layers 1-2 run in parallel/continuously as background processes, not sequentially
per token. Layers 3-6 are the per-event pipeline.

## Verified CLI contract (gmgn-cli 1.5.8, confirmed 2026-08-25)
Everything here has been verified with real calls, not read off the docs. The skills
(`.agents/skills/`) describe the **raw API**; the CLI normalizes elsewhere.

**Setup**: `npm install -g gmgn-cli` (global, not a project dep) → `gmgn-cli config --check`
(exit 0 = ok, 1 = unconfigured) → `gmgn-cli config` (generates an Ed25519 keypair, gives a URL) →
`gmgn-cli config --apply <KEY>`. Writes `~/.config/gmgn/.env` (`GMGN_API_KEY` +
`GMGN_PRIVATE_KEY`) and `~/.config/gmgn/keypair.pem`, perms 600.

**Traps where the documentation disagrees with reality:**
- The response key is **`near_completion`**, NOT `pump`. The skill doc categorically
  states the opposite ("always returns this category under the key `pump`").
  Code written from the doc would silently read `undefined`.
- Top-level keys with no `data` wrapper: `{ new_creation, near_completion, completed }`.
- **`--limit` is ignored** — asked for 3, got 60. Response ~250KB, 89 fields/item.
  Payload size is not controllable.
- **`private_vault_hold_rate` is 0 across all results** — useless as a filter.
- Numeric fields in `trenches` are JSON **numbers**. But in `portfolio activity`,
  `token_amount` / `cost_usd` / `price_usd` are **strings**, and in `kline` the prices
  are also strings. **Don't generalize per driver — it's per endpoint.** The adapter has
  one `toNumber` that accepts both.
- In `portfolio activity` the fields are **`event_type`** and **`tx_hash`** — the doc says
  `type` and `transaction_hash`. `timestamp` is a number (unix seconds).
- **The field count isn't stable**: the same `trenches` call gave 89 fields/item
  and shortly after, 97. That's why we keep the `raw` payload as-is in `gate_snapshot_json`
  and only validate what we actually use.

**Flag → field mapping** (names do NOT match, the adapter needs an explicit table):

| Filter flag | Field in response |
|---|---|
| `--max-top-holder-rate` | `top_10_holder_rate` |
| `--max-insider-ratio` | `suspected_insider_hold_rate` |
| `--max-bundler-rate` | `bundler_trader_amount_rate` |
| `--max-rug-ratio` | `rug_ratio` |
| `--min-smart-degen-count` | `smart_degen_count` |
| `--max-creator-created-open-ratio` | `creator_created_open_ratio` |
| `--max-twitter-rename-count` | `twitter_rename_count` |

**Rate limits** — leaky bucket `rate=20 capacity=20`, **shared across all routes** (so one
heavy poll steals budget from the others). Weights: `trenches` 3, `signal` 3, `hot-searches` 3,
`kline` 2, `trending` 1, `search` 1, `portfolio activity` 3, `portfolio stats` 3,
`portfolio profits` 3, `portfolio holdings` 5, `portfolio info` 1, `token holders` 5,
`track smartmoney` 1, `track kol` 1, `track follow-wallet` 3.
The two-call discovery costs 6/cycle. The expensive part is the per-wallet routes: `portfolio
activity` **and** `portfolio stats` are weight 3 **per wallet** and neither one
batches. 50 wallets in activity = 150 weight = 7.5s at full rate; another 150 if we
score the same ones. Only `portfolio profits` genuinely batches (100 wallets,
weight 3) — but it gives P&L, not win rate. `token holders` (weight 5, the most expensive
route) is even more expensive: ~10 tokens/hour in the wallet-discovery bootstrap
is about 50 weight just for the holders pass. Since 2026-09-20 it's also called once per
fresh `gmgn_smartmoney` signal (holder-risk enrichment, see layer 3) — a second,
independent consumer of this same expensive route, sharing the same 20/s bucket.
Rule of thumb: the 20/s budget gets eaten by wallets, not discovery. On 429: read the
`X-RateLimit-Reset` header or `reset_at` in the body.
**DO NOT naive-retry** — each request inside the cooldown extends the ban by 5s,
up to 5 minutes. The adapter wants a token bucket, not a retry loop.
⚠️ **`retryAt` parsing must handle BOTH the JSON `reset_at` AND the human-readable 429**:
the live `RATE_LIMIT_EXCEEDED` variant returns "Rate limit resets at ... (~30s
remaining)" with no numeric `reset_at` field, so `parseResetAt` in
`gmgn/exec.ts` had to also parse the text to avoid falling back to the 60s default.
This patch ensures the shared cooldown follows the real reset time,
instead of the app running again mid-ban and worsening the 429.
⚠️ **Every per-item loop over multiple wallets/tokens must rethrow
`GmgnRateLimitError`, NOT swallow it as "one item failed"** (a real bug,
found 2026-08-26 in `scoring.ts` while building `walletDiscovery.ts`, and
confirmed live: a single 429 on wallet #N would let items #N+1..end keep hitting the API
WHILE banned, extending it by 5s per request). `rethrowIfRateLimited()` in
`gmgn/errors.ts` is the shared guard — every new per-item collector loop must
call it first inside `catch`.

**IPv6 is not supported** — gives 401/403 even with correct credentials. Check before a
Railway deploy: if `https://ipv6.icanhazip.com` responds, outbound traffic is going over IPv6.

**`portfolio stats` — the semantics of scoring (critical, confirmed 2026-08-25):**
- Win rate is **NOT** the top-level `win_rate`; it's **`pnl_stat.winrate`**.
- It's computed over **tokens/positions, not trades**: the buckets `pnl_lt_nd5_num`,
  `pnl_nd5_0x_num`, `pnl_0x_2x_num`, `pnl_2x_5x_num`, `pnl_gt_5x_num` sum exactly to
  `pnl_stat.token_num` (measured: 0+497+549+16+4 = 1066 = token_num).
- So the `trade_count >= 15` in our rule ties to **`pnl_stat.token_num`**, NOT to
  `buy + sell`. On the same wallet: token_num 1066 vs buy+sell 5080. If we used the
  latter, numerator and denominator would be counting different things and the threshold
  would be ~5× looser than we think.
- ⚠️ **The schema's `pnl_multiplier` is a misnomer**: its source is `realized_profit_pnl`,
  which is a **ratio/ROI** (0.3264 = +32.6%), not a multiplier (that would be 1.33). We
  store it as-is. If code ever reads it as a multiplier, it will dramatically
  underestimate — it wasn't renamed to avoid breaking the existing schema, but BE CAREFUL.
- Useful bonus: `pnl_stat.avg_holding_period` (seconds) distinguishes a sniper bot from
  a real trader; the pnl buckets give a distribution, not just an average.
- **`common.*` — implemented 2026-09-20** (`gmgn/walletStats.ts`): the SAME `portfolio
  stats` response (already weight 3, already called every scoring cycle) also carries a
  `common` block with wallet identity/provenance — confirmed in a real captured response
  (`__fixtures__/portfolio.stats.json`, 2026-09-11), not just documented. Two fields now
  extracted at zero extra cost: `common.created_at` (unix seconds, first funding tx —
  wallet age) and `common.fund_from_address` (the address that funded this wallet —
  future sybil/cluster-coordination signal: multiple "smart"-tagged wallets sharing a
  funding source in the same cluster suggest coordination, not independent conviction).
  `null` when `common` is absent or the field is an empty string (GMGN doesn't always
  know it — confirmed asymmetric in the same fixture: `fund_from` empty while
  `fund_from_address` populated). **Logged only, not wired to any filter or the
  documented-but-unbuilt cluster signal yet** — explicit user choice, same
  collect-first-decide-later pattern as `is_open_or_close`/holder-risk-pct.

**Fields that weren't in the original plan and are worth considering as gate v2** (also
exist as `--min-*`/`--max-*` flags): ~~`entrapment_ratio`~~ (now active, see below),
`top70_sniper_hold_rate`, `fresh_wallet_rate`, `bot_degen_rate`/`bot_count`,
`dev_team_hold_rate`, `progress`
(bonding curve), `--min-created`/`--max-created` (token age, unit suffix mandatory:
`30s`/`5m`). Copycat detection: `twitter_dup`, `website_dup`, `telegram_dup`, `image_dup`,
`twitter_rename_count`, `twitter_del_post_token_count`. Dev reputation: `fund_from_address`
(creator's funding source), `creator_token_status`, `is_wash_trading`, `cto_flag`.
There's also `--filter-preset safe|smart-money|strict` — `strict` is close to our own gate.
`bot_degen_rate`/`dev_team_hold_rate` are already parsed into `GateMetrics` (visible in
`gate_snapshot_json` for analysis) but have NO `--max-*`/`--min-*` flag wired yet in
`GateThresholds`/`THRESHOLD_FLAGS`/`GATE_FIELD_BY_FLAG` — using them as an actual gate
filter needs that wiring added first, unlike `entrapment_ratio` which was already fully
wired and just unused.

**`maxEntrapmentRatio: 0.3` — activated 2026-09-23**, explicit user request based on real
data (not a guess): across 2681 already-closed trades with a known `entrapment_ratio`
(0% missing across 17369 candidates/7 days, confirmed before activating since the gate
fails closed on null), the distribution was clearly bad in the [10-30%) range: [0-10%) →
avg pnl +63.5% (n=2468, the vast majority), [10-20%) → -17.8% (n=83), [20-30%) → -66.4%
(n=20), [30%+) → positive but far too small a sample (n=12 total, one bucket skewed by a
single +2864% outlier) to draw any conclusion yet. The threshold was set at 0.3 —
excluding only the clearly-bad [20-30%) bucket — leaving the ambiguous upper range
untouched until more data accumulates there. Same conservative, data-first pattern as
`HOLDER_RISK_MAX_PCT`.

## Decision philosophy (v1) — NOT a scoring/weighted model
Explicitly decided NOT to use a weighted score (arbitrary weights). Instead:
- **Hard-gate cascade**: veto gates (security + dev reputation) — non-negotiable,
  no nuance.
- **Wallet-following / consensus**: the entry trigger is a rule
  ("trusted wallet buy" + "passed the gate" = entry), not a numeric score.
- A scoring/ML model comes in v2, ONLY once real labeled outcomes exist from
  logging (not guessed weights today).

## Skills in use (from the 40+ at gmgn.ai/ai/skills_market)
- **Core v1 (25 skills)**: Token Security Check, Liquidity Pool Analysis, Top Holders,
  Dev Wallet Info, Dev Token Launch History, Token Overview, Wallet Holdings/P&L/Activity,
  Copy Trade Assessment, Pump.fun New/Near-Graduation Tokens, Token Kline Chart,
  Followed Wallet Activity, Smart Money Trades/Buy/Exit Signal, Buy with TP&SL,
  Trailing Take Profit/Stop Loss, Market/Limit Buy/Sell, Open/Cancel Order.
- **Deferred v2**: KOL Call/Trade Activity, Price Surge Signal (a second confirmation
  layer), OpenNews MCP, OpenTwitter MCP (narrative/sentiment layer), Top Traders,
  Smart Money/KOL Holders context, Migrated Tokens.
- **Skip**: Cooking/Launch skills (a different use case — token deployment, not trading),
  Multi-Wallet Buy, Limit Buy/Sell (v1 is signal-triggered, not price-triggered),
  Wallet Token Balance, Pump Claim Signal.

## Postgres schema — detailed logging design (v2, replaces the simple trade_log)
Core principle: we log EVERY candidate that was evaluated, not just what became a trade —
otherwise there's no way to measure whether the gates are too strict (missed winners)
or too loose, and Phase 2-3 tuning is blind to half the problem.

```sql
watchlist_wallets(address, chain, source, win_rate, pnl_multiplier, trade_count,
                   active, added_at, last_reviewed_at)

-- EVERY candidate that was evaluated, trade or not
decision_log(
  id, token_address, chain, evaluated_at,
  logic_version,                          -- tag of the thresholds/rules at that moment
  gate_snapshot_json,                     -- rug_ratio, bundler_rate, insider_ratio, top_holder_rate, smart_degen_count, creator_created_open_ratio, raw
  gate_passed,
  gate_fail_reason,                       -- e.g. "rug_ratio 0.34 > max 0.2", null if it passed
  trigger_type,                           -- smart_money_buy (our watchlist) / gmgn_smartmoney (GMGN's own tagged wallets, no FK) / kol_call / none (kol_call: reserved for v2, inactive in v1 — KOL Call Signal is Deferred)
  trigger_wallet_address,
  trigger_wallet_snapshot_json,           -- win_rate/pnl_multiplier AT THAT MOMENT, not today
  decision,                               -- entered / signal_logged / skipped_gate / skipped_no_trigger / skipped_bankroll_limit
  decision_reason_text,                   -- human-readable, for a quick scan / Telegram alert
  linked_trade_id                         -- FK, only if decision = entered
)

-- ONLY for what actually got taken
paper_trades(
  id, decision_log_id, token_address, chain, mode,       -- log_only / paper / live
  intended_size_pct, bankroll_at_entry,
  simulated_entry_price, simulated_entry_amount_sol,
  assumed_slippage_pct, assumed_latency_ms,               -- honest paper trading = models delay, not instant fill
  condition_orders_json,                                  -- the exit plan set at the moment of entry
  entry_at, status,
  exit_reason,                                            -- tp_tier_1 / tp_tier_2 / trailing_stop / exit_signal / timeout
  exit_trigger_detail_json,                                -- e.g. which wallet fired the exit_signal
  simulated_exit_price, exit_at,
  pnl_sol, pnl_pct, assumed_fees_pct, pnl_net_pct
)

-- follow-up on what we did NOT take, to measure false negatives
rejected_candidate_followup(
  decision_log_id, checked_at,            -- e.g. +1h, +24h after evaluation
  price_change_pct_since_evaluation,
  would_have_hit_profit_tier              -- bool: would we have won if we'd taken it?
)
```
`decision_log` is the most critical table — it logs BOTH the trades AND the skipped
candidates, so backtesting/tuning sees the whole picture from day one,
not just the biased view of what was actually executed.

**`decision` has no CHECK constraint** — it's TEXT with a comment. That's why the
value **`signal_logged`** was added without a migration: in Phase 1 the entry rule
fires (gate passed AND trusted wallet bought) but no trade is executed. The
`skipped_no_trigger` value would become false once there's a trigger, and `entered` would
imply a position that never opened. In Phase 3 these rows are exactly the set that would
become `entered` with a paper trade.

**Migration 0004 (collector state):**
- **Unique index `(token_address, logic_version, candidate_source)`** — one row per
  candidate per observation source, NOT per poll tick. A token stays in trenches for hours,
  so without dedup `decision_log` would count poll ticks. `candidate_source` belongs in the
  key: a token appears in both the gated and ungated call, and if we deduped only on
  (token, version), one observation would be lost, corrupting that source's pass-rate.
- `last_evaluated_at` + `evaluation_count` — how many times we've seen it again, without a
  full time series. `evaluated_at` stays "first time".
- `watchlist_wallets.last_seen_tx_hash` / `last_seen_activity_at` — cursor for activity
  polling. Without this, every cycle re-produces the same buys as new triggers.
- The upsert has `WHERE decision <> 'entered'`: once a row is tied to a real trade,
  the next cycle must not flip it back to `skipped_*` and orphan the trade.

**Migration 0003 added `candidate_source`** (`gated_pool` / `sample_window`, NOT NULL
with no default, with a CHECK). It's necessary because of layer 1's two-call design: the two
calls do NOT carry the same statistical meaning. `gated_pool` gives survivors from the full
depth of the pool but zero visibility into rejects; `sample_window` gives both
but is a sample, not the full population. Without the column, Phase 2 would compute pass-rate
over mixed sampling frames and draw the wrong conclusion about how strict
the gates are.

## Manual wallet watching (user-provided, migration 0002)
Beyond automatic discovery, the user can add wallets they want to
watch directly:
- **Bot**: `@shitcoin_intel_bot` ("Shitcoin Intel"). **Pre-existing** — no new one was built, and
  the user confirmed 2026-08-25 that this is the right one, doubly confirmed 2026-08-26.
  This revises an earlier "new bot" decision — an older, inconsistent note in the
  "Runtime & environment variables" section was corrected in the same commit. If alerts
  ever get confused with another system in the same chat, we'll
  separate it out then.
- **Authorization — fail closed**: `TELEGRAM_CHAT_ID` is an allowlist (comma-separated)
  and **empty means no one, not everyone**. The bot's username is discoverable, anyone
  can message it, and `/watch`/`/unwatch` write to the watchlist that feeds
  entry signals — i.e. an open bot is a path for a third party to inject their own wallets
  into our strategy. On an unauthorized chat we **don't respond at all** (a reply
  confirms the bot exists and who has it) — log only.
- **How they get added**: Telegram bot command `/watch <address>` (source='manual',
  active=true immediately — does NOT go through the automatic win_rate/trade_count
  threshold, we trust the user's judgment). `/watch` does the upsert first and then the
  scoring: if GMGN is down, the wallet gets added anyway — the score is
  information, not a precondition.
- **`/unwatch <address>` works on ANY wallet, regardless of source**
  (fixed 2026-08-26 — it was never restricted at the repository layer, but the
  documentation described it as a manual-only command). It acts as a manual
  override/veto: even an auto-discovered wallet that passed the algorithmic
  threshold (`win_rate > 0.5 AND trade_count >= 15`) can be manually
  deactivated. Its score history remains.
- ⚠️ **`wallet_score_history` records EVERY re-score, for ANY active wallet —
  NOT just manual ones** (fixed 2026-08-26; a previous note here wrongly said
  the table was for manual wallets). The layer 2 scoring loop scores ALL
  active wallets every cycle (`portfolio stats`, never permanently cached), regardless of
  whether they were added manually or via automatic discovery:
  ```sql
  wallet_score_history(id, wallet_address, recorded_at,
                        win_rate, pnl_multiplier, trade_count)
  ```
  The hourly bootstrap collector (`walletDiscovery.ts`, see the "Automatic" path of
  layer 2 above) is **implemented 2026-08-26**, but only for discovering NEW
  candidates — it is not a separate re-scoring cadence for already-known wallets. Once a
  `smart_money` wallet enters the watchlist, it gets re-scored in the SAME unified loop, on
  the same interval, as every other active wallet.
- **Visibility**: `/score <address>` on demand (shows trend from the history table).
  `/watchlist` (alias: `/list`) lists ALL active wallets — address, source, win
  rate, pnl, position count — so you can see what's there before deciding to `/unwatch`
  something. Additionally, a proactive alert when ANY active wallet's score drops
  below the auto-discovery floor (win_rate < 0.5) — it suggests review, does NOT
  deactivate it on its own (the user decides, even for wallets they didn't
  add themselves — see `/unwatch` above).
- "Real-time" here means: at the same polling frequency as the rest of the system — the
  GMGN `portfolio stats` has no websocket/push endpoint, so there is no true
  streaming score.

## Recent operational hardening (2026-08-29)
The live deployment revealed that the critical problem wasn't the gate logic, but the
collective flow of requests to GMGN: all the regular loops shared the same IP-level
rate bucket and the scheduler let them run concurrently. The result was burst
requests, prolonged 429s, and a backlog of open paper trades because the exit resolver
couldn't keep up closing trades before new ones opened.

### The patch that was applied
- **Scheduler serialization**: `runScheduler()` / `ExclusiveCoordinator` runs the regular
  loops in serial order, so only one regular loop is active at a time. An
  `exclusive` loop (e.g. the wallet-discovery maintenance window) blocks new regular work
  until it completes.
- **Shared cooldown across the whole app**: every 429 triggers a shared cooldown across all
  loops, not just the loop that hit it. This logic is implemented in `SharedCooldown`
  and the `GmgnRateLimitError` path.
- **Retry backoff**: loops have stricter backoff for consecutive failures,
  instead of flat retries at short intervals that extend the ban.
- **Wallet activity burst reduction**: polling was capped at 2 wallets/cycle,
  round-robin selection keeps a stable pointer so the same wallets don't starve,
  and there's a guard for a large open-trade backlog (`max open trades before pause`).
- **Dedupe and cursoring**: `filterNewBuys()` removes duplicate `txHash` values and
  `last_seen_tx_hash` / `last_seen_activity_at` track the cursor of the last buy,
  so the same signals aren't re-logged every cycle.
- **Exit resolution priority**: the exit resolver is now prioritized, so it closes
  open trades before the system takes on new trigger traffic.
- **Rate-limit safety guard**: every per-item loop rethrows `GmgnRateLimitError` instead of
  swallowing it as "one item failed", since that would let the next item
  hit the API again while banned.

### What we saw in practice
- `wallet-activity` produced bursts of 4 wallets/cycle and opened many `signal_logged`
  entries simultaneously.
- `wallet-discovery` and `wallet-scoring` shared the same GMGN bucket, so a 429
  on one endpoint affected the other loops too.
- `paper_trades` had an open backlog with `status='open'` and `exit_reason=NULL`, because
  the exit loop was hitting 429s and couldn't execute closes.
- The real "burst on a single wallet" wasn't magic; it was the same activity page being
  re-sent across the same span of wallets until GMGN banned the IP.

### Shape of the future protection
- The architecture stays "read-only with logging" for Phase 1.
- Throttling the request rate is the primary lever. The flow needs to stay
  controlled / serialized and not load the shared GMGN rate bucket in bursts.
- If 429s keep showing up even with serial looping, the next step is
  splitting GMGN capacity (a separate API key / IP / account), not more request
  pressure on the same IP.

## Watchlist growth outgrew wallet-scoring's per-cycle cap (2026-09-22)
Real, active incident: Railway logs showed repeated `RATE_LIMIT_BANNED` (not just plain
429) across MULTIPLE, unrelated loops (`gmgn-smartmoney`, `wallet-scoring`,
`live-strategy-reconciler`, `live-trade-watchdog`, `wallet-discovery`, `exit-resolver`,
`discovery`) simultaneously, with the ban's reset time continuously pushed further into
the future — the signature of requests still landing inside an active ban and extending
it (each one costs +5-60s, per the GMGN error message itself).

**Root cause, found by reading the code, not by guessing**: `listWalletsForScoring()`
(`src/db/repositories/watchlistWallets.ts`) had NO `LIMIT` — it returned every
active-or-below_threshold wallet, and `runWalletScoringCycle` (`src/collectors/
scoring.ts`) scored ALL of them serially every cycle, at weight 3 each (`portfolio
stats`). On 2026-09-22 the watchlist had grown to 186 wallets (155 active + 31
below_threshold) = **558 weight in a single cycle** — well above the GMGN leaky-bucket
budget (rate=20/capacity=20) even with zero other loops running concurrently. This is
the EXACT same failure mode already documented in `intervals.ts` from 2026-09-13 (108
wallets, ~324 weight, same symptom) — that fix only widened the interval (5min→15min)
without capping the wallet count per cycle, so the root cause remained and resurfaced
worse as the watchlist kept growing organically (source: wallet-discovery bootstrap +
manual `/watch` additions).

**Fix**: `listWalletsForScoring(limit)` now takes a `LIMIT` and rotates via
`ORDER BY last_reviewed_at ASC NULLS FIRST` — identical pattern to the existing, already
battle-tested `selectWalletsForActivityCheck` (self-healing by construction, the DB IS
the rotation state, nothing lost on restart). New constant
`WALLET_SCORING_WALLETS_PER_CYCLE = 40` in `intervals.ts` (40×weight3=120/cycle, safely
inside budget even if another loop fires the same second). Trade-off: each individual
wallet now gets re-scored less often than before as the watchlist grows past 40 (a full
rotation takes more than one `WALLET_SCORING_INTERVAL_MS` cycle) — accepted, since
staying inside the rate limit is the priority and scores don't change meaningfully
minute-to-minute anyway (same reasoning as the 2026-09-13 interval widening).

**Takeaway for future collectors**: any per-item loop over the watchlist (or any other
table that grows over time) MUST cap+rotate from the start, not just rely on a
generous interval — an interval that's "safe today" silently stops being safe as the
underlying table grows, with no code change and no warning until the ban actually hits.

## gmgn-smartmoney holder-risk enrichment had no pacing (2026-09-23)
Same day as the wallet-scoring fix above, a SECOND, independent rate-limit storm hit —
this time `RATE_LIMIT_BANNED` on multiple unrelated routes (`token_top_holders`,
`user/smartmoney`, `user/info`) nearly simultaneously, even though `wallet-scoring`
itself was already working correctly under its new cap (`scored=40 failures=0` visible
in the logs at the same time).

**Root cause**: the holder-risk enrichment inside `runGmgnSmartMoneyCycle`
(`src/collectors/gmgnSmartMoney.ts`, added 2026-09-22 — see "Holder-risk ΦΙΛΤΡΟ
εισόδου" above) calls `token holders` (weight 5) for every fresh trade in the cycle,
with NO `delay()` between consecutive calls — unlike `WALLET_SCORING_LOOP_PACING_MS`/
`WALLET_ACTIVITY_LOOP_PACING_MS`, which already existed for exactly this reason on
other loops. The original interval sizing comment for `GMGN_SMARTMONEY_INTERVAL_MS`
only accounted for the cheap `track smartmoney` call itself ("weight 1 total per
cycle") — written 2026-09-20, before the holder-risk enrichment existed. Real cycles
were observed with `new=45` fresh trades, meaning up to 45 consecutive weight-5 calls
(225 weight) fired back-to-back inside a single 30s tick with no pause, even though the
existing `rateLimitedThisCycle` flag correctly stopped retrying AFTER the first 429 —
the burst before that first 429 was already enough to trigger the ban.

**Fix**: new `GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS = 1_000` constant in
`intervals.ts`, with a `delay()` call after each real (non-rate-limited) holder-risk
lookup inside the fresh-trades loop — same pattern as the other two loops. All fresh
trades still get checked, just spread out over more wall-clock time within the cycle
instead of firing in an unthrottled burst.

**Takeaway**: adding a new per-item side-effect (here: holder-risk enrichment) to an
existing loop must re-examine that loop's rate-limit budget from scratch — the
original interval/weight comment was correct when written, but silently became wrong
once new inline work was added without updating the pacing analysis alongside it.

## The pacing fix above was necessary but not sufficient (2026-09-23, same day)
About an hour after the pacing fix (`GMGN_SMARTMONEY_HOLDER_RISK_PACING_MS`) was
deployed, fresh logs showed the SAME rate-limit crisis still happening — and now also
hitting loops that were already fixed and working correctly on their own:
`wallet-scoring` (capped at 40/cycle the day before, `scored=40 failures=0` visible in
an earlier log) started getting banned repeatedly on `user/wallet_stats` with
escalating consecutive-failure counts, and `discovery` started getting banned on
`/v1/trenches` — neither of those routes is even touched by the holder-risk code the
pacing fix targeted.

**Root cause**: pacing spreads calls out over time but does not reduce the TOTAL
weight a single cycle can demand. Cycles were still observed with `new=44-50` fresh
trades even after pacing — meaning a single `gmgn-smartmoney` cycle could still queue
up to 250 weight (50 × 5) into `limiter.acquire()`. The `TokenBucket` in
`src/gmgn/exec.ts` is a SINGLE, process-wide, shared instance (capacity 20) used by
EVERY route/loop — it is not partitioned per-loop. At 1 call/s pacing, a 50-item
backlog takes ~50s to drain, which is longer than the 30s `GMGN_SMARTMONEY_INTERVAL_MS`
itself, so the backlog from one cycle was still draining when the next cycle's fresh
trades queued on top of it — the bucket stayed close to empty almost continuously.
Crucially, `TokenBucket.block()` (called on every 429, see `gmgn/exec.ts`) doesn't just
pause the route that got banned — it zeroes tokens and drops the refill rate to
`RECOVERY_REFILL_PER_SECOND = 1` (instead of 20/s) for a full `RECOVERY_WINDOW_MS =
60_000` **for the whole shared bucket, across all routes**. The bucket's internal queue
is FIFO among equal-priority requests (nothing in this codebase passes an explicit
`priority` to `runCli`/`limiter.acquire()` — checked via `grep -rn "priority"` across
every collector; `walletActivity.ts` and `swap.ts` are the only callers that ever pass
one, and neither is involved here), so there's no fair-share between loops: while
gmgn-smartmoney's own large backlog sits in the queue, it competes on equal footing
with wallet-scoring's and discovery's much smaller, well-behaved per-cycle requests for
the same 1-token/s recovery-window trickle — starving them into their own 429s. This is
why two ALREADY-FIXED, individually-reasonable loops started failing again: the actual
fault was gmgn-smartmoney monopolizing the *shared* limiter's recovery window, not a
regression in either fixed loop.

**Fix**: pacing alone can't bound total per-cycle weight, so added a hard cap —
`GMGN_SMARTMONEY_HOLDER_RISK_CHECKS_PER_CYCLE = 12` in `intervals.ts` (60 weight/cycle
max, ~12-20s of pacing delay max, comfortably under the 30s cycle interval so cycles
stop overlapping, and leaves real headroom in the shared 20/s bucket for other loops
even during a recovery window). Only the first 12 fresh, gate-passed trades per cycle
get holder-risk enrichment; the rest are recorded normally with
`holder_risk_checked: false` — same "absence of data isn't evidence of risk" philosophy
already established for this exact field (a rate-limit skip already produced the same
`false` value). The new `holderRiskChecksUsed` count is now returned from
`runGmgnSmartMoneyCycle` and logged (`holder_risk_checked=N` in the `[gmgn-smartmoney]`
log line in `main.ts`) specifically so a future recurrence is visible from the logs
immediately — if `holder_risk_checked` is pinned at 12 while `new` is consistently much
higher, the cap itself may need revisiting.

**Takeaway**: on a *shared* rate limiter, pacing (spacing calls out over time) and
capping (bounding how much work one cycle can demand in total) solve different
problems — pacing prevents an instantaneous burst from itself tripping the server-side
leaky bucket, but only a cap prevents one loop's sustained backlog from monopolizing
the limiter (and, worse, the post-ban recovery window) at every other loop's expense.
A fix that only paces a loop whose total per-cycle volume is unbounded can look
successful in isolation (that loop's own bursts stop) while the underlying shared-budget
problem persists and resurfaces as failures in unrelated, already-fixed loops — which is
exactly the reappearance pattern that exposed this gap.

## Live strategy order reconciliation incident (2026-09-19) — trade #1225
A live trade (token `CjtxpmhGyHMhdN5MmS7vooYbDVi6utNz5DxJVjF8bjoZ`) closed on GMGN with a
real, large profit via the native trailing-stop (`profit_stop_trace`, 40% drawdown) —
confirmed independently on-chain via Solscan: buy 0.05213884 SOL → sell 0.2809 SOL =
**+438.75%** — but stayed stuck `status='open'`, `pnl=NULL` in our DB, with no Telegram
alert. Root-caused via a real production `order strategy list` response fetched directly
by the user, not guesswork.

**Two independent parsing bugs in `src/gmgn/strategyOrders.ts`'s `parseStrategyOrder`:**
1. The top-level `status` field can be `"canceled"` — a value OUTSIDE both the documented
   (`gmgn-swap` skill: "Order lifecycle status: open / closed") and the code's own
   `StrategyOrderStatus = 'open' | 'closed'` enum. The original unsafe cast
   (`status as StrategyOrderStatus`) let this pass through silently, so every consumer
   (`liveStrategyReconciler.ts`'s `status === 'closed'` check, `realtimeExitHandler.ts`'s
   `status !== 'closed'` check) never recognized a "canceled" strategy as closed, even
   though the position had genuinely, successfully closed (`reason_by: "trade_finish"`,
   one sub-order `status: "success"` on a `profit_stop_trace`, the other `status: "cancel"`
   because the first sub-order had already closed the position).
2. The top-level `close_price` field can be ENTIRELY ABSENT even when the strategy
   genuinely closed successfully.

**Two guessed fallbacks for the missing `close_price` were tried and BOTH proved wrong**
against the real on-chain sell transaction (0.2809 SOL proceeds vs 0.05213884 SOL entry =
+438.75%): (a) the successful sub-order's `check_price` (0.00006074563742368) gave only
+100%; (b) `usdt_profit`/`buy_quote_price` gave +186%. **Conclusion**: no field in this
GMGN response schema reliably represents the real executed exit price/amount — the
correct fix is to NOT guess.

**Fix (commit `5b723d5` / local `6b086a3`):**
- `normalizeStrategyStatus()`: any status other than `'open'` normalizes to `'closed'` —
  no more silently letting an unrecognized value pass through.
- `closePrice` stays strictly the (possibly-null) top-level `close_price` — never
  inferred from any sub-order field.
- `liveStrategyReconciler.ts`: when `strategy.status === 'closed' && strategy.closePrice
  === null`, records an execution error and marks the trade `needs_manual_exit`, instead
  of proceeding to close the trade with a guessed or null pnl.
- `src/gmgn/strategyOrders.test.ts` reproduces the real incident response shape
  verbatim (`status: 'canceled'`, no `close_price`) and asserts on the corrected
  behavior.
- Trade #1225 itself was reconciled manually in the DB using the confirmed on-chain
  amounts (0.05213884 SOL entry, 0.2809 SOL exit).

Separately, the same investigation found the general live-trade watchdog
(`liveTradeWatchdog.ts`, fixed in `e5ef13d`) had also been silently swallowing
`fetchTokenBalance`/`fetchLiveSolWallet` failures for this same trade — a parallel,
independent gap, not the primary root cause, now logged via `recordExecutionError`.

**Takeaway**: do not trust GMGN response field semantics for financial correctness
without independent on-chain verification when the stakes are real money — no field in
this schema was found to reliably substitute for a missing `close_price`.

## Trailing-stop structural fix (2026-09-22) — tier1 was winning the exit race
Most trades were closing green at ~+50% via `tp_tier_1` and `trailing_stop` almost never
fired, even on tokens that later pumped much further. Root-caused by reading the exit
code directly (two independent AI analyses were given for this question; the correct
diagnosis was the structural one, not the "websocket is too slow" one): in both
`checkTick` (`src/realtime/tickExit.ts`, the per-tick/websocket engine) and `resolveExit`
(`src/collectors/exitResolver.ts`, the candle-based engine), the OLD constants had
tier1 at `EXIT_TIER_1_PRICE_SCALE=1.5` (+50%) and trailing activation at
`EXIT_TIER_2_ACTIVATION_SCALE=2.0` (+100%). Trailing can only activate if a single
tick/candle jumps directly from below +50% to at/above +100% — virtually impossible on
real tick-by-tick or candle-by-candle price data. Every ascending price path passes
through `[+50%, +100%)` first, so `tp_tier_1` almost always fired before trailing ever
got the chance to activate. This was NOT a "websocket vs. native GMGN order speed"
problem — the native order (`liveExitConditionOrders()`) merely lacks a tier1 concept at
all (one position = one trade row = one exit, can't represent a partial tier1 sell),
which is why it looked "smarter" on fast pumps.

**Fix — three changes, in `src/decision/paperTradingConfig.ts`, applied to BOTH engines
(tick-based and candle-based) and to BOTH the `checkTick`/`resolveExit` code path and the
native GMGN order (`liveExitConditionOrders()`, which reads the same constants
dynamically):**
1. `EXIT_TIER_2_ACTIVATION_SCALE`: `2.0 → 1.5` (now the SAME point as tier1) — the
   check order in both engines already gives tier2-activation priority over the tier1
   check at the same price, so tier1 now effectively never wins the exit race; trailing
   activates instead at +50% and can keep riding the position higher.
2. `EXIT_TIER_2_DRAWDOWN_PCT`: `0.4 → 0.25` — had to shrink together with the earlier
   activation point. A 40% drawdown allowed from a minimum-possible +50% activation peak
   can mathematically produce a LOSS (peak needs to be ≥+66.7% to stay non-negative at
   40% drawdown, but activation now happens at only +50%). At 25% drawdown the minimum
   possible outcome once trailing activates is a guaranteed **+12.5%** (verified
   numerically, not assumed).
3. New constant `PROFIT_FLOOR_SCALE = 1.1`: `stopPrice = Math.max(peak * (1 -
   EXIT_TIER_2_DRAWDOWN_PCT), entryPrice * PROFIT_FLOOR_SCALE)` in both `checkTick` and
   `resolveExit`. A second, independent safety net — the trailing stop, once active,
   never falls below `entryPrice * 1.1` regardless of the raw peak-drawdown math. At the
   CURRENT constants (+50%/25%) this is mathematically inactive/redundant (minimum
   possible stop is already +12.5% > the +10% floor) — it exists explicitly so a future
   loosening of the drawdown doesn't silently reopen the loss-zone bug from point 2
   without someone re-deriving the safety proof. NOT applied to the native GMGN order —
   GMGN's `profit_stop_trace` API has no equivalent concept.

`stop_loss` (checked first in both engines, -50% from entry, independent of
peak/trailing) is completely unchanged by this fix.

**Explicit user decision on scope**: the user initially asked for this to apply ONLY to
live trades, not paper. `checkTick`/`tickExit.ts` turned out to be mode-agnostic shared
code with no existing per-mode branching (same constants for `live` and `log_only`).
Presented with the choice (add new per-mode branching vs. apply the same constants
everywhere), the user chose to apply the constants universally rather than add
complexity to the exit path — so this change affects `live`, `paper`, AND `log_only`
trades identically.

Tests updated in `tickExit.test.ts`, `exitResolver.test.ts`, and
`realtimeExitHandler.test.ts` — the old tests asserting `tp_tier_1` firing on a single
tick reaching +50%/+60% were testing exactly the bug being fixed, not incidental
breakage; replaced with tests asserting the new trailing-activation behavior, plus new
tests specifically covering the profit floor.

## Phased rollout
0. ✅ Setup & instrumentation (API key, plugin install, logging skeleton) — **done**
1. 🚧 Read-only signal collection (no trading, logging only) — **implemented**:
   5 collector loops (discovery, wallet-activity, wallet-scoring, wallet-discovery, exit-resolver)
   in a single process with a shared cooldown and serial regular execution. wallet-discovery
   and the exit-resolver run in controlled windows so they don't block each other
   or flood the shared GMGN bucket.
   `logic_version = gate-v1-<hash of the thresholds>`.
2. Backtesting & threshold tuning on real logged data
3. Paper trading (full decision engine, simulated fills)
4. Small live capital (strict position sizing)
5. Gradual scale-up

## Bankroll management (the real lever, not the signals) — confirmed numbers
~98.6% of pump.fun tokens collapse below minimum liquidity — no filter
eliminates this base rate, only reduces it. Guardrails:
- **1% of capital per position**, fixed-fractional (NEVER increasing after wins —
  that would be martingale-style sizing, the opposite of a 98.6% failure rate). It only
  goes up ONCE Phase 2 (backtesting) shows a measurable edge, not because "it's going well".
- **Concurrent positions cap: 5-10 in paper trading**, for breadth (you need volume
  so you don't confuse bad luck with bad strategy). **1-2 separately, a lower
  cap in Phase 4 (small live capital)** — first confirm live execution
  matches paper mode's assumptions, before opening multiple positions with
  real money.
- Daily loss circuit breaker, always on — the exact percentage remains open.
- All the config values above are tied to `decision_log`'s `logic_version` —
  when they change after backtesting, the history shows which rules applied to which trade.

## Existing stack (to be integrated, not replaced)
Railway (hosting) · PostgreSQL · Telegram bot (alerts) · Helius WebSocket (available as
backup/redundancy, no longer necessary for pump.fun discovery — GMGN
trenches covers it) · PumpPortal WebSocket `subscribeAccountTrade` (new, for low-latency
wallet triggers, complementary to GMGN).

## What's still open
- **Daily loss circuit breaker**: the principle is confirmed (always on), the
  exact percentage isn't yet.
Everything else (bankroll %, watchlist bootstrap, concurrent caps) has been confirmed — see
"Bankroll management" and "Wallet curation" (layer 2) above.

## Runtime & environment variables (CONFIRMED 2026-08-25)
- **Runtime**: Node.js/TypeScript, ESM, strict. Confirmed. Deps deliberately minimal:
  `pg` + `dotenv` + **`gmgn-cli`** (pinned exact `1.5.8`, not `^` — the contract in
  "Verified CLI contract" above is tied to this version, so an auto-upgrade
  could silently change behavior we've already documented). **Tests:
  `node:test`** (built-in, zero deps) — not vitest/jest.
  ⚠️ `gmgn-cli` is a **regular dependency, NOT a global install** (fixed
  2026-08-26 — it was global on the dev machine, which would break a Railway build without
  global npm state). The adapter (`src/gmgn/exec.ts`) resolves the binary path module-relative
  (`node_modules/.bin/gmgn-cli`), not via PATH — because if the process starts without
  `npm run`/`npm start` (e.g. directly via `node dist/main.js`), `node_modules/.bin` isn't
  guaranteed to be on PATH. A test locks in that the binary exists after `npm install`.
- **Process topology**: **one** Node process with an internal scheduler for everything
  (pollers, bot), not separate Railway services. We split this once there's a real
  reason to scale.
- **Deploy**: GitHub push to `master` → Railway auto-deploy. Pre-deploy command
  `npm run migrate:prod` (compiled `dist/`, since `tsx` is a devDependency and
  gets stripped in the production install). Commits **go directly to master**, no branches.
- **Project `.env`** (locally): `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `GMGN_ALLOW_AUTOMATED_TRADES` (unset/false by default — this is the paper/live
  switch). `GMGN_API_KEY`/`GMGN_PRIVATE_KEY` do NOT go here locally — `gmgn-cli`
  manages its own global config, at `~/.config/gmgn/.env`, via
  `config --apply <key>`, independent of the project.
- ⚠️ **Railway variables (fixed 2026-08-26 — this used to say they're
  never needed in the project env, wrong for production):** `GMGN_API_KEY` and
  `GMGN_PRIVATE_KEY` MUST be set as Railway environment variables. An ephemeral
  container has no persistent `~/.config`, and there's no interactive step there for
  `config --apply`. Confirmed with an empty `HOME`: `gmgn-cli` reads these two
  variables directly from the process env if present, and the adapter's `execFile`
  passes the whole parent env to the child process by default — so it's enough to set them in
  the Railway dashboard, no code change. If the GMGN REST API is ever called directly
  instead of via the CLI (see the "Execution" layer), they'll already be there.
- **Telegram bot**: `@shitcoin_intel_bot` ("Shitcoin Intel") — pre-existing, DELIBERATELY
  reused, NOT new. Confirmed 2026-08-25, doubly confirmed 2026-08-26 (see "Manual
  wallet watching" for the full reasoning). Token already configured in the project `.env`.

## Setup that remains manual (one-time)
✅ **Done 2026-08-25**: GMGN account → `gmgn-cli config` (Ed25519 keypair) →
`config --apply <key>`. `config --check` returns 0.
✅ **Done**: Telegram bot — `@shitcoin_intel_bot`, pre-existing/reused (see "Manual
wallet watching"). Token already in the project `.env`, `TELEGRAM_CHAT_ID` known.
⬜ **Remaining**: binding a trading wallet (needed before Phase 4, not for read-only).
`portfolio info` returns `{"wallets": []}` — **no wallet bound**. This is a
second, independent safeguard on top of `GMGN_ALLOW_AUTOMATED_TRADES`: even if
something calls `swap`, there's no wallet to trade with. We keep it this way until Phase 4.
Nothing else needs a manual click inside the GMGN UI — wallet curation lives
entirely in our own Postgres.

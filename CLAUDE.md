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
     either is trusted more than the other. **Since 2026-09-27 it writes ONLY to
     `decision_log` — no trade at all** (it used to open `mode='log_only'` trades; see
     "Trade modes since 2026-09-27" below).
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

**Migration 0015 added `category`** (`new_creation` / `near_completion` / `completed`, NOT
NULL, DEFAULT `'near_completion'`, with a CHECK — see `gmgn/trenches.ts` `TrenchCategory`)
— pump.fun's bonding-curve lifecycle stage, a THIRD, independent dimension alongside
`candidate_source`. Until 2026-09-23 `discovery.ts` only ever called
`category: 'near_completion'`, so every existing row genuinely is that category — the
DEFAULT is a fact, not a guess, and (unlike `candidate_source`'s no-default choice) is kept
permanently so a future caller that forgets to pass `category` explicitly gets "whatever we
always did" rather than an error. `category` and `candidate_source` must NOT be conflated
into one dimension (e.g. a single `new_creation_gated_pool` value) — a real token can move
from `new_creation` to `near_completion` within hours, so seeing it under both is two
genuine observations over time, not a duplicate of the same evaluation. The unique index
(`idx_decision_log_candidate_identity`) and the `upsertDecisions` `ON CONFLICT` target both
now include `category` for exactly this reason — without it, a `new_creation` evaluation of
a token already sitting in `near_completion` under the same `candidate_source` would
silently overwrite that other lifecycle-stage row. `recordTrigger` deliberately stays
category-agnostic (matches on `token_address` + `logic_version` only, same as it already was
for `candidate_source`) — once a real trigger fires, which lifecycle stage or source first
spotted the token stops mattering.

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

## Second `new_creation` discovery loop added (2026-09-23) — Suggestion 1
Third-party analysis suggested widening discovery beyond `near_completion` to also poll
`category: 'new_creation'` (freshly-created pump.fun tokens, before they approach bonding-
curve completion), on the theory that entering earlier in a token's life could catch more
of the winners the current gate already misses. User asked for this specifically, alongside
the `maxEntrapmentRatio` gate activation above (Suggestion 4).

**Why this needed a real migration, not just a new loop entry**: initially assumed this was
small — just call `runDiscoveryCycle({ category: 'new_creation' })` on a schedule, since
`DiscoveryOptions.category` already existed and was already plumbed through to
`fetchTrenches`. Turned out `candidate_source` (migration 0003) had a CHECK constraint
restricted to exactly `'gated_pool'`/`'sample_window'`, and a unique index
`(token_address, logic_version, candidate_source)` (migration 0004) — there was nowhere to
put "which lifecycle stage" without either abusing `candidate_source` for a second, unrelated
purpose or adding a real column. Stopped mid-implementation to confirm scope with the user
rather than pushing ahead with a wrong-shaped fix.

**Decision**: new `category` column (migration 0015, see the Postgres schema section above)
rather than extending `candidate_source`'s allowed values (e.g. `new_creation_gated_pool`).
Weighed against the user's own two criteria — good data AND easy to disable — a combined
value would conflate two genuinely independent dimensions (provenance vs. lifecycle stage)
into one, forcing future analysis to string-parse a compound value apart. A separate column
keeps both dimensions independently queryable and makes disabling the feature a zero-risk
change (just remove the loop entry — the column and its rows are inert to every other query,
which already filters/groups on `category`/`candidate_source` explicitly). The same
independence is also why `category` had to join the unique key (see migration 0015 above)
rather than get appended as a plain column: without it, a real token moving from
`new_creation` to `near_completion` would collide on the existing key and silently overwrite
one lifecycle-stage observation with the other.

**Rollout is intentionally conservative**: the new `discovery-new-creation` loop
(`main.ts`) runs every 5 minutes (`DISCOVERY_NEW_CREATION_INTERVAL_MS`), slower than the
2-minute `near_completion` discovery loop, and started with a staggered initial delay so
the two don't fire in the same tick. This is deliberate: it was wired up in the same session
as the rate-limit crisis above (wallet-scoring cap, gmgn-smartmoney pacing+cap) — adding a
brand-new GMGN-calling loop (6 weight/cycle) onto an already-stressed shared budget, before
that crisis was confirmed resolved in production, would be reckless otherwise. If rate-limit
problems recur, `discovery-new-creation` is the first thing to check/disable, and doing so
touches zero rows belonging to the existing `near_completion` discovery loop.

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

## Trade modes since 2026-09-27 (explicit user decisions)
- **Trades are opened ONLY by the realtime path** (`handleRealtimeEntryEvent`, PumpPortal
  websocket, our watchlist wallets). GMGN smartmoney and the (unwired) wallet-activity
  poller write the signal to `decision_log` only. Their old log_only trades linked the
  token's decision_log row, which blocked the live path from claiming the same token.
- **`paper` = "wanted live, couldn't"**: every non-live outcome of `attemptLiveEntry`
  (capital, kill-switch, lost reservation, failed swap, unreadable wallet) opens `paper`.
  `log_only` is no longer produced anywhere. The open-trades cap counts only live/paper.
- **Graduated tokens** (off the bonding curve): priced from the trade itself
  (`solAmount/tokenAmount`, dust < 0.01 SOL ignored) in `priceFromTradeEvent` — this also
  keeps stop-loss/trailing working for any open trade whose token graduates (previously
  it froze live trades as `needs_manual_exit`). Entries on graduated tokens open **paper
  only** while `LIVE_ON_GRADUATED_TOKENS = false` (`paperTradingConfig.ts`), tagged
  `token_stage='graduated'` in `trigger_wallet_snapshot_json`. Evaluate with
  `railway run npm run graduated-report`; flip to `true` only if positive.
- **PumpPortal bills 0.01 SOL per 10k streamed trades** to the API-key wallet and rejects
  all subscriptions below 0.02 SOL — the live entry path and fast exits then go silent.
  `PumpPortalConnection` detects this, alerts via Telegram (≤1/hour) and retries every
  5 min so a top-up recovers without a restart. The "SWITCH TO PUMPAPI.IO" token that
  appears in that wallet is a competitor's ad airdrop, not what drains it.
- `/resume_live` records `resumed_at` (migration 0016); the consecutive-loss streak only
  counts live trades closed after it.

## Live sells, duplicates and the 4B trailing shadow (2026-09-28)
- **A gmgn-cli error on a sell is not proof it failed.** Trade 6442 (3RNy7erx…) was frozen
  as needs_manual_exit although the sell had executed on-chain (+104%). After a sell error
  `executeLiveCloseAndFinalize` checks the real token balance (`live/sellVerification.ts`):
  gone + SOL received → close with real proceeds; still held → one retry; otherwise
  needs_manual_exit with the reason. gmgn-cli prints the confirmation banner and
  "Proceeding non-interactively" on EVERY swap before the real error — `summarize()` skips
  them; the full CLI output is stored in `trade_execution_errors.error_detail_json`.
  GMGN business errors (e.g. 40003701) arrive as CLI API errors and are mapped to
  `SwapFailedError(errorCode)` in `swap.ts`.
- **One entry per token**: `withTokenEntryLock` (in-process, per mint) + skip if the token
  already has an open trade — 4 tokens had been bought live 2-3× within seconds.
- **Missing native orders** (none of the 14 frozen trades had one) are recorded with the
  full swap response; Telegram says "LIVE ⚠️ χωρίς native order".
- **4B trailing in SHADOW mode** (migration 0017, `realtime/shadowExit.ts`): grace
  `TRAILING_GRACE_MS` (no trailing exit right after entry; stop-loss still immediate) +
  confirmation `TRAILING_CONFIRM_MS` (price must stay below the stop, not one tick). Runs on
  the same ticks as the real logic, independently, and keeps running after the real exit;
  NEVER affects a real exit. Compare with `railway run npm run trailing-shadow-report`;
  apply to real exits only if it wins across all trades.

## On-demand gate (2026-09-28)

- Measured before: realtime entries happened a median 20–26 min after token creation. A watched-wallet buy became a trade only if discovery (GMGN trenches, every 2/5 min, and only once GMGN counted ≥1 smart wallet) had ALREADY passed the token, so the first, cheapest buy was lost (`gate_not_passed`).
- Now (`src/decision/onDemandGate.ts`, `src/realtime/onDemandGateRunner.ts`): when a watched wallet buys a bonding-curve token with NO gate evaluation at all, we check it on the spot with `gmgn-cli token info` + `token security` (weight 1+1, priority 900, ≤20 checks/min, one check per token) using PHASE1_THRESHOLDS.
- Mapping: top_10_holder_rate exact; bundler = security.bundler_trader_amount_rate else info.stat.top_bundler_trader_percentage; entrapment = info.stat.top_entrapment_trader_percentage; rug_ratio / suspected_insider_hold_rate only if GMGN returns them (the real sample did NOT — recorded as `unavailable`); smart degen ≥1 = the trigger wallet itself. Required fields are fail-closed.
- Evaluations are stored in decision_log with `candidate_source='on_demand'` (migration 0018); trades carry `trigger_wallet_snapshot_json.gate_source`. A token already rejected by discovery is never re-checked — except when the ONLY reason was `smart_degen_count` (2026-09-30).
- Paper-only (`LIVE_ON_DEMAND_GATE=false`) until `railway run npm run on-demand-gate-report` says ✅.

## Signal sources & filters after 2026-09-29

- Graduated tokens: signals are ignored completely (no live, no paper) while LIVE_ON_GRADUATED_TOKENS=false.
- GMGN smart money channel (`collectors/gmgnSmartMoney.ts`): removed from the scheduler — it opened no trades since 2026-09-27 and only consumed GMGN budget. Code kept for reference.
- Holder risk (`decision/holderRiskCheck.ts`, moved from that channel): checked on every realtime entry, stored in `entry_timing_json.holder_risk`. Mode per gate source (`HOLDER_RISK_ENTRY_MODE`): discovery → `'block'` (checked before the buy, ≥50% skipped — same population as where the threshold was measured); on_demand → `'record'` (parallel, no blocking) until `npm run holder-risk-report` confirms it for early entries.
- 4B trailing shadow keeps running a few more days (no GMGN cost) before it is removed.
- Second shadow, **"no exit_signal"** (migration 0020, `nosig_*` columns, `NO_EXIT_SIGNAL_RULES` + `ignoreExitSignal` in `realtime/shadowExit.ts`): today's exits (trailing +50%/−25%, floor +10%, stop-loss −50%, 24h timeout) but NOT selling when the copied wallet sells. Question it answers: would letting trailing work beat following the wallet's exit? Data 2026-09-29: 27/34 on-demand trades exited via exit_signal within ~30″ (avg −7.2%), only 1 had reached ×1.5. Compare with `npm run no-exit-signal-report` (split on_demand / discovery). Shadow repository functions take a `ShadowVariant` ('4b' | 'nosig'); column names come only from a fixed map.

## Wallet quality: snipers vs holders (2026-09-29)

- Per-wallet copy results (26 wallets, 229 trades since 09-27): wallets whose own sell comes < 2′ after their buy (exit_signal) → −0.34 SOL over 187 copies; ≥ 2′ (or no early sell) → +0.09 SOL over 42. GMGN win rate (our admission criterion) did not predict our result at all (≥50%: −0.15 SOL, <50%: −0.11). One sniper wallet (DJze9rks…) alone: 57 trades, −0.18 SOL — unwatched.
- Copying a sniper loses structurally: we buy after them and sell after their dump.
- Now recorded on every scoring (migration 0021): `watchlist_wallets.avg_holding_sec` / `wallet_score_history.avg_holding_sec` from `pnl_stat.avg_holding_period` (same `portfolio stats` call, no extra cost). NOT a filter yet — pick the threshold with `npm run wallet-holding-report` (distribution + our copy results per bucket and per candidate threshold).

## Exit & signal changes (2026-09-30, explicit user decisions)

- **No exit on the copied wallet's sell** (`EXIT_ON_COPIED_WALLET_SELL = false`, `decideForTick`): both early (on_demand) and discovery entries, live and paper. Exits = trailing (+50% / −25%, floor +10%), stop-loss −50%, 24h timeout. Evidence (`no-exit-signal-report`, same ticks): on_demand 28 trades median −2.1% → +17.6%, +0.17 SOL; discovery median −3.0% → +14.0%, +0.19 SOL (excluding the bogus #6779). The wallet's sell is now just a price tick.
- `LIVE_ON_DEMAND_GATE = false` again (report: 100 trades, −0.39 SOL, median −7.0%) — re-evaluate with the new exits.
- Shadows: new trades no longer open 4B / nosig shadows (4B worse: 28 worse vs 17 better, median −2.6%; nosig is now the real logic). Open shadows finish within 24h; reports stay for history.
- `holder-risk-report` verdict compares **per trade** (SOL/trade and mean %), not bucket totals — the ≥50% bucket is the largest, so its total always looked worse. On 2026-09-30 per trade it was the same (−0.0041 vs −0.0047 SOL) → stays `record`.
- Wallet-discovery trending widened to 24h volume, age 1h–3d, ATH ≥ $250k, limit 100 (the 6h/≤24h/$300k query gave ~8 tokens → `tokens=0` cycles overnight).
- **Bug #6779 (fake +7555%)**: `recordTrigger` claims the decision_log row, the trade is linked seconds later; a discovery `upsertDecisions` in that gap wiped the trigger snapshot (`source_channel`, wallet) → the exit resolver treated the SOL-priced trade as USD and closed it with USD candles (same failure as #6451). Fixed twice: the upsert never rewrites a row claimed by a realtime signal, and `isSolPricedTrade` also trusts `paper_trades.entry_timing_json` (written only by the realtime path; `PaperTrade.hasEntryTiming`). `repair-usd-priced-exits` now finds these too — run dry, then `-- --apply`.

## MIRROR route — exact copy of chosen wallets (2026-09-30, explicit user decisions)

- `/mirror <address> [name]` marks a wallet `watchlist_wallets.copy_mode='mirror'` (migration 0023; adds it as manual if new, sets active, subscribes it on PumpPortal immediately). `/unmirror` → back to `signal`; `/mirrors` lists results. Mirror wallets never give normal argus signals (`realtimeEntryHandler` returns early) and are never auto-deactivated by scoring (`decideLifecycleTransition`).
- Rules (same as the hermes-copyist design): EVERY buy of the wallet = one buy of `MIRROR_BUY_SOL` (env, default 0.1); every sell = sell the SAME % of our position (% from PumpPortal `newTokenBalance`, confirmed in the real event; fallback our running estimate; if nothing is known → full exit); wallet's full exit (≥99%) closes the position. One open position per token (partial unique index) — another mirror wallet on the same token is logged, not traded. Pump.fun / PumpSwap pools only (`pump`, `pump-amm`). No gate, no filters, **no stop-loss** (explicit choice: only the wallet decides the exit).
- **Paper only** (`MIRROR_MODE='paper'`): buy at the event price + 3% slippage, sell at the event price (dust sell with no price → last known price), pnl = out − in − 2% fees on in. Live is a separate future step.
- Code: `src/mirror/mirrorDecision.ts` (pure), `mirrorHandler.ts` (per-token serialization + one DB transaction, idempotent on signature), `db/repositories/mirror.ts`. Tables: `mirror_positions` (one row per position, cumulative sol_in/sol_out/tokens), `mirror_events` (EVERY event of a mirror wallet with the action: buy_open, buy_add, sell_partial, sell_close, ignored_pool / no_price / other_wallet_position / no_position). After `/unmirror`, the wallet's SELLS keep being mirrored until its open positions close.
- Telegram: one message on open and one on close (with pnl, buys/sells count); adds/partials only in the DB. Report: `railway run npm run mirror-report [-- days]`.
- **Two event sources** (2026-09-30): PumpPortal (realtime) AND a GMGN `portfolio activity` poller (`src/mirror/mirrorPoller.ts`, every 15s, mirror wallets + wallets with open mirror positions). Added because `mirror_events` stayed empty although chriskogias bought Pump.fun tokens after `/mirror` — PumpPortal apparently did not deliver them. Both feed the same `handleMirrorEvent(event, source)`; the tx signature (= GMGN `tx_hash`) dedupes, so whichever arrives first is recorded and the other is `duplicate`. Every `mirror_events` row has `detail_json.source` (`pumpportal` | `gmgn`; missing = pumpportal, pre-poller) and `mirror-report` shows the split — a `gmgn` row means PumpPortal missed it.
- GMGN → event mapping: `solAmount = quote_amount` (only when `quote_address` is SOL, native `So111…111` or wrapped `…112`), `tokenAmount = token_amount`, price = sol/tokens (pool `pump-amm`, no curve fields — matches GMGN's own `price` field). Launchpad from the activity row's `launchpad_platform` (fallback `token info`): only `Pump.fun` → `pump-amm`, anything else → `other` (logged as `ignored_pool`). A sell with `is_open_or_close = 1` is treated as the wallet's full exit (`newTokenBalance: 0`) — **assumption** (confirmed only for buys = first buy in the fixture); otherwise the % comes from our balance estimate. First poll after a restart looks back 300s; cursor per wallet in memory.
- **Result of the two sources** (first day): 4/4 events came from `gmgn` — PumpPortal sends NONE of chriskogias' trades (probably because he trades through a bot/router; not fixable on our side). GMGN sees them ≥15″ late, which makes the paper result optimistic (we copy at his price).
- **Third source: Helius** (`src/solana/heliusLogsListener.ts` + `heliusRpc.ts`, `src/mirror/heliusTrade.ts`, `heliusMirrorSource.ts`): Solana `logsSubscribe` (mentions = wallet, one subscription per wallet, commitment confirmed) on `wss://mainnet.helius-rpc.com/?api-key=HELIUS_API_KEY` → `getTransaction` (jsonParsed, retried while null) → `parseWalletTrade` reads ONLY balance changes, so it works whatever bot/router was used: exactly one non-wSOL token of the wallet must change (else skipped), `newTokenBalance` = post balance, SOL = the counterparty's (bonding curve / pool vault) largest lamport change when plausible vs the wallet's own SOL change (which also contains bot fee / tip), else the wallet's; network fee and token-account rent are removed. Pool = `pump` if program `6EF8rr…` is in the tx, `pump-amm` for `pAMMBa…`, else `other`. Source `helius`; detail_json has `lag_sec` (block → processed), `program`, `sol_source`, `wallet_sol`, `pool_sol`. GMGN events now also carry `lag_sec`; `mirror-report` shows the median lag per source.
- **Gated by `MIRROR_HELIUS=on`** (plus `HELIUS_API_KEY`) because the sandbox cannot reach Helius — the parser is tested only on synthetic transactions. Verify first on real data: `railway run npm run helius-mirror-probe -- <wallet> [N] [--listen SEC]` (our reading vs GMGN for the same tx hashes: SOL/token differences, program ↔ launchpad, GMGN trades we did not read; `--listen` = live lag). The startup log line `[main] mirror πηγές: …` says which sources are running. First probe run: chriskogias' transactions are **version 1** — `getTransaction` needs `maxSupportedTransactionVersion: 1` (`MAX_TX_VERSION`), with 0 it fails with -32015. JSON-RPC errors are not retried (only null / network / HTTP 429 / 5xx). Second probe: chriskogias **pays in USDC** (~92k USDC; his bot does USDC→SOL→token in one tx, his SOL balance does not move) → every trade looked like two tokens changing. `STABLE_MINTS` (USDC, USDT) now count as payment: when the wallet's SOL change is negligible vs the USD paid, SOL = the pool side (`sol_source: 'pool_stable'`, `paid_stable`), accepted only if USD/SOL comes out $20–$2000 — otherwise `stable_pool` (pool quoted in USDC itself, e.g. CiyydVkn; not copied, same as the GMGN poller which skips non-SOL quotes).

- **Trailing for mirror — measured, not applied** (2026-09-30, user: "the big problem is that we have no trailing"). Two tools, the real mirror positions are never changed:
  - `npm run mirror-trailing-backtest -- [days]`: per mirror position, entry at the FIRST buy (`buy_open` fill price, `MIRROR_BUY_SOL`), argus exits (trailing +50%/−25%, floor +10%, stop-loss −50%, 24h) on GMGN 1m candles anchored to that price (`anchorCandlesToEntryPrice` + `resolveExit`), next to the wallet-following result (which includes every add).
  - **Shadow trailing** (migration 0024, `shadow_*` columns on `mirror_positions`, `src/mirror/mirrorShadow.ts`): on `buy_open` the handler sets `shadow_entry_price`; main subscribes the token on PumpPortal and every tick runs `checkTick` (+24h timeout, also swept in the mirror-poll loop by `expireMirrorShadows`); keeps running after the real position closes; token unsubscribed when its last shadow ends (unless a paper trade still needs it). `mirror-report` shows shadow vs wallet-following for the same positions.

- **On-chain replay** (`npm run wallet-onchain-replay -- <wallet> [hours=24] [--max N]`, `src/mirror/copyReplay.ts`): the wallet's real transactions via Helius (same data as Solscan, same `parseWalletTrade`), Pump.fun/PumpSwap SOL trades only, split into episodes (first buy → balance 0; episodes already held before the window are skipped), and per episode: his own result (pool-side SOL), "copy every buy" (today's mirror, 0.1 per buy) and "copy only the first buy" — both exit with him at the same %. Summary also per number of his buys (1 / 2-3 / 4+). First backtest (11 mirror positions, 2026-09-30): trailing was WORSE (1 win of 11) — he exits early and the tokens dump after; nearly the whole −0.52 SOL came from 2 positions where he added 6–12 times.

## Missed signals: skip log + smart_degen exception (2026-09-30, explicit user decisions)

- `npm run wallet-buys-check -- <wallet> [days] [--launchpads]`: a wallet's real buys (GMGN activity) vs what we did. For chriskogias (3JQvkiF2, 7 days): 189 tokens, 121 Pump.fun (57 of them WITHOUT the "pump" mint suffix — suffix is NOT a reliable Pump.fun test), 43 stonkfun, rest xStocks/DEX. Of the 121 Pump.fun we traded 20, the gate rejected 18, 84 were missed (57 never reached decision_log at all).
- **`realtime_entry_skips`** (migration 0022, `recordEntrySkip` in `realtimeEntryHandler.ts`): every buy by one of OUR wallets that did not become a trade, with reason (gate_not_passed + on-demand outcome, wallet_inactive, open_trades_cap, no_realtime_price, graduated_off, token_already_open, entry_in_flight, holder_risk_high, claim_failed), PumpPortal `pool`, `has_curve_data`, sol amount, mcap. Buys by non-watched wallets (token subscriptions) are not stored. `wallet-buys-check` then shows per token: trade / skip reason / "no event — PumpPortal never sent it". Main hypothesis to verify: some Pump.fun tokens arrive with another pool or without bonding-curve fields → treated as graduated → dropped before any gate.
- **On-demand gate re-check** (`hasBlockingGateEvaluation`, replaces `hasAnyGateEvaluation`): a token that discovery rejected ONLY for `smart_degen_count` no longer blocks the on-demand check — when our wallet buys, it is the smart wallet. Any other evaluation (passed, other failure, earlier on-demand row) still blocks; one on-demand check per token.

## Wallet discovery source: top traders (2026-09-29)

- Explicit user decision ("θέλω το 3"): `collectors/walletDiscovery.ts` no longer uses `token holders --tag smart_degen` (it mostly found snipers). Now: `token traders --order-by profit --limit 50` (weight 5, `gmgn/traders.ts`) on ~10 tokens that ALREADY ran.
- Token source = `market trending` (weight 1, `gmgn/trending.ts`): Pump.fun, 24h, age 1h–3d, ATH market cap ≥ $250k (was 6h / ≤24h / $300k until 2026-09-30), bundler/insider ≤ 30%, by volume; a token scanned once is skipped for 24h (in-memory). NOT the recently graduated tokens: the first real check (token ~1′ old) returned 50 traders who were all dev_team/bundler/sniper/fresh_wallet or had held < 2′ — nobody passed, and many "completed" tokens graduate within 0–1s of creation (bundled launches).
- Real `token traders` response confirmed (2026-09-29): all fields we read exist (`address`, `addr_type`, `tags`, `maker_token_tags`, `realized_profit`, `realized_pnl`, `history_bought_cost`, `start_holding_at`, `end_holding_at`). Tags also seen: `dev_team`, `creator`, `axiom`, `gmgn`, `paper_hands`, `fomo`, `sandwich_bot`. `realized_pnl` is empty for wallets that never sold → `not_sold`.
- Free filter on the same response (`traderRejectReason`): addr_type 0; no `sniper`/`bundler`/`rat_trader`/`dev`/`fresh_wallet`/`transfer_in` in `tags` or `maker_token_tags`; realized ≥ 2x on that token; buy ≥ $50; held that token ≥ 2′.
- Already-known addresses are skipped BEFORE scoring (`listKnownAddresses`); ≤ 40 `portfolio stats` per cycle; wallets rejected at scoring are not re-scored for 24h (in-memory).
- Admission (`passesTopTraderThreshold`): the existing floor AND `avg_holding_period` ≥ 2′. Inserted as `source='top_trader'` with `avg_holding_sec` — measured separately in `npm run wallet-holding-report` ("Ανά πηγή").
- The `market trending` shape is still from SKILL.md (`data.rank`; the parser also accepts `rank`/`list`/array and fails loudly otherwise). Verify with `npm run top-traders-check` (prints the trending list, then the traders of its first token). A missing field means the trader is rejected, never admitted.

## Native GMGN strategies — what really happens (2026-09-29)

- `swap --condition-orders` ALWAYS answers `status: submitted` without `strategy_order_id` (20/20 live trades). The strategy IS created right after (smart_trade / mix_trade, visible in `order strategy list`). We treated it as missing → `native_order_active=false` → the reconciler never looked → when GMGN's stop-loss sold, the trade stayed "open" in our DB (8 such trades on 2026-09-28; 5 native loss_stops at ~−50…−59%).
- Now: `live/nativeStrategyAttach.ts` finds it after the trade INSERT (background, 6×2s, `pickStrategyForEntry`: same token, created since entry) and sets `live_strategy_order_id` + `native_order_active`.
- Real strategy fields: `status`/`strategy_status` `canceled` both when it sold (`reason_by: trade_finish`, `place_action: loss_stop|profit_stop_trace`, `order_statistic.success_sell_num ≥ 1`) and when WE sold (`reason_by: token_clear`, success_sell_num 0). `close_price` always empty.
- Exit result for sells outside our path: `live/ownSellRatio.ts` — our wallet's own buy/sell in `portfolio activity`, ratio = sell cost_usd / buy cost_usd (not check_price/usdt_profit — see incident #1225). The reconciler closes with it (`closeFromOwnSell`, real sell time as exit_at); falls back to needs_manual_exit only if no sell is found.
- One-off / repair: `npm run reconcile-native-exits` (dry run) → `-- --apply`.
- Swap status polling is 15×1s (was 3×5s — every live entry waited ≥5″ before the trade existed in the DB).
- LIVE_ON_DEMAND_GATE = true (explicit user decision, 2026-09-29) — back to false on 2026-09-30.

## Entry speed measurement (2026-09-28)

- Every realtime trade writes `paper_trades.entry_timing_json` (migration 0019): signal price/mcap, gate source, fallback reason, ms per step (lookup, on-demand gate, claim, live attempt, event→insert), and for live the `portfolio info` queue/exec time, swap queue/exec/confirm, post-swap time, executed price vs signal (`slippage_vs_signal`), GMGN report input+gas vs balance-diff, priority/tip fee. Same data as one `[entry-timing]` log line per entry.
- `runCli` accepts `onTiming` (limiter queue vs exec). The pre-swap `portfolio info` and post-swap balance now run at TRADE_PRIORITY (were 0 = same as collectors).
- Analysis: `railway run npm run entry-speed-report`. Decides (a) whether higher priority/tip fees are worth it (slippage grows with delay?) and (b) whether the pre-swap `portfolio info` can be dropped (report input+gas ≈ balance-diff?).
- Known: after the swap the trade is inserted only after balance + native-order verify (NATIVE_ORDER_VERIFY_DELAY_MS 4s) — realtime exits don't see it meanwhile; `postSwapMs` measures it.

## Price units: SOL vs USD (2026-09-28)

- Realtime trades (`source_channel = 'pumpportal_websocket'`) store entry/peak/exit prices in **SOL per token**. Everything from GMGN (kline candles, gate snapshot `price`) is in **USD**. Never compare the two directly.
- Incident: the exit resolver ran USD candles against SOL entries and closed realtime paper trades at ~×(SOL/USD) — trade 6451 "+7429%" produced the only ✅ of the first `graduated-report`.
- Fix (`exitResolver.ts`): SOL-priced trades are skipped until the 24h timeout (the tick path owns them); at timeout the candles are anchored to the entry price (`anchorCandlesToEntryPrice`). No GMGN activity call for them.
- Cleanup: `railway run npm run repair-usd-priced-exits` (dry run) → `-- --apply`. Marks affected paper trades as unknown outcome (`no_market_data`, pnl NULL); originals kept in `exit_trigger_detail_json.usd_price_bug`.
- `graduated-report` now needs a positive **median** too before it says ✅.

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

## Exit-path analysis (2026-10-04, explicit user request) — read-only

- `railway run npm run exit-path-analysis [-- --since <ISO>] [--no-cache]` (`scripts/exit-path-analysis.ts`, pure logic + tests in `src/analysis/exitPath.ts`). Realtime paper trades with ≥25h of life; 1m GMGN candles for the 24h after entry, anchored to the SOL entry price (same as the exit-resolver). Candles cached in `/tmp/argus-exit-path-cache.json` (a rerun costs 0 GMGN calls).
- Sections: A) simulation of today's rules vs the real paper result (sanity), B) price path — how fast winners reach +50%, how deep they dip before it (= which stop would cut them), what happens to trades flat at 15/30/60/120′, C) exit grid stop {20,25,30,40,50%} × time limit {15,30,60,120′, 24h} × mode {trail, half_tp, ladder} with REAL fees 4.5%/round trip, chosen on days 1–2 (train) and checked on days 3+ (test), D) entry filters (gate, mcap, wallet buy size, hour, holder risk, wallet trade_count / avg_holding_sec / win_rate / source), E) per trigger wallet with consistently negative (train AND test) → suggested `/unwatch` lines. Changes nothing.
- Conservative candle rule: low before high in the same minute (stop counted first); stop fills at the threshold or the open if it gapped below.
- v3 (2026-10-05, user: "opportunities every day but we never catch a big bang"): section **C2** — how many of our trades reached 2×/3×/5×/10× within 24h, and, with today's rules (stop −30%, 30′ limit), trailing −25% (current) vs −35% / −45% vs **moonbag** (`mode: 'moonbag'`: 1−bagFraction with the normal trailing, bagFraction with a wide trailing `bagDrawdown` until 24h; floor +10% after activation), train/test, plus what each captured on the ≥5× trades and the 12 biggest. `simulateExit` now takes `trailDrawdown`, `bagFraction`, `bagDrawdown`.
- v2 (same day, after the 1st real run failed sanity A: sim −8.2 vs paper −1.5 SOL, only 20% reached +50% vs ~40% in paper): anchoring USD candles to the close of the entry minute under-measured every pump that started inside that minute. Now token price in SOL = token USD / SOL USD at the same time (wSOL 5m candles, cached per day) — no assumption about the entry moment — plus 30s candles (GMGN's finest) for the first hour, 1m after. Prints a calibration line (candle price at entry ÷ the wallet's buy price, should be ≈1.03 = paper slippage). `--active-only` = only trades from wallets still active (how today's list would have done).

## Rules change 2026-10-04 (explicit user decision, from exit-path-analysis --active-only)

- Basis: 168 trades from still-active wallets, 30″ candles, simulation matched paper on 93% of exit reasons. Today's watchlist was positive (+2.06 SOL paper); the earlier losses came from now-inactive wallets (Finr5rgQ alone −2.41 SOL on 186 trades).
- `STOP_LOSS_PCT` 0.5 → **0.3** (cuts 9% of winners vs 18% at −20%; better on train AND test days; −20% avoided because live stops fill 1–2″ late). Also applies to the GMGN native backup order and the mirror shadow (both read the constant).
- **`time_limit` exit** (`NO_PROGRESS_EXIT_MS` = 30′): no trailing activation in 30′ → close at the tick price (`decideForTick`, after the price checks — a stop/trailing on the same tick wins). Paper and live (live goes through the normal pending-close path). A token with no trades keeps its curve price, so it closes on its next tick or at the 24h timeout as before.
- **`MIN_WALLET_BUY_SOL` = 0.3**: a watchlist wallet buy below 0.3 SOL gives no signal (skip `wallet_buy_too_small`, before the on-demand gate). Negative on train and test.
- `PAPER_ASSUMED_FEES_PCT` 0.02 → **0.045** (pump.fun 1.25% × 2 + GMGN 1% × 2) — paper and mirror pnl now use real costs.
- `LIVE_ON_DEMAND_GATE` → **true**. Live itself stays off until the user sets `GMGN_ALLOW_AUTOMATED_TRADES=1` after one paper day with the new rules.
- Exit mode stays trailing (half-TP and ladder measured clearly worse). Kill-switch unchanged (10 consecutive losses), daily loss cap 0.5 SOL.

## Realtime cost / GMGN load fix (2026-10-04, explicit user decision, after 4h of rejected PumpPortal subscriptions)

- Logs 14:00–18:00 UTC: PumpPortal rejected every subscription (API-key wallet < 0.02 SOL — 0.01 SOL per 10k streamed trades with ~850 subscribed wallets incl. bots) → no entries and no fast exits; GMGN IP ban ~35×/hour, 72 of ~170 from the GMGN mirror poll that only produced `duplicate` (Helius is first).
- `src/realtime/walletSubscriptionSync.ts`: wallets with `avg_holding_sec < 60` (`BOT_MAX_AVG_HOLDING_SEC`) are bots → not subscribed and no signal (entry skip `wallet_bot`); unknown hold time stays; mirror wallets always stay. New loop `realtime-wallet-sync` (every 10′, first after 5′): subscriptions = active non-bot wallets + mirror + wallets with an open trade; subscribes missing, unsubscribes extras (before, scoring/`/unwatch` deactivations stayed subscribed until restart). Wallet discovery also skips bots. `WatchlistWallet.avgHoldingSec` now loaded.
- `mirror-poll` loop no longer calls GMGN while the Helius mirror source runs (shadow expiry still runs there).

## Live only via on-demand (2026-10-05, explicit user decision)

- `LIVE_DISCOVERY_GATE = false`: discovery entries stay paper (fallback `discovery_gate_paper_only`); on-demand entries go live when `GMGN_ALLOW_AUTOMATED_TRADES=1`. First day of the new rules: discovery 1/11 wins, −0.28 SOL (enters ~13′ after creation at ~100 SOL mcap); on-demand 14/27, +0.18.
- `paperOnlyReason(graduated, gateSource)` in `realtimeEntryHandler.ts` is the single place that decides "don't even try live" (graduated / on-demand / discovery flags), tested.
- Plan: 0.05 SOL per position as a measurement run; after ~30 live trades compare live entry/exit prices with paper (`npm run entry-speed-report`: slippage vs signal). The open question is the live entry slippage (earlier 10 live trades: median +2.9%, mean +15.8%) against an on-demand paper edge of ~+6.6%/trade.

## Fixed buy slippage (2026-10-06, explicit user decision)

- Live buys use `--slippage 15` (`LIVE_BUY_SLIPPAGE_PCT`, `buySlippageArgs()` in `gmgn/swap.ts`) instead of `--auto-slippage`. entry-speed-report on 12 live buys: executed vs signal median +4.8%, mean +19.8%, p90 +57.7% — auto-slippage let buys fill after the price had already run. A buy that would move more than 15% between GMGN's quote and confirmation is rejected → `swap_failed` → the trade is paper. Sells stay `--auto-slippage` (always get out).
- Limit: the 15% covers quote→confirmation, not the ~1s between the wallet's buy and our request. Re-check `entry-speed-report` (slippage vs signal) after ~20 live buys.

## Winners report (2026-10-06, explicit user request) — read-only

- `railway run npm run winners-report [-- --hours 48 --top 20 --min-ath 300000 --traders 15]` (`scripts/winners-report.ts`). GMGN `market trending` 24h, Pump.fun, created within N hours, ATH ≥ min, ordered by ATH market cap → top N. Per token: dev (`portfolio created-tokens`: total / graduated / best ATH) and `token traders --order-by profit --limit 100` (pools excluded): ×, $ profit, cost, entry minutes after creation, entry mcap (avg_cost × supply), % sold, GMGN tags, funding source (`native_transfer`), ★ if in our watchlist. Cross-section: wallets ≥2× in 2+ winners, shared funders, devs with 2+ winners, our watchlist hits, and when/at what mcap the ≥10× traders entered (= how catchable the winners were).
- GMGN calls 1 + 2×top (traders weight 5, created-tokens weight 2), 1.5″ pacing, waits out bans. Nothing is stored.

## Paper experiment "filters drop the winners" (2026-10-06, explicit user decision)

- Basis (winners-why): in 13 of the 20 biggest Pump.fun winners of 48h our wallets bought (264 buys) and argus traded none — gate_not_passed 165 (mostly bundler 0.40–0.63 > 0.3, also rug 0.94, top10 0.79), wallet_buy_too_small 72, graduated_off 17.
- `PAPER_EXPERIMENT_ENABLED = true` (`paperTradingConfig.ts`): those buys now open **paper** trades tagged in `entry_timing_json.experiment` (and `trigger_wallet_snapshot_json.experiment`): `relaxed_gate` (token failed the gate or was never evaluated; `entry_timing_json.gate_fail_reason` = the rule, `on_demand_outcome`), `small_buy` (wallet buy < `MIN_WALLET_BUY_SOL`, no longer a skip), `graduated` (no longer `graduated_off`). Tags combine. Only the gate skip is relaxed — wallet_unknown/inactive/bot, open-trades cap, no price still skip.
- Never live: `paperOnlyReason(..., experiment)` → `experiment_paper_only` for any tag or `gateSource='none'`. No holder-risk call (GMGN weight 5) for experiment entries. No Telegram on open/close (`[realtime-entry] paper πείραμα` log line only).
- Isolation: relaxed entries get their OWN decision_log row (`recordExperimentTrigger`, `logic_version = <version>:exp`, candidate_source `on_demand`, category new_creation/completed, gate snapshot + fail reason copied from the token's latest evaluation) — discovery/on-demand rows, pass rates and `hasBlockingGateEvaluation` are untouched. An open experiment trade never blocks a normal entry on the same token (`countOpenNonExperimentTradesForToken`, and recordTrigger's same-wallet guard ignores experiment trades); an experiment entry needs the token to have no open trade at all.
- Reports that compare normal results must exclude `entry_timing_json ? 'experiment'` (done in `on-demand-gate-report`). `PAPER_EXPERIMENT_ENABLED = false` restores the old skips exactly.

## Mirror paused (2026-10-06, explicit user decision)

- "Stop /mirror, no more data there for now — don't delete anything." `MIRROR_ENABLED = false` (`mirror/mirrorConfig.ts`): no PumpPortal routing to `handleMirrorEvent`, no shadow ticks/expiry, Helius mirror source not started, `mirror-poll` does nothing, mirror wallets are not subscribed (`isRealtimeSignalWallet`/`desiredWalletSubscriptions` take `mirrorEnabled`), `/mirror` adds no subscription. Tables, rows, code and the `/mirror` `/unmirror` `/mirrors` commands stay (replies carry a "paused" line). Mirror wallets still never give argus signals (entry handler returns early). Set `true` to resume.

## Graduated price from the pool's market cap (2026-10-07)

- First experiment analysis: for graduated tokens `solAmount/tokenAmount` was 12–32% above `marketCapSol/1e9` of the same event, and some (router / multi-hop) trades gave absurd prices → fake peaks of 6–7× and stops at −98% (#7645, #7533, #7512; one entry at 0.12× the pool price). A token graduating mid-trade also jumped a fake ~+23% (on the curve vSol/vTokens = marketCapSol/1e9).
- `priceFromTradeEvent`: graduated events WITHOUT curve fields and with `marketCapSol` (PumpSwap) → `marketCapSol / PUMP_TOKEN_SUPPLY` (`priceFromMarketCap`); trade ratio only as fallback (no marketCapSol, or stale curve fields with pool≠pump). Applies to entries, ticks, stops/trailing, shadows.
- `entry_timing_json.signal.price_source` = `curve` | `mcap` | `trade`. Graduated trades opened before this change (no `price_source`) entered at the trade ratio but tick at the pool price (~−19% shift) — exclude them from graduated analysis.

## Bundler rule removed from the gate (2026-10-07, explicit user decision)

- `maxBundlerRate` (was 0.3) removed from `PHASE1_THRESHOLDS` — discovery (server-side flag and client-side check) and the on-demand gate no longer filter on bundler; the value is still recorded in the gate snapshot. Basis: winners-why (most of our wallets' big winners had bundler 0.40–0.63) and the paper experiment (tokens cut ONLY by bundler: 39 trades, +0.30 SOL, 7 reached 2× in 11h; rug_ratio was negative and stays).
- `logic_version` changes (hash of the thresholds): analysis by version starts fresh; tokens get one new on-demand check under the new version. Holder risk (bundler/sniper/rat % of float) unchanged. Wallet-discovery's trending filter (`gmgn/trending.ts`, bundler ≤ 0.3) is a separate filter and unchanged.
- This also affects live when it is on (on-demand entries on high-bundler tokens can go live).

## Helius as a second signal source + watchlist cut to ~250 (2026-10-07, explicit user decision)

- Evidence: `wallet-buys-check` — PumpPortal did not deliver 8/10 (HFXWWmQH) and 21/26 (u1c81Pop) of two top wallets' buys (incl. CLAUDIA 11–12×), although every subscription is confirmed ("Successfully subscribed", wallets=1077). Only 7% of the 918 top_trader wallets (44% of smart_money) produced any event in 48h. They buy through Axiom/Photon/Padre; PumpPortal's account feed misses those (same as chriskogias).
- `realtime/heliusSignalSource.ts`: Helius `logsSubscribe` per active signal wallet (non-bot, refreshed every 60″) → **free filter on the notification logs** (`isPumpBuyLog`: Pump.fun curve or PumpSwap program + `Instruction: Buy*`, or truncated logs) → `getTransaction` (1 credit/call) → `parseWalletTrade` (router-agnostic) → buys on `pump`/`pump-amm` only → `withPoolPrice`: pool state AFTER the trade from the same tx (curve: vTokens = curve token account + 73M (was 279.9M until 2026-10-08 — see below), vSol = curve lamports/1e9 + 30 → not graduated, so the on-demand gate runs; PumpSwap: marketCapSol = pool wSOL / pool tokens × 1e9); sanity 0.7×–2× of the trade's average price, else the average (`emitted_price_fallback`) → same `handleRealtimeEntryEvent`.
- `SignatureDedupe` is shared with the PumpPortal entry path (`runEntryForSignal` in main): whichever source sees a buy first wins. Exits stay on PumpPortal token ticks.
- Credits (free plan 1M/month; websockets are not metered on Free, 10 RPC/s): `HeliusCreditBudget` — `HELIUS_DAILY_CREDIT_BUDGET` (default 25,000/day) and `HELIUS_WALLET_DAILY_FETCHES` (default 150 per wallet per day); every getTransaction attempt counts (retries at 400/800/1500/3000 ms). When the daily budget is spent: no fetches until 00:00 UTC + one Telegram alert. Hourly log line `[helius-signal] <day> credits used/limit … counts={…}`. `HELIUS_SIGNALS=off` disables.
- Provenance: `entry_timing_json.signal_source` (`helius` | `pumpportal`) + `signal_lag_sec`; `realtime_entry_skips.detail_json.signal_source` for Helius skips; Telegram "νέο trade (helius)".
- Watchlist curation (one SQL, run by the user): keep 250 — tier 1 chriskogias (copy_mode mirror → signal) + active manual wallets, tier 2 watchlist wallets that made ≥3× in a winners-report token entering −5…60′ after creation (49 addresses, 2026-10-07 report), tier 3 our own copy results (≥3 closed trades in 14 days, pnl > 0), tier 4 fill by GMGN ROI (win rate ≥ 0.5, ≥ 15 tokens); never bots (avg hold < 120″, except manual) or `/unwatch`ed wallets. The rest: `active=false, deactivated_reason='curated'` (not re-scored, not auto-reactivated; `/watch` re-adds).
- `WALLET_DISCOVERY_ENABLED = false` (`collectors/walletDiscovery.ts`): no automatic additions until the Helius upgrade / next curation.

## PumpPortal replaced by Helius for prices (2026-10-07, explicit user decision)

- "No more PumpPortal top-ups." The API-key wallet kept draining: almost all streamed trades were third parties trading the tokens we hold (one token = 380 of 521 events in 1h40); with the experiment's 49 open paper positions it ran dry again ("Minimum balance not met for PumpSwap websocket data").
- `realtime/realtimeFeed.ts` — `RealtimeFeed` interface (connect/close, subscribe/unsubscribe wallet/token, walletSubscriptions); consumers keep the `PumpPortalConnection` name as a type alias of it.
- `realtime/heliusPriceFeed.ts` — `HeliusPriceFeed implements RealtimeFeed`: per token with an open position, `locatePool` (~4 credits once: getTokenLargestAccounts → owners → owner program; PumpSwap pool preferred, else Pump.fun curve; queued, 500 ms apart for the 10 RPC/s free limit, 5 retries 60″ apart) → `accountSubscribe` (free on the Free plan): curve account (base64, `decodeBondingCurve`: vTok u64@8 /1e6, vSol u64@16 /1e9, complete u8@48) or the pool's token + wSOL accounts (jsonParsed). Every change → synthetic tick (`helius-tick:<mint>:<slot>`, txType buy, solAmount 1) with the same units as PumpPortal (curve vSol/vTokens; PumpSwap marketCapSol) → `onPriceTick` (exit handler, unchanged) — plus an immediate tick with the current price on subscribe. Curve `complete` → re-resolve after 20″ (graduation → PumpSwap pool). Wallet methods are no-ops (signals come from `heliusSignalSource`).
- `main.ts`: with `HELIUS_API_KEY` the feed is Helius (`REALTIME_FEED=pumpportal` brings PumpPortal back); `onPriceTick` = exit chain (+ mirror shadows when enabled); log line `[main] realtime πηγή τιμών: …`.
- Experiment: `PAPER_EXPERIMENT_SMALL_BUY = false` — buys < `MIN_WALLET_BUY_SOL` are skipped again (negative in every combination; 17 trades −0.27 SOL).

## Paper experiment ended (2026-10-07 evening)

- ~1 day of data: 418 experiment trades −2.77 SOL vs 64 normal trades +0.19 SOL. Only "cut ONLY by bundler" was positive (+0.30, rule already removed); rug_ratio −0.32, not_evaluated −0.64, smart_degen_count −0.23, entrapment −0.33, graduated alone −0.77 (57 trades), small_buy −0.90. `PAPER_EXPERIMENT_ENABLED = false` → the old skips again (gate_not_passed, wallet_buy_too_small, graduated_off). The code and the tagged trades stay for later analysis.
- Stops overshoot: experiment stop_loss average −42% and normal −38.8% vs the −30% threshold (fills at the next tick after a gap).

## Two Helius bugs found in the first day's logs (2026-10-07 evening)

- **Every Helius signal was dropped**: `processHeliusSignal` claimed the signature in the shared `SignatureDedupe` and then `runEntryForSignal` found it "already processed" → 946 signals emitted, 0 trades and 0 skips with `signal_source='helius'`. Now `processHeliusSignal` only checks `has()`; the entry path claims.
- **Wrong PumpSwap program id** in `mirror/heliusTrade.ts` (`…WpMNtHVfk3KnA`); the official one is `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`. Effects until now: PumpSwap trades parsed as `program: 'other'`, `isPumpBuyLog` ignored PumpSwap buys, `HeliusPriceFeed.locatePool` found no pool for graduated tokens ("δεν βρέθηκε … pool" for ~28 tokens).
- Real cost on day 1: 1,069 credits for ~8h of 230–240 wallets (budget 25k/day) — the free plan is far from its limit.
- Diagnostics: the first 30 price fallbacks per process log `[helius-signal] price_fallback … spot/avg=…` (~40% of signals fell back to the trade's average price on day 1).

## Watchlist = wallets that won on top tokens (2026-10-07, explicit user decision)

- "Only wallets that made profits on the top coins — now we have noise and burn credits." `collectors/winnerWallets.ts` replaces the old discovery (GMGN win rate, `WALLET_DISCOVERY_ENABLED` stays false) as the ONLY automatic source of the watchlist, and prunes what it can't justify. Runs in the `wallet-discovery` loop, every 2h (first run 5′ after start). `WINNER_WALLETS_ENABLED = false` turns it off.
- Top tokens: same call as `winners-report` (`fetchWinnerTokens`: Pump.fun, created ≤ 48h, ATH ≥ $300k, by ATH, no bundler filter); up to 50 per cycle not scanned in the last 12h (`winner_tokens`, migration 0025).
- Winner trader (`winnerRejectReason`, top 100 by profit per token): addr_type 0, none of `EXCLUDED_TRADER_TAGS`, × = 1 + `profit_change` (fallback realized_pnl) ≥ 3, profit ≥ $300, cost ≥ $50, entered 0.5–60′ after creation (catchable; < 30″ = sniper/bundle), held ≥ 2′ → `wallet_winner_hits` (one row per wallet+token, refreshed on rescan; window by `first_seen_at`).
- Winner wallet = ≥ 2 top tokens in 14 days, or one ≥ 10×; ranked by tokens → max × → profit. Bot check with `portfolio stats` (avg hold < 2′ → never, cached 7 days in memory), ≤ 60 per cycle; only checked wallets are activated (`activateWinnerWallet`: insert or reactivate as `source='winner_trader'`; manual keeps its source; a `/unwatch` (`deactivated_reason='manual'`) is never overridden).
- Pruning (`planWatchlist`): active = manual + mirror + winner wallets (max `WATCHLIST_MAX` = 150) + wallets proven by OUR trades (≥ 3 closed in 14 days, positive pnl, no experiment trades). Everything else → `active=false, deactivated_reason='curated'`. Only when there are ≥ 30 winner wallets, so the first runs (empty table) don't empty the watchlist.
- Scoring never auto-deactivates `winner_trader` wallets (they often hunt big × with a low GMGN win rate). Earlier the same day the 304 `below_threshold` wallets were set to `curated` by SQL (scoring kept reactivating them).
- Log `[winner-wallets] tokens= traders= hits= winners= activated= deactivated= pruned= bots= rejected={…}`; Telegram 🏆 when something changed. GMGN per cycle ≈ 1 + 50×5 + 60×3 weight, paced 1.5″.

## Helius curve entry price was 16–40% too low (2026-10-08)

- `withPoolPrice` computed vTokens = curve token account + 279.9M. The curve's token account holds the WHOLE supply at creation (1B), not just the real reserves (793.1M); the extra 206.9M go to the pool at graduation. Correct: account + 73M (1.073B − 1B; `PUMP_CURVE_VIRTUAL_TOKEN_OFFSET`). The ticks (`decodeBondingCurve`, the curve account itself) were right, so every Helius curve entry was priced below the market and the first tick jumped up: true price / recorded = (vTok + 206.9M) / vTok ≈ 1.19 at creation, 1.41 at vTok 500M, 1.69 at 300M (signals deeper in the curve fell outside the 0.7–2× sanity check and used the trade's average price instead, which is roughly right). Matches `exit-path-analysis` calibration (candle price at entry ÷ our price, median 1.37).
- Paper results of Helius curve trades from 2026-10-07 19:00 UTC until this fix are inflated (fake +19…+69% at entry → easier trailing activation, bigger × and pnl). Correction for analysis: with k = 30 × 1.073e9, recorded p′ → vTok = (−206.9e6 + √(206.9e6² + 4k/p′)) / 2, factor r = (vTok + 206.9e6) / vTok, corrected gross = (1 + pnl_pct) / r (lower bound: also applied to fallback trades, which were already right).

## Impossible peaks on Helius price ticks (2026-10-08) — under investigation

- After the winner watchlist, paper showed peaks of 7,000–9,000 SOL mcap within 1–2′ of entry (e.g. #8151 HQbAXd3b, #8115 2jjEgRzf, #8069 AZ7ct58h) on tokens whose GMGN ATH is $9.5k–$49k and that never graduated. A Pump.fun curve cannot exceed ~410 SOL mcap (vSol ≤ ~115, vTok ≥ 279.9M), so those ticks were not that token's curve. Paper results since 2026-10-07 evening are NOT trustworthy until this is explained.
- Now: `decodeBondingCurve` rejects impossible curve states (vTok outside 250M–1.1B, vSol outside 25–150) instead of producing a price; every pool resolution is logged (`[helius-price] <mint>: curve … mcap … SOL` / `PumpSwap pool … base … quote … mcap …`).
- Diagnosis tool: `railway run npm run price-probe -- <mint> …` (`scripts/price-probe.ts`, ~6 Helius credits per token): mint program/supply/decimals, largest holders with their owner's program, raw curve fields (vTok, vSol, realTok, realSol, supply, complete), what `locatePool` picks now and its mcap, our trades on the token, and the counterparty balances in the Helius signal tx. Also confirms the 73M curve offset (curve token account − realTok should be 206.9M).
- **Cause found (same day, price-probe)**: the three tokens are Pump.fun **Token-2022 curves with a quote OTHER than SOL** (curve account 151 bytes; the curve PDA holds 0.001 SOL while realSol reads 0.957 / 85.4; AZ7ct58h already migrated to a PumpSwap pool with no wSOL account). Our pricing is SOL-only: the entry used curve lamports + 30 and the price feed decoded the curve's virtual reserves as SOL → nonsense prices. Fix: `withPoolPrice` returns `nonSolQuote` when the curve gains < 50% of the SOL the wallet paid, or the PumpSwap pool has no wSOL balance → `processHeliusSignal` returns `non_sol_quote` (no signal, counted in the hourly stats); the price feed already returns no price for them (`decodeBondingCurve` range guard, `locatePool` needs wSOL). The probe also confirmed the 73M offset (curve token account 999,722,018 − realTok 792,822,018 = 206.9M).
- Historical analysis: treat `price_source='curve'` trades with peak mcap > 450 SOL as non-SOL tokens (a SOL curve can't get there; graduated SOL tokens are priced from the PumpSwap pool) and exclude them.

## Wallet scoring: Bayesian + Thompson sampling (2026-10-09, explicit user decision)

- User rejected simple sums / fixed thresholds ("something smarter"). `decision/walletScore.ts` (pure, tested) + `wallet_scores` (migration 0026), recomputed every 5′ by the `wallet-scores` loop (DB only, no GMGN) from OUR closed trades since `CLEAN_SINCE` (2026-10-08 12:30 UTC, after the Helius price fixes), no experiment trades.
- Per wallet: Bayesian estimate of net return per trade — skeptical prior mean 0 with strength 8 trades (`PRIOR_STRENGTH`), returns clipped to [−100%, +200%] so one moonshot can't make a wallet "certain", pooled per-trade sd (floor 0.5), exponential time decay (half-life 2.5 days). Paper returns are charged the real entry cost (`slippageFor`: the wallet's own live `slippage_vs_signal` mean with ≥3 live trades, else all live trades with ≥5, else 5%); live trades count as they are. Outputs mean, sd, lcb (80%), ucb (90%).
- Status: `blocked` = weight ≥ 12 and ucb < 0 (90% sure it loses) → the loop sets `active=false, deactivated_reason='scored_out'` + Telegram 🚫 (applies to manual too; never to mirror). `scored_out`, like `/unwatch` (`manual`), is never reactivated by winner-wallets. `proven` = lcb > 0 with ≥ 5 trades. Otherwise `exploring`.
- Live gate (`WALLET_SCORE_LIVE_GATE = true`): on every entry that would try live, `thompsonLive` draws one sample ~ N(mean, sd); live only if > 0 (and ≥ 3 trades, not blocked) — else paper with fallback `wallet_score_paper`. Good wallets go live almost always, uncertain ones sometimes, bad ones stop. The live switch itself (`GMGN_ALLOW_AUTOMATED_TRADES`) and all risk limits are unchanged.
- winner-wallets pruning: "proven by our trades" now = `wallet_scores` with mean > 0, not blocked, ≥ 3 trades (was 14 days of pnl_sol incl. the bad-price trades of 2026-10-07).
- Consensus (logged only): every buy of an active watched wallet (any size) → `wallet_token_buys` (first buy per wallet+token with the wallet's score at that moment; later buys increment `buys`/`sol_total`). Each trade's `entry_timing_json.consensus` = wallets / positive / proven that bought the same token in the last 10′ (`CONSENSUS_WINDOW_MIN`), and `entry_timing_json.wallet_score` = score, sample, decision. Queries: `wallet-scores-consensus.sql` (scratch) — scores with live chance, pnl by consensus at entry and ±10′ around entry, Thompson decisions.

## Entry mcap limit for non-proven wallets (2026-10-09, explicit user decision)

- Clean data (311 on-demand trades since CLEAN_SINCE): the stop-loss trades were the LATE entries (median entry mcap 82 SOL vs 59 for trailing exits). Non-proven wallets: < 40 SOL → 45 trades, 0 stops, +8.2%/trade · 40–50 → +1.5%, 55% stops · 50+ → −7.2%/trade, −0.65 SOL over 179 trades. Proven wallets win at any mcap (50+: +37.8%/trade). The 3 proven wallets are exactly the ones that buy early (median 41 SOL) and big (~3 SOL); 8ZN71XTd enters at ~33 SOL with ~4 SOL, 0 stops in 24 trades.
- Mechanism: a Pump.fun curve starts at ~28 SOL mcap and never trades below it, so an early entry has a bounded worst case (below ~40 SOL the −30% stop cannot even trigger).
- `MAX_UNPROVEN_ENTRY_MCAP_SOL = 40` + `entryMcapAllowsLive(status, mcap)` (`decision/walletScore.ts`): a wallet whose score at entry is not `proven` goes live only when the entry mcap (signal price + paper slippage × 1B, same basis as paper's `simulated_entry_price`) is below 40 SOL; otherwise paper with fallback `wallet_mcap_paper`. Under `WALLET_SCORE_LIVE_GATE`, after the Thompson check. Paper still opens (we keep measuring). `entry_timing_json.wallet_score.entry_mcap_sol` / `mcap_allows_live` record it.

## Pre-live review fixes (2026-10-09, before turning live on)

Independent code review of the live path after the Helius changes (two reviewers; each finding checked in the code before fixing):
- **Native-order sells were recorded with pnl NULL**: our stop/trailing uses the same thresholds as the GMGN backup order, so the native order often sells first → our sell fails with 40003701 → `tryReconcileAlreadyClosedByNativeOrder` closed from `close_price` (always empty) → pnl NULL, invisible to the kill switch (null breaks the streak) and the daily loss cap (nulls skipped). Now it uses our own on-chain sell (`findOwnSellRatio`, 3×5″ at `TRADE_PRIORITY`, gives up on a rate limit) → `closeFromOwnSell`, same as the reconciler. The `gone_elsewhere` verdict of `verifySellAfterError` (native sold before it was attached) does the same (once per attempt) before falling back to needs_manual_exit.
- **A filled buy could become a paper trade**: the post-buy `getLiveSolBalance` was inside the buy's try → a 429 gave `swap_failed` → paper trade, tokens in the wallet, never sold by us. Now only `executeLiveBuy` errors mean `swap_failed`; a failed balance read is recorded and the trade stays live.
- **Entry amount sanity** (`liveEntryAmountSol`): balance diff only within 0.5–2× of the position size, else GMGN report input+gas (SOL), else the position size (a stale ≈0 diff made every exit look like pure profit).
- **`LIVE_SOL_RESERVE_SOL = 0.03`** always left for sell fees; **`LIVE_MAX_OPEN_POSITIONS = 5`** (fallback `live_positions_cap`; count is not atomic with in-flight buys, capital reservation bounds the overshoot).
- **Dead tokens never closed**: Helius only notifies on account changes, so a token with no trades gave no ticks → no time_limit / 24h timeout (paper was closed by the exit resolver at 24h, live never). `HeliusPriceFeed` now re-emits the last tick every `HEARTBEAT_MS` (60″) for silent tokens (same price → peak/trailing unchanged; signature `helius-hb:<mint>:<ts>`; not while the socket is down; `lastTick` cleared on graduation recheck / failed resolve so no stale curve price). Pool resolution keeps retrying every 5′ after the first 5 failures instead of giving up.
- Known, accepted: Telegram exit reason for an own-sell close may differ from the DB reason; a duplicate alert is possible if the reconciler closed first.

## Token dev recorded on on-demand checks (2026-10-09)

- User: the best wallet 8ZN71XTd ("aNate") is often the token's own dev — his "buys" right at ~33 SOL mcap are his own launches. `token info` already returns `dev.creator_address` / `dev.creator_open_count` (same call, no extra cost); the on-demand gate snapshot now stores `creator_address` and `creator_open_count`. `recordTrigger` keeps `gate_snapshot_json`, so "copying the dev" = `d.gate_snapshot_json->>'creator_address' = d.trigger_wallet_address`. Logged only, no filter. Trades before this have no creator recorded.

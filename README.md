# 🪰 Swarm the Fly

**Ultra-low-latency wallet-swarm alert bot for Robinhood Chain.**

Swarm the Fly monitors a curated set of wallets and fires an alert the moment
*multiple* tracked wallets buy or sell the **same token** inside a short time
window — coordinated accumulation, coordinated dumps, and capital rotation —
before the broader market reacts. Detection runs entirely in memory for
sub-second latency; Postgres and Redis are optional archival layers.

Built from the *Robinhood Chain Alpha Intelligence* spec and seeded with the
**Robinhood Smart-Money Conviction List** — 15 tokens (8 curated + 7 auto-fetched
top coins) and 131 real tracked wallets, tiered by holder rank, with 10
cross-coin conviction wallets. Refresh/expand the list any time with
`node scripts/fetch-holders.mjs SYMBOL …`.

---

## What it does

| Capability | Detail |
|---|---|
| **New-coin discovery** | ≥ N tracked wallets buy the **same token that isn't on the list** → 🆕 alert with the contract, and the token auto-registers on the dashboard. This is the early-signal mode: it follows the *wallets*, not a fixed token set. Toggle with `DISCOVERY_MODE` |
| **Swarm detection** | ≥ N unique tracked wallets BUY the same token within a window → alert |
| **Safety filter** | before any alert fires, the token is screened via GoPlus token-security (honeypot, buy/sell tax, mintable, ownership, LP lock — supported on Robinhood Chain) + a minimum DEX liquidity check; rugs/honeypots are suppressed (still shown on the dashboard, tagged). Tunable via `SAFETY_*`, degrades to a liquidity-only check if GoPlus is unreachable |
| **Solo low-cap alerts** | a *single* tracked wallet buying a coin fires an alert too — but only when the token's market cap is inside the band `SOLO_MIN_MARKETCAP`–`SOLO_MAX_MARKETCAP` (default $25k–$120k), to catch early low-cap entries without dust or large caps |
| **Fresh-pair first entry** | fires when a qualifying-tier wallet (`FRESH_ENTRY_TIERS`, default alpha+beta) makes its *first-ever* buy of a token whose DEX pair is younger than `FRESH_PAIR_MAX_AGE_HOURS` (default 48h) — the purest "ground floor" signal |
| **PRIME tier** | the loudest alert — flagged when the swarm's kind + conviction hit the combo that actually backtested well (`PRIME_KINDS` default `ENTRY` @ `PRIME_MIN_CONVICTION` default 80, derived from real tracked-call outcomes). PRIME alerts get a 👑 crown headline, a multiplied 🪰 fly banner, and the kind icon itself repeats 3x — same treatment on Telegram, webhooks, Discord (gold embed), and the dashboard (👑 PRIME badge). Toggle with `PRIME_ALERTS` |
| **Global alert floors** | *every* alert type is gated by `ALERT_MIN_MARKETCAP` (default $25k) and `PAIR_MIN_AGE_MINUTES` (default 30 min) — nothing below the cap floor or on a pair younger than the age floor ever fires. Both **fail closed on an unknown value**: a token whose market cap cannot be established is suppressed, not waved through |
| **Real market cap** | market cap is fetched live at alert time, so every alert reports the true cap it was bought/sold into — or reports it as **unknown**. It is never estimated: a cap requires a real price AND a total supply read from the contract |
| **ATH market cap** | every card also shows the highest market cap seen for that token since the bot started tracking it, and how far the current cap is off that peak (e.g. "🏔️ ATH 2.1M (-64%)") — DexScreener doesn't expose a true lifetime ATH, so this is a running high-water mark, not the coin's all-time record |
| **One-tap buy links** | alert cards, Discord embeds, and the dashboard include clickable buy buttons for Sigma bot (🎯 SGM) and Based bot (🎲 BSD), pre-filled with the token contract via your own referral id. Configure with `SIGMA_REF` / `BASED_REF`; blank hides that bot's button |
| **Volume + momentum** | alerts show 24h volume, recent price change, and buy pressure; when volume + direction confirm momentum the alert is flagged 🔥 and conviction is boosted (up to +15). Optional `MOMENTUM_MIN_VOLUME_USD` gate suppresses dead tokens |
| **Repeat / escalation counter** | every alert reports how many times the *same token* has alerted inside a rolling window (`REPEAT_WINDOW_MINUTES`, default 35) — "🔁 REPEAT x3 · 3rd alert in 35m" — plus the **% price move since the previous alert** and how many **distinct** tracked wallets have driven it. It's **wallet-aware**: a brand-new top holder joining always breaks through the cooldown and is highlighted harder ("🚨 NEW HOLDER IN"), while the *same* busy wallet re-buying the same coin is suppressed so it can't hog the feed or masquerade as a swarm. Escalation conviction is keyed on distinct wallets (+4 each, capped +12) with an extra +4 when a new holder joins. Dashboard rows show a `🔁x{n}` / `🚨 NEW HOLDER` badge with the % move |
| **Sniper (auto-buy)** | optional **Sniper** dashboard tab that auto-buys qualifying alerts with a server **hot wallet** (ethers). Settings: buy-conviction band (default 60–100), buy amount (0.0005 ETH minimum), and a **take-profit %** that auto-sells a position when it hits target. Shows live **positions**, current value, and **PnL** (open + realized). Trades **both Uniswap v4 (Robinhood's modified router) and plain Uniswap v3** — some tokens' real liquidity lives on v3, not v4. Before every buy or sell, the quoted price is sanity-checked against the token's own known market price — a token can have several v4 pools (fee-tier variants, or a near-empty pool created moments before a snipe specifically to trap bots) and its *real* liquidity can be on v3 entirely; a pool that resolves to a wildly different price is refused rather than traded, even though nothing "reverts", and the other venue (v3 ⇄ v4) is tried automatically instead. Among multiple v4 pool candidates, the one with the most on-chain liquidity is picked, not just the most recently created; v3 candidates are picked the same way across the standard fee tiers. A sell that reverts on normal slippage (`SNIPER_SLIPPAGE_PCT`, default 15%) — e.g. a fast-crashing token moving past tolerance while the tx is in flight — retries once at a much wider tolerance (`SNIPER_MAX_SELL_SLIPPAGE_PCT`, default 50%) so you don't get stuck holding a position that won't sell; buys never do this. **OFF by default**; real swaps only run once a dedicated burner wallet + verified DEX router are configured. Rails: per-trade cap, daily spend cap, and an on/off kill switch. Admin-gated. See `SNIPER_*` |
| **Outcome tracking** | after every alert fires, the token's price is followed and the peak + 1h/6h/24h returns are recorded, so signal quality is measured from **real results** rather than guessed. The `/api/performance` view (and dashboard **Best Calls** card) ranks calls by peak gain and breaks win-rate down by the dimensions that catch runners — **multi-wallet vs solo**, **repeat vs single**, **kind**, **conviction band**, **entry market cap band**, **token age at entry**, and **individual tracked wallet** (by label, e.g. "which wallet's calls actually run"). The full breakdown — each stat stacked in its own scrollable block, not a jumbled row — plus every tracked call (now tagged with the wallet labels and pair age behind it) lives on the dashboard's **📈 Plays & Stats** tab. The Best Calls list clears itself once a day (`PERF_AUTO_RESET`, default 8am `PERF_RESET_TZ`) and can also be reset on demand via the admin 🔄 Reset button. Tunable via `PERFORMANCE_TRACKING`, `PERF_SAMPLE_MINUTES`, `PERF_TRACK_HOURS`, `PERF_WIN_THRESHOLD_PCT`, `PERF_AUTO_RESET`, `PERF_RESET_HOUR`, `PERF_RESET_TZ`. Set `PERF_STORE_PATH` to a mounted Railway Volume (e.g. `/data/performance.json`) to persist outcomes across redeploys — otherwise the data is in-memory and resets on restart |
| **PnL milestone cards** | every time a tracked call's peak return crosses a new 50% interval (+50%, +100%, +150%, …) a celebratory card fires to every configured channel — 🚀 rockets scaling with the milestone size, entry MC → now MC, current vs peak return, conviction, and which tracked wallet(s) called it. A jump that skips several intervals between samples (a fast pump) announces each one it passed through, not just the top. Toggle with `PERF_MILESTONES_ENABLED`, change the interval with `PERF_MILESTONE_STEP_PCT` (default 50) |
| **Telegram slash commands** | send `/t5` or `/t10` in the alert chat for the best-performing calls in the last 24h (ranked by peak gain), or `/l5` for the 5 most recent calls regardless of performance — each replies with one compact line per ticker: `#1 $GME 200k - 1.1 mill 5x -10mins ago 7/10` (rank, entry MC → peak/current MC, gain multiplier, age, conviction as X/10). Long-polls Telegram (no public webhook URL needed) and only answers in the configured `TELEGRAM_CHAT_ID`, so it never leaks wallet-labeled data to a stranger DMing the bot. Requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to be set |
| **Sell detection** | ≥ N wallets SELL the same token → bearish alert |
| **Rotation detection** | wallets SELL token A then BUY token B → rotation alert |
| **Noise filter** | settlement/quote tokens (WETH, USDC, USDG…) and tokenised equities (AAPL, TSLA, NVDA…) are dropped before detection via `IGNORE_SYMBOLS`, so the feed and alerts stay focused on real gems (no spurious "sold WETH" leg on every buy) |
| **Conviction refinement** | after detection, conviction is re-scored with the *real* market cap, liquidity and momentum — low caps and healthy liquidity get a boost, dangerously thin liquidity a penalty — so the best low-cap gems rank highest |
| **Blue-chip buy/sell filter** | toggle whether tracked-wallet **buys** and **sells** of the coins we already track (the seed set — CASHCAT, PONS, YOLO, HMM…) can alert. Turn a side off to weed out whales just rotating money between known coins, so alerts focus on new low-caps. Two independent switches on the dashboard **Alert Filters** card or `POST /api/bluechip/{buys,sells}`; seed defaults with `BLUE_CHIP_BUYS` / `BLUE_CHIP_SELLS` |
| **Mutable wallet groups** | turn a whole coin's tracked wallets off/on at runtime — click the coin in the dashboard's **Wallet Groups** card, or `POST`/`DELETE /api/muted/:symbol` (seed defaults with `MUTE_WALLET_TOKENS`). A wallet is only silenced when *every* coin it's a top-holder of is muted, so cross-conviction wallets that also hold other gems keep firing. Muted wallets drop out before detection — they never form or grow a swarm, solo, or entry |
| **Settings survive redeploys** | Wallet Groups mutes and the Blue Chip buy/sell toggles are written to disk on every change and restored on boot, so a redeploy doesn't reset them back to the `MUTE_WALLET_TOKENS`/`BLUE_CHIP_*` env defaults. Point `STORE_SETTINGS_PATH` at a mounted Railway Volume (e.g. `/data/settings.json`); empty (default) keeps them in-memory only, same as before |
| **Wallet tiers** | each wallet is tiered by its best top-10 holder rank across the tracked coins — **alpha** (rank 1–3), **beta** (4–6), **chroma** (7–9), **delta** (10) — which anchors its confidence and feeds the conviction score; alert makeup reads e.g. "2 alpha · 1 beta" |
| **Conviction score** | 0–100 from wallet quality (tier), count, capital, velocity, liquidity, market cap, historical accuracy, buy/sell ratio |
| **Live prices & market cap** | real USD price / market cap / pair link from DexScreener (cached, background-refreshed, chain-filtered) when `DEXSCREENER_CHAIN` is set; when DexScreener has not indexed a pair yet, the price is read straight off the token's deepest ETH-paired Uniswap v4/v3 pool. No real source → the price is **null**, shown as `?`, never a placeholder |
| **Market cap context** | every swarm/alert reports the token market cap it was bought/sold into |
| **Address privacy** | wallet addresses are never surfaced in alerts, the dashboard, or the API feeds/SSE — only wallet counts and a category makeup (e.g. "3 smart-money · 1 whale") are shown |
| **Stable wallet ids** | alerts (`walletIds`, index-aligned with `walletLabels`) and `/api/wallets` (`walletId`) carry an opaque salted hash of each wallet, so a consumer can build a per-wallet track record without ever seeing an address. Labels can't do this — they're derived from holdings, so they change as a wallet buys and two wallets can share one. Set `WALLET_ID_SALT` to a long random string once and never rotate it (rotating renames every wallet and orphans downstream history) |
| **Scanner-style cards** | Telegram alerts render as a rich HTML card (bold title, conviction bar, price/MC/liq/vol/age, 24h & 1h change, buy/sell counts, tier makeup, cross-holding overlap) with clickable **Chart** (DexScreener) + **Explorer** (Blockscout) links |
| **DexScreener links** | every alert and dashboard token links straight to its DexScreener chart; set `DEXSCREENER_CHAIN` for direct token pages, otherwise universal address search |
| **Configurable rules** | min wallets, time window, min USD, min conviction, cooldown, kinds, ignored tokens/wallets, ignore dust, ignore stablecoins, ignore duplicate wallets |
| **Notifications** | Discord webhook, Telegram bot, generic REST webhook (each optional) |
| **Live dashboard** | self-contained page at `/` — live feed, swarms, alerts, leaderboards, tracked wallets, latency/health, updated over SSE |
| **REST API** | wallets, tokens, swaps, swarms, alerts, rules, leaderboards, stats, health, config |

## Architecture

```
Robinhood RPC (WebSocket)
        │
        ▼
  Chain Listener ──► Transfer Decoder ──► Wallet Filter
        │                                     │
        │                                     ▼
        │                            Aggregation Engine  (in-memory, windowed)
        │                                     │
        │                                     ▼
        │                            Conviction Engine  (0–100)
        │                                     │
        │                                     ▼
        │                              Alert Engine  (rules + cooldowns)
        │                                     │
        ├──► metrics ──► Store ◄──────────────┤
        │                 │                   ▼
        │                 │            Notifications (Discord / Telegram / Webhook)
        │                 ▼
        │        Postgres + Redis (optional write-behind)
        ▼
   SSE / REST ──► Dashboard
```

**The bot ships live by default.** It polls Robinhood Chain's public HTTP RPC
(`https://rpc.mainnet.chain.robinhood.com`, chain id 4663) every few seconds
via `eth_getLogs`, pulling Transfer logs for the tracked wallets and decoding
them into swaps — no paid provider or WebSocket required. Point `CHAIN_WS_URL`
at a streaming provider (Alchemy/QuickNode) to use lower-latency websocket
subscriptions instead.

In **discovery mode** (default), it filters logs by tracked-**wallet** topics
rather than by token, so it catches those wallets buying *any* token —
including brand-new coins, which are auto-registered and priced. Set
`DISCOVERY_MODE=false` to watch only the seeded tokens.

Set `CHAIN_MODE=simulator` to run without the chain — it replays synthetic
coordinated swaps (including periodic new-coin swarms) so the whole pipeline
(detection → conviction → alerts → dashboard) is exercised with zero external
dependencies. Pair it with `PRICE_SYNTHETIC_FALLBACK=true`: simulated tokens
have no pool and no DexScreener pair, so without a fabricated price they are
correctly unvalued and the dust filter drops every swap. That flag is for this
case and no other.

### Uniswap attribution status

The live listener has an opt-in strict V3/V4 gate: exact receipt transfer,
successful transaction, verified V3 pool or canonical V4 PoolManager event,
and a demonstrated watched-wallet net exchange. LP/fee/zap, Permit2/WETH-only,
airdrop, and unresolved activity are suppressed. It defaults to off: run
`LIVE_VERIFIED_TRADE_SHADOW=true` for 24–48 hours, investigate every `live
trade shadow mismatch` log, then set `LIVE_VERIFIED_TRADE_GATE=true`.

Native-payment routes require either a trace-capable RPC
(`LIVE_TRADE_TRACE_RPC_URL`, `debug_traceTransaction` + `callTracer`) or an
independently audited entry address in `LIVE_VERIFIED_ENTRY_CONTRACTS`; an
entry address never replaces V3/V4 provenance or wallet-delta proof. The
FORK 0.5 ETH → FORK V4 transaction is covered by a fixture. The fuller
contract and reconciliation matrix remain in
[Uniswap V3/V4 attribution](docs/uniswap-v3-v4-attribution.md).

## Quick start

```bash
npm install
cp .env.example .env        # optional — sensible defaults, simulator mode
npm run dev                 # hot-reload dev server
# or
npm run build && npm start  # production
```

Open **http://localhost:8080** for the dashboard.

### Point it at a live chain

```bash
CHAIN_WS_URL=wss://<robinhood-chain-rpc> CHAIN_MODE=live npm start
```

The listener subscribes to ERC-20 `Transfer` logs for the tracked tokens,
classifies each as a BUY (tracked wallet receiving) or SELL (tracked wallet
sending), auto-reconnects with exponential backoff, and reports block height +
RPC latency to the dashboard.

> **Prices:** `DEXSCREENER_CHAIN` (default `robinhood`) pulls real USD price,
> market cap, and pair links from DexScreener. The slug selects the pair on the
> right chain rather than a same-address token elsewhere. When DexScreener has
> no pair (the normal state for a pair minutes old), `POOL_PRICE_FALLBACK`
> (default on) reads the price from the token's own Uniswap pool. If neither
> source has an answer the price is **unknown (null)** and every gate fails
> closed on it — see `src/chain/price.ts` and `src/chain/poolPrice.ts`.
>
> `PRICE_SYNTHETIC_FALLBACK` (default **off**, dev only) restores the old
> behaviour of hashing the token address into a price. It fabricated ANOA's
> "$13.1M" market cap on 2026-08-04 — real cap $2,598 — and cleared the $25k
> alert floor with it. Never enable it in production.

## Configuration

Everything is configured via environment variables (see `.env.example`) and
alert rules are additionally editable at runtime through the API. Key vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP bind |
| `CHAIN_WS_URL` | — | Robinhood Chain WS RPC; empty ⇒ simulator |
| `CHAIN_MODE` | `auto` | `live`, `simulator`, or `auto` |
| `ALERT_MIN_WALLETS` | `2` | default swarm threshold |
| `ALERT_WINDOW_SECONDS` | `300` | default detection window (5 min) |
| `ALERT_MIN_USD` / `ALERT_MIN_CONVICTION` | `0` / `0` | default gates |
| `ALERT_COOLDOWN_SECONDS` | `120` | per rule/token/kind cooldown |
| `PRIME_ALERTS` | `true` | loudest alert tier for the kind+conviction combo backed by real outcome data |
| `PRIME_KINDS` | `ENTRY` | comma-separated swarm kinds eligible for PRIME |
| `PRIME_MIN_CONVICTION` | `80` | minimum conviction (of an eligible kind) to hit PRIME |
| `REPEAT_WINDOW_MINUTES` | `35` | rolling window for the repeat/escalation counter |
| `PERF_AUTO_RESET` | `true` | clear the Best Calls list once a day |
| `PERF_RESET_HOUR` | `8` | hour (0–23) the daily reset fires |
| `PERF_RESET_TZ` | `America/New_York` | timezone for `PERF_RESET_HOUR` |
| `PERF_MILESTONES_ENABLED` | `true` | fire a PnL card every time a call's peak crosses a new interval |
| `PERF_MILESTONE_STEP_PCT` | `50` | the interval size for milestone cards |
| `IGNORE_DUST_USD` | `25` | drop swaps below this notional |
| `IGNORE_STABLECOINS` | `true` | ignore tokens flagged stable |
| `DISCORD_WEBHOOK_URL` | — | Discord alerts |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Telegram alerts, and enables the `/t5` `/t10` `/l5` slash commands |
| `GENERIC_WEBHOOK_URL` | — | POST alert JSON anywhere |
| `DATABASE_URL` | — | enable Postgres archival |
| `REDIS_URL` | — | enable Redis cache/pubsub |
| `SIGMA_REF` | `450463357` | referral id for the Sigma bot buy button; blank hides it |
| `BASED_REF` | `Rick` | referral id for the Based bot buy button; blank hides it |

Invalid configuration fails fast at startup with a readable message.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | health check (used by Docker + Railway) |
| GET | `/api/stats` | totals, live metrics, channels |
| GET | `/api/config` | effective non-secret config |
| GET | `/api/tokens` | tracked tokens + per-token stats |
| GET/POST/DELETE | `/api/wallets[/:address]` | manage tracked wallets |
| GET | `/api/muted` | current muted wallet groups + affected wallet count |
| POST/DELETE | `/api/muted/:symbol` | mute / unmute a coin's wallets at runtime (e.g. `HMM`) |
| GET | `/api/filters` | blue-chip buy/sell toggle state (admin) |
| POST | `/api/bluechip/buys` `/api/bluechip/sells` | toggle blue-chip buy / sell alerts on/off (admin) |
| POST | `/api/admin/verify` | validate the admin password (`x-admin-password` header) |
| GET | `/api/sniper` | sniper status, wallet, positions + PnL (admin) |
| POST | `/api/sniper/settings` `/api/sniper/toggle` | update sniper settings / flip on-off (admin) |

> **Admin controls** — the Alert Filters and Wallet Groups sections and their
> toggle endpoints are gated by `ADMIN_PASSWORD` (checked server-side; the
> password is never in the page source). Unlock via the dashboard **🔒 Admin**
> button, or send an `x-admin-password` header. Set `ADMIN_PASSWORD=''` to
> disable the gate.
| GET | `/api/swaps` `/api/swarms` `/api/alerts` | recent activity (`?limit=`) |
| POST | `/api/test-alert` | send a sample alert to every configured channel (verify a new channel instantly) |
| GET | `/api/performance` | tracked alert outcomes (peak/current return) + win-rate by signal type |
| GET | `/api/performance.csv` | CSV snapshot of every tracked call (grab before a redeploy — data is in-memory) |
| GET | `/api/leaderboard/wallets` `/api/leaderboard/tokens` | rankings |
| GET/POST/PUT/DELETE | `/api/rules[/:id]` | manage alert rules |
| GET | `/events` | SSE stream: `swap`, `swarm`, `alert`, `metrics` |

Example — add a rule that only fires on high-conviction, high-value buys:

```bash
curl -X POST localhost:8080/api/rules -H 'content-type: application/json' -d '{
  "name": "whale buys",
  "minWallets": 4,
  "windowSeconds": 45,
  "minUsd": 100000,
  "minConviction": 70,
  "cooldownSeconds": 300,
  "kinds": ["BUY"]
}'
```

## Deployment (Railway)

The repo ships a `Dockerfile` and `railway.json` (health check on `/health`,
restart-on-failure). To keep it live on Railway:

1. Create a project from this repo — Railway builds the `Dockerfile`.
2. Add env vars (at minimum a notification channel; `CHAIN_WS_URL` for live).
3. *(optional)* Add the Railway **PostgreSQL** and **Redis** plugins; set
   `DATABASE_URL` / `REDIS_URL`. Run `npm run prisma:migrate` to create tables.

The image generates the Prisma client at build time and runs migrations only
when a database is attached; without one it runs fully in-memory.

## Development

```bash
npm run dev         # watch mode
npm run typecheck   # tsc --noEmit
npm test            # vitest (detection, conviction, seed)
npm run build       # compile to dist/
```

Tests cover the swarm/rotation detection state machine, the 0–100 conviction
scoring, and the seed-data derivation (72 unique wallets, 5 cross-coin).

## Project layout

```
src/
  index.ts              entrypoint + pipeline wiring + graceful shutdown
  config/env.ts         env validation (zod) + .env loader
  data/seed.ts          tokens + wallets derived from the conviction list
  chain/                listener (live WS + simulator), decoder, price oracle
  engine/               aggregator (swarm/rotation), conviction, alert engine
  notify/               discord / telegram / webhook dispatch + formatting
  store/                in-memory store + optional Postgres/Redis persistence
  api/                  fastify server, routes, SSE, embedded dashboard
prisma/schema.prisma    optional archival schema
```

---

*Data source: Robinhood Chain (Blockscout holders + DexScreener pools). LP
pools, Permit2 and burn addresses excluded. Not financial advice.*

import { readFileSync, existsSync } from 'node:fs';
import { getAddress } from 'ethers';
import { z } from 'zod';

/** Normalise an address to a valid EIP-55 checksum regardless of input casing;
 *  returns '' for empty and leaves genuinely invalid strings as-is. */
function normAddr(a: string): string {
  const t = a.trim();
  if (!t) return '';
  try {
    return getAddress(t.toLowerCase());
  } catch {
    return t;
  }
}

/**
 * Minimal, dependency-free `.env` loader. Values already present in the real
 * environment (e.g. injected by Railway) always win over the file.
 */
function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  PORT: num(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  CHAIN_WS_URL: z.string().default(''),
  // Public Robinhood Chain RPC (chain id 4663). Used by the HTTP polling
  // listener and for token metadata. Override with a dedicated provider
  // (Alchemy/QuickNode) for production throughput.
  CHAIN_HTTP_URL: z.string().default('https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: z.string().default('4663'),
  CHAIN_MODE: z.enum(['live', 'simulator', 'auto']).default('auto'),
  // HTTP polling cadence (ms) when using the HTTP listener.
  POLL_INTERVAL_MS: num(4000),
  SIM_TICK_MS: num(1500),
  SIM_SWARM_CHANCE: num(0.35),
  // Discovery mode: detect swarms on ANY token tracked wallets trade (including
  // brand-new coins), auto-registering unknown tokens. When false, only the
  // seeded/tracked tokens are watched (legacy behaviour).
  DISCOVERY_MODE: bool(true),
  // Fraction of simulated swarms that target a brand-new (unseen) token.
  SIM_DISCOVERY_CHANCE: num(0.4),

  ALERT_MIN_WALLETS: num(2),
  ALERT_WINDOW_SECONDS: num(300),
  ALERT_MIN_USD: num(0),
  ALERT_MIN_CONVICTION: num(0),
  // Global floors applied to EVERY alert type (swarm, solo, entry): suppress
  // tokens below this market cap, and pairs younger than this age.
  ALERT_MIN_MARKETCAP: num(25_000),
  PAIR_MIN_AGE_MINUTES: num(30),
  // Solo-buy alerts: fire when a SINGLE tracked wallet buys a coin, but only
  // when its market cap is below SOLO_MAX_MARKETCAP (early low-cap gems).
  SOLO_ALERTS: bool(true),
  SOLO_MIN_MARKETCAP: num(25_000),
  SOLO_MAX_MARKETCAP: num(125_000),
  // Safety filter: run each token through GoPlus token-security + a minimum
  // liquidity check before alerting, so rugs/honeypots/high-tax tokens are
  // suppressed. Set false to alert on everything.
  SAFETY_FILTER: bool(true),
  SAFETY_MIN_LIQUIDITY_USD: num(5_000),
  SAFETY_MAX_TAX_PCT: num(15),
  // Volume/momentum confirmation. Confirmed momentum boosts conviction and is
  // shown in alerts. Set MOMENTUM_MIN_VOLUME_USD > 0 to also SUPPRESS alerts on
  // tokens with 24h volume below it (0 = don't gate, keep brand-new gems).
  MOMENTUM_MIN_VOLUME_USD: num(0),
  // Fresh-pair + first-entry alerts: fire when a qualifying-tier wallet makes
  // its first-ever buy of a token whose pair is younger than the max age. The
  // purest "ground floor" signal.
  FRESH_ENTRY_ALERTS: bool(true),
  FRESH_PAIR_MAX_AGE_HOURS: num(48),
  FRESH_ENTRY_TIERS: z.string().default('alpha,beta'),
  // PRIME tier: the loudest alert, reserved for the kind+conviction combo that
  // actually backtested well (ENTRY @ conviction 80+ averaged a 79% peak gain
  // vs 52% baseline across 250 tracked calls — see /api/performance history).
  // Tunable as more outcome data comes in.
  PRIME_ALERTS: bool(true),
  PRIME_KINDS: z.string().default('ENTRY'),
  PRIME_MIN_CONVICTION: num(80),
  ALERT_COOLDOWN_SECONDS: num(120),
  // Repeat/escalation tracking: how many alerts a token has fired inside this
  // rolling window is counted and surfaced ("2nd alert in 35m"), and each
  // repeat past the first nudges conviction up. This is what tells you a token
  // keeps drawing tracked-wallet interest even though the per-token cooldown
  // hides the individual re-fires.
  REPEAT_WINDOW_MINUTES: num(35),
  // Outcome tracking: after each alert fires, follow the token's price and
  // record the peak + milestone returns, so signal quality is measured from
  // real results (multi-wallet vs solo, repeat vs single) instead of guessed.
  PERFORMANCE_TRACKING: bool(true),
  PERF_SAMPLE_MINUTES: num(2),
  PERF_TRACK_HOURS: num(24),
  // A call counts as a "win" for the win-rate stat when its peak return reaches
  // this %. Tune to whatever "runner" means to you.
  PERF_WIN_THRESHOLD_PCT: num(50),
  // Persist the outcome tracker to this file so redeploys don't wipe it. Point
  // it at a mounted Railway Volume (e.g. /data/performance.json); empty = keep
  // data in memory only (lost on restart).
  PERF_STORE_PATH: z.string().default(''),
  // Clear the Best Calls tracker once a day so it doesn't grow stale — fresh
  // start every morning. Also triggerable on demand via the admin Reset button
  // (POST /api/performance/reset).
  PERF_AUTO_RESET: bool(true),
  PERF_RESET_HOUR: num(8),
  PERF_RESET_TZ: z.string().default('America/New_York'),
  // PnL milestone cards: fire a celebratory alert to every notification
  // channel each time a tracked call's peak return crosses a new interval
  // (default every 50%: +50%, +100%, +150%, …). A big jump between samples
  // announces every interval it passed through, not just the top one.
  PERF_MILESTONES_ENABLED: bool(true),
  PERF_MILESTONE_STEP_PCT: num(50),
  IGNORE_DUST_USD: num(25),
  IGNORE_STABLECOINS: bool(true),
  // Symbols never treated as gems: settlement/quote tokens (so a "buy with WETH"
  // doesn't register a spurious WETH sell) and tokenised equities the tracked
  // wallets trade heavily on Robinhood Chain. Comma-separated, case-insensitive.
  IGNORE_SYMBOLS: z
    .string()
    .default(
      'WETH,WBTC,ETH,USDC,USDT,USDG,DAI,USDB,WROB,VIRTUAL,' +
        'AAPL,TSLA,NVDA,GOOGL,GOOG,META,MSFT,AMZN,AMD,INTC,MU,NFLX,DIS,' +
        'COIN,PLTR,ORCL,CRWV,SNDK,SPCX,USAR,BE,HOOD,SPY,QQQ',
    ),

  // Mute tracked wallets by the coin they were sourced from (e.g. "HMM"). A
  // wallet is silenced only when EVERY coin it is a tracked top-holder of is
  // muted, so cross-conviction wallets that also hold other gems keep firing.
  // Comma-separated symbols, case-insensitive. Runtime-toggleable via /api/muted.
  MUTE_WALLET_TOKENS: z.string().default(''),
  // Blue-chip = the coins we already track (the seed set: CASHCAT, PONS, YOLO,
  // HMM, …). Toggle whether tracked-wallet BUYS / SELLS of those coins can
  // alert. Off = weed out whales just rotating money between known coins, so
  // alerts focus on new low-caps. Runtime-toggleable via /api/bluechip/*.
  BLUE_CHIP_BUYS: bool(true),
  BLUE_CHIP_SELLS: bool(true),
  // Persist Wallet Groups (mute) + Blue Chip filter toggles so they survive a
  // redeploy instead of resetting to the env defaults above. Point at a
  // mounted Railway Volume (e.g. /data/settings.json); empty = in-memory only.
  STORE_SETTINGS_PATH: z.string().default(''),
  // Password gating the dashboard admin controls (Alert Filters, Wallet Groups)
  // and their toggle endpoints. Change this in Railway for real security — the
  // default is a convenience only. Empty disables the admin gate entirely.
  ADMIN_PASSWORD: z.string().default('abcfly'),

  // ── Sniper: auto-buy alerts with a server hot wallet ──────────────────────────
  // A single on/off switch (SNIPER_ENABLED), OFF by default. When ON it places
  // REAL buys, so use a DEDICATED burner wallet funded with only what you can
  // lose, never your main wallet. It won't trade unless the key + router + WETH
  // are set. Per-trade + daily caps and the off switch are the safety rails.
  SNIPER_ENABLED: bool(false), // master on/off — ON = real buys
  SNIPER_PRIVATE_KEY: z.string().default(''), // burner hot-wallet key (env OR entered in-app)
  // Robinhood Chain Uniswap-v4 addresses (verified from official docs). The
  // UniversalRouter is Robinhood's MODIFIED fork — only this address works.
  SNIPER_ROUTER: z.string().default('0x8876789976deCbfCbBbe364623c63652db8C0904'),
  SNIPER_WETH: z.string().default('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  SNIPER_MIN_CONVICTION: num(60),
  SNIPER_MAX_CONVICTION: num(100),
  SNIPER_BUY_ETH: num(0.0005), // per-alert buy size
  SNIPER_MAX_ETH_PER_TRADE: num(0.005), // hard per-trade ceiling
  SNIPER_DAILY_CAP_ETH: num(0.05), // stop buying once this is spent in 24h
  SNIPER_SLIPPAGE_PCT: num(15),
  // A sell that reverts (e.g. price moved past normal slippage while the tx
  // was in flight on a fast-crashing token) retries ONCE at this much wider
  // tolerance — exiting matters more than price when you're trying to get out.
  // Only applies to sells; buys are never force-executed past normal slippage.
  SNIPER_MAX_SELL_SLIPPAGE_PCT: num(50),
  SNIPER_TAKE_PROFIT_PCT: num(0), // auto-sell a position at +this% (0 = off)
  SNIPER_REQUIRE_SAFE: bool(true), // never buy a token that fails the honeypot/sellability check (−100% trap)
  SNIPER_TRAILING_STOP_PCT: num(15), // trailing stop % off the high-water mark; doubles as the stop-loss
  // (peak starts at entry). The validated edge: tight ~15% on non-SOLO swarms. 0 = off.
  SNIPER_KINDS: z.string().default('BUY,ENTRY'), // alert kinds to snipe — non-SOLO by default (SOLO was −EV in backtest)
  // Depth gate: refuse a buy when a round-trip (buy then immediately sell the tokens
  // back) would lose more than this % at our size — price impact both ways + LP fees +
  // hook tax. The direct measure of "can we even exit this pool cleanly." 0 = off.
  SNIPER_MAX_ROUNDTRIP_PCT: num(35),
  // After a token stops us out at a loss, don't re-buy it for this many minutes (0 = off).
  SNIPER_LOSS_COOLDOWN_MIN: num(90),
  SNIPER_JOURNAL_PATH: z.string().default(''), // append-only JSONL trade journal for offline analysis
  SNIPER_STORE_PATH: z.string().default(''), // persist positions across redeploys

  DISCORD_WEBHOOK_URL: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  GENERIC_WEBHOOK_URL: z.string().default(''),

  DATABASE_URL: z.string().default(''),
  REDIS_URL: z.string().default(''),

  // DexScreener deep links + real prices. Set DEXSCREENER_CHAIN to the chain
  // slug (e.g. the Robinhood Chain slug) for direct token pages AND to unlock
  // real price / market-cap from DexScreener (the slug is needed to pick the
  // right pair). Left empty, links fall back to universal search and prices
  // stay synthetic.
  DEXSCREENER_CHAIN: z.string().default('robinhood'),
  // How often (ms) to refresh live prices from DexScreener.
  PRICE_REFRESH_MS: num(15000),
  // Block explorer base for Explorer links in alerts (Robinhood Chain Blockscout).
  EXPLORER_BASE: z.string().default('https://robinhoodchain.blockscout.com'),

  // One-tap buy links for Telegram trading bots, deep-linked with the token
  // contract so tapping the button opens the bot with the swap pre-filled.
  // Each ref is the operator's own referral id with that bot; blank disables
  // the button for that bot.
  SIGMA_REF: z.string().default('450463357'),
  BASED_REF: z.string().default('Rick'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast with a readable message — required by the "environment validation"
  // deliverable.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

/** Resolve the effective data source once, so the rest of the app is simple. */
const hasLiveSource = env.CHAIN_WS_URL.length > 0 || env.CHAIN_HTTP_URL.length > 0;
const chainMode: 'live' | 'simulator' =
  env.CHAIN_MODE === 'auto' ? (hasLiveSource ? 'live' : 'simulator') : env.CHAIN_MODE;

export const config = {
  ...env,
  chainMode,
  hasDatabase: env.DATABASE_URL.length > 0,
  hasRedis: env.REDIS_URL.length > 0,
  freshEntryTiers: env.FRESH_ENTRY_TIERS.split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
  primeKinds: new Set(
    env.PRIME_KINDS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
  ignoreSymbols: new Set(
    env.IGNORE_SYMBOLS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
  mutedWalletTokens: env.MUTE_WALLET_TOKENS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  sniperKinds: new Set(
    env.SNIPER_KINDS.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
  // Normalise so any casing of the router/WETH addresses is accepted (ethers
  // rejects a mixed-case address whose checksum doesn't match).
  SNIPER_ROUTER: normAddr(env.SNIPER_ROUTER),
  SNIPER_WETH: normAddr(env.SNIPER_WETH),
  notifications: {
    discord: env.DISCORD_WEBHOOK_URL || null,
    telegram:
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
        ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
        : null,
    webhook: env.GENERIC_WEBHOOK_URL || null,
  },
} as const;

export type AppConfig = typeof config;

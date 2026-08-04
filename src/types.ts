/** Canonical domain types for Swarm the Fly. */

export type Direction = 'BUY' | 'SELL';

export interface TrackedToken {
  /** Contract address (lowercased). */
  address: string;
  symbol: string;
  name: string;
  /** Human-unit total supply. For a discovered token this starts as a PLACEHOLDER
   *  (1e9) and only becomes real once `supplyVerified` is true — never multiply
   *  it by a price before then. */
  totalSupply: number;
  /** True only when `totalSupply` was read from the contract (seed set, or an
   *  on-chain metadata enrich). Market cap is unknown while this is false. */
  supplyVerified?: boolean;
  /** Contract decimals, populated from an on-chain metadata read for discovered tokens. */
  decimals?: number;
  /** True for stablecoins so they can be filtered when IGNORE_STABLECOINS. */
  stable?: boolean;
  /** True when the token was auto-registered by discovery (not in the seed set).
   *  Its metadata (symbol/supply) may be estimated until enriched from chain. */
  discovered?: boolean;
  /** When the token was first seen (unix ms). */
  firstSeen?: number;
}

export type WalletCategory =
  | 'developer'
  | 'vc'
  | 'whale'
  | 'market_maker'
  | 'influencer'
  | 'retail'
  | 'internal'
  | 'unknown';

/**
 * Conviction tier derived from a wallet's best holder rank across the tracked
 * coins (it is a top-10 holder of one or more): alpha = rank 1–3, beta = 4–6,
 * chroma = 7–9, delta = 10.
 */
export type WalletTier = 'alpha' | 'beta' | 'chroma' | 'delta';

export interface TrackedWallet {
  /** Address (lowercased). Never leaves the server — see walletId.ts for the public handle. */
  address: string;
  label: string;
  category: WalletCategory;
  /** Conviction tier from best holder rank (alpha/beta/chroma/delta). */
  tier: WalletTier;
  /** Best (lowest) holder rank this wallet reaches across the tracked coins. */
  rank: number;
  notes?: string;
  /** Operator confidence in this wallet, 0..1. Feeds the conviction score. */
  confidence: number;
  /** Tokens (symbols) this wallet is a known top-holder of. */
  holdsTokens: string[];
}

/** A decoded swap emitted by the chain listener + decoder. */
export interface SwapEvent {
  txHash: string;
  wallet: string;
  token: string; // token contract address (lowercased)
  tokenSymbol: string;
  direction: Direction;
  /** Token amount (human units). */
  amount: number;
  /** Notional USD value of the swap, or **null** when the token has no price we
   *  can verify. Null is not 0: an unvalued swap is unknown, not dust. */
  usdValue: number | null;
  blockNumber: number;
  /** Unix ms. */
  timestamp: number;
}

/** Breakdown of the 0..100 conviction score for a detected swarm. */
export interface ConvictionBreakdown {
  walletQuality: number;
  walletCount: number;
  totalCapital: number;
  velocity: number;
  liquidity: number;
  marketCap: number;
  historicalAccuracy: number;
  buySellRatio: number;
}

/** Result of the pre-alert token safety screen (GoPlus + liquidity). */
export interface SafetyReport {
  /** True when there are no hard failures — safe enough to alert. */
  ok: boolean;
  checkedAt: number;
  liquidityUsd: number | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  honeypot: boolean;
  /** Blocking problems (honeypot, can't sell, high tax, no liquidity, …). */
  hardFails: string[];
  /** Non-blocking concerns (mintable, unlocked LP, unverified, …). */
  warnings: string[];
  /** Where the verdict came from. */
  source: 'goplus' | 'blockscout' | 'liquidity-only' | 'none';
}

/** Volume / momentum confirmation for a token at alert time. */
export interface MomentumReport {
  /** 24h trading volume (USD), or null if unknown. */
  volumeUsd: number | null;
  /** Recent price change % (1h if available, else 24h), or null. */
  priceChangePct: number | null;
  /** 1h price change %, or null. */
  priceChange1h: number | null;
  /** 24h price change %, or null. */
  priceChange24h: number | null;
  /** 24h buy / sell transaction counts, or null. */
  buys: number | null;
  sells: number | null;
  /** Share of buys vs sells over 24h, 0–100, or null. */
  buyPressurePct: number | null;
  /** True when volume + direction confirm live upward momentum. */
  confirmed: boolean;
  /** Conviction bonus (0–15) applied when momentum confirms. */
  boost: number;
}

export type SwarmKind = 'BUY' | 'SELL' | 'ROTATION' | 'SOLO' | 'ENTRY';

export interface Swarm {
  id: string;
  kind: SwarmKind;
  token: string;
  tokenSymbol: string;
  /** For rotation swarms, the token being rotated into. */
  rotatedIntoSymbol?: string;
  walletCount: number;
  /** Addresses are retained for engine logic (rotation matching) but are not
   *  surfaced in alerts or the dashboard — see `walletSummary` for display. */
  wallets: string[];
  /** Privacy-preserving makeup for display, e.g. "2 smart-money · 1 whale". */
  walletSummary: string;
  /** Labels (operator-assigned nicknames — never addresses) of the tracked
   *  wallets behind this specific alert, e.g. ["tendies", "hmm"]. Safe to
   *  surface: identifies which named wallet called it without exposing PII.
   *  NOT an identity: labels are derived from holdings, so they change as a
   *  wallet buys and two wallets can share one. Key on `walletIds` instead. */
  walletLabels: string[];
  /** Opaque, stable per-wallet ids, index-aligned with `walletLabels` — the
   *  handle a consumer keys a per-wallet track record on. Salted hashes of the
   *  address (see walletId.ts), so they expose no PII. */
  walletIds: string[];
  totalUsd: number;
  /** Token market cap (USD) at the moment of the swarm — the cap the wallets
   *  bought or sold into. **Null when unknown**, which is not the same as small:
   *  every cap gate must reject null rather than let it through. */
  marketCap: number | null;
  /** Highest market cap seen for this token since the bot started tracking it
   *  (not a true lifetime ATH — DexScreener doesn't expose one). Null when
   *  unknown (no live pair yet). Always >= marketCap. */
  athMarketCap?: number | null;
  /** True when this swarm is on a token discovered by tracked wallets rather
   *  than one from the original seed set — the early-discovery signal. */
  newToken: boolean;
  /** DexScreener link for the token (precise pair page when known). */
  dexUrl: string;
  /** True when the price came from a REAL source — a live DexScreener pair or a
   *  direct read of the token's pool. False means we have no price at all. */
  priceLive: boolean;
  /** Which real source priced this swarm: 'dexscreener' (has cap/liquidity/
   *  volume) or 'pool' (price only, straight off chain — a pair too new to be
   *  indexed). Null when unpriced. */
  priceSource?: 'dexscreener' | 'pool' | null;
  /** Token safety screen result, when the safety filter is enabled. */
  safety?: SafetyReport;
  /** Volume / momentum confirmation for the token. */
  momentum?: MomentumReport;
  /** Age of the DEX pair in hours at alert time, or null if unknown. */
  pairAgeHours?: number | null;
  /** True when the pair is newer than the fresh-pair threshold. */
  freshPair?: boolean;
  /** Live token price (USD) at alert time, for display. */
  priceUsd?: number | null;
  /** Live DEX liquidity (USD) at alert time, for display. */
  liquidityUsd?: number | null;
  /** DEX id (e.g. "uniswap"). */
  dex?: string | null;
  /** Other tracked coins the swarm's wallets also hold (cross-conviction). */
  alsoHold?: string[];
  /** How many alerts this token has produced within the repeat window (this
   *  alert included). 1 = first alert in the window; 2 = second ("x2"); etc.
   *  Surfaces repeated/escalating interest that the per-token cooldown hides. */
  repeatCount?: number;
  /** How many DISTINCT tracked wallets have driven this token's alerts within
   *  the window — the real multi-party signal (one busy wallet re-buying counts
   *  once, so it can't masquerade as a swarm). */
  repeatWallets?: number;
  /** Price change (%) since the previous alert on this token in the window, or
   *  null when there was no prior alert / price is unknown. */
  repeatPriceChangePct?: number | null;
  /** True when this repeat is driven by a NEW distinct wallet (a different top
   *  holder joining), not the same wallet re-buying — the strongest repeat. */
  repeatNewWallet?: boolean;
  /** Set once at alert emission from the durable global Signals-feed history.
   *  Every operator receives the same value for the alert; New coins only
   *  snipers may act only when this is true. */
  firstSignal?: boolean;
  /** The rolling repeat window in minutes (for display, e.g. "2nd in 35m"). */
  repeatWindowMinutes?: number;
  /** True when this alert hits the PRIME bar (kind + conviction combo backed by
   *  real outcome data — see PRIME_KINDS / PRIME_MIN_CONVICTION). The loudest,
   *  most-likely-to-run signal; flagged hard in the card and on the dashboard. */
  prime?: boolean;
  conviction: number;
  convictionBreakdown: ConvictionBreakdown;
  windowSeconds: number;
  firstSeen: number;
  lastSeen: number;

  // ── Sniper entry-latency telemetry (stamped box-side by the FeedSubscriber; not from the feed) ──
  /** Box wall-clock (ms) when the FeedSubscriber received this alert off the SSE stream — before any
   *  local enrich. `receivedAt − firstSeen` ≈ the Railway→box hop (subject to clock skew). */
  receivedAt?: number;
  /** Duration (ms) of the blocking local price enrich (Dexscreener refreshNow) in the FeedSubscriber. */
  enrichMs?: number;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  minWallets: number;
  windowSeconds: number;
  minUsd: number;
  minConviction: number;
  cooldownSeconds: number;
  /** Only fire when the token's market cap is at or below this (USD). Omit for
   *  no cap limit. Used by solo-buy rules to target low-cap coins. */
  maxMarketCap?: number;
  /** Only fire when the token's market cap is at or above this (USD). Omit for
   *  no floor. Used by solo-buy rules to skip dust. */
  minMarketCap?: number;
  /** Which directions this rule fires on. */
  kinds: SwarmKind[];
  ignoredTokens: string[];
  ignoredWallets: string[];
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  swarm: Swarm;
  createdAt: number;
  deliveries: NotificationDelivery[];
}

export interface NotificationDelivery {
  channel: 'discord' | 'telegram' | 'webhook';
  ok: boolean;
  detail?: string;
  at: number;
}

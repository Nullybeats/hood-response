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
  /** Original receipt log index when the source is a chain log. */
  logIndex?: number;
  /** Unix ms. */
  timestamp: number;
  /**
   * True only when the strict verifier PROVED this was a swap: a successful
   * receipt, a canonical V3/V4 pool, and a wallet net exchange.
   *
   * Undefined when strict mode was off and nothing was checked — which is not
   * the same as false, and must not be read as "unverified". The v2 pipeline
   * consumes only `true`, because the attribution shadow measured that ~90% of
   * watched-wallet activity is `airdrop_receive` and barely 1.5% is a real
   * trade. Feeding it anything looser would make the whole brain mostly noise.
   */
  verifiedTrade?: boolean;
  /** The strict classifier's category, e.g. 'swap_v4_poolmanager'. For the fact sheet's venue. */
  verifiedCategory?: string;
  /**
   * True for a receipt-confirmed transfer IN with no swap event in the receipt —
   * an allocation/airdrop/claim, not a purchase.
   *
   * Exists because the untouched 47e1 instance kept alerting on these as "buys"
   * and its best calls (+435%, +359%) were EXACTLY this: top-seed wallets
   * receiving fresh tokens before pumps (verified on-chain 2026-08-08 — 0 of 14
   * trigger receipts contained a Swap event). Newer code correctly refused to
   * call them buys, but discarded the signal instead of reclassifying it. These
   * events flow ONLY to the v2 shadow — never into legacy stores or alerts.
   */
  distribution?: boolean;
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
  /**
   * Legacy taxonomy. ABSENT on a v2 signal, which is deliberate: a v2 match may
   * be an allocation (a wallet RECEIVING a token), which is none of SOLO/ENTRY/
   * BUY. Inventing a kind for it is exactly how 47e1 printed "1 alpha bought @
   * $101k MC" over a bare transfer, so the field is optional and every reader is
   * forced to decide what to do without one.
   */
  kind?: SwarmKind;
  /** Present ⇒ produced by the v2 brain. The discriminator for `isV2Signal`. */
  source?: 'v2';
  /** v2: lane ids that matched. Replaces `kind` as the reason a signal exists. */
  lanes?: string[];
  /** v2: one human line per matched lane. */
  laneReasons?: string[];
  /** v2: 0–100 quality score. Replaces `conviction`; null fails closed. */
  score?: number | null;
  /** v2: when the decision was made (NOT block time) — the freshness input. */
  emittedAt?: number;
  /** v2: verified-buy | distribution | verified-sell. */
  eventType?: string;
  /** v2: distinct watched wallets on this token in the window. 1 = solo. */
  cohortSize?: number;
  /** v2: static holder-rank tier, never a performance grade. */
  seedTier?: string | null;
  /** v2: market-cap band at fire time. */
  capBand?: string | null;
  /** v2: earned wallet grade at fire time; `U` while under the sample floor. */
  walletGrade?: string;
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

/**
 * Is this a v2 lane match rather than a legacy alert?
 *
 * Keyed on `source`, not on the absence of `kind`: absence is ambiguous (a
 * malformed legacy payload also lacks it), and a buy rule must never fall into
 * the v2 branch by accident. Presence of the discriminator is a positive claim.
 */
export function isV2Signal(s: Swarm): s is Swarm & { source: 'v2'; lanes: string[]; score: number | null } {
  return s.source === 'v2' && Array.isArray(s.lanes);
}

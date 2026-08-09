import type { MomentumReport, TrackedToken } from '../types.js';
import type { MemoryStore } from '../store/memory.js';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { dexScreenerUrl } from '../links.js';
import { computeMomentum } from './momentum.js';
import { PoolPriceReader } from './poolPrice.js';
import { fetchTokenMetadata } from './metadata.js';
import { resolveMarketCap, type CapResult, type CapSource } from './marketCap.js';

/** Where a live price came from. Never 'synthetic' — a fabricated number is not
 *  a price, and is only ever produced when PRICE_SYNTHETIC_FALLBACK is on. */
export type PriceSource = 'dexscreener' | 'pool';

interface LivePrice {
  /** Which real source produced this price. */
  source: PriceSource;
  priceUsd: number;
  /** Price in the pair's QUOTE currency. `priceUsd / priceNative` is the quote
   *  token's USD rate — which is the ETH/USD rate only when the quote token is
   *  actually WETH. It usually is, and "usually" is why {@link quoteToken}
   *  exists: see the note on ethUsdPrice(). */
  priceNative: number | null;
  /** The pair's quote token address, lowercased, when the source reports one.
   *  Null for pool-derived entries (no DexScreener pair behind them). */
  quoteToken: string | null;
  /** Market cap (USD) as reported by the source, or null when the source has
   *  none — pool-derived prices know nothing about supply. */
  marketCap: number | null;
  liquidityUsd: number | null;
  pairCreatedAt: number | null;
  volume24: number | null;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  buys24: number | null;
  sells24: number | null;
  dexId: string | null;
  pairAddress: string;
  chainId: string;
  fetchedAt: number;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  volume?: { h24?: number; h6?: number; h1?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

type DexTokenResponse = { pairs?: DexPair[] } | DexPair[];

const TTL_MS = 60_000;
/**
 * Tokens re-priced per refresh tick.
 *
 * This was 1, for a real reason: the multi-token endpoint caps its response at 30 PAIRS, not 30
 * tokens, so a naive batch silently drops whichever tokens fall past the cap and they are never
 * re-tried. One request per token could not starve anyone.
 *
 * It also could not keep up. [verified 2026-08-09] At 1 per 15s the background queue stood at
 * **12,345 tokens and drained one in two minutes** — seventeen days to clear — while 205 fetches sat
 * in flight behind a lane serialized at 1.5s. 22% of live decisions were dropped as "market cap still
 * unresolved after 31 attempts", and every one of those tokens was indexed at DexScreener the whole
 * time, answering a direct query in ~180ms.
 *
 * The cap is handled rather than avoided: `fetchBatch` reads back WHICH tokens the response actually
 * covered and re-queues the rest (see DEX_BATCH_SIZE). That makes batching safe, and batching is what
 * makes this number affordable — 24 is three requests per tick, not twenty-four.
 */
const MAX_PER_TICK = 24;
/**
 * Addresses per multi-token request.
 *
 * [verified 2026-08-09 against the live API] The response caps at 30 pairs. At the ~1.75 pairs per
 * token observed on this chain, **8 addresses came back fully covered and 12 truncated**. Eight is
 * therefore the measured safe size — but the coverage check in `fetchBatch` is what makes it correct,
 * not this constant, so a chain with chattier tokens degrades into re-queues rather than silence.
 */
const DEX_BATCH_SIZE = 8;
/**
 * Ceiling on the best-effort background queue.
 *
 * `refresh()` used to re-enqueue the ENTIRE token registry every tick, which is how a queue reaches
 * five figures: every historical token nobody is deciding anything about sat ahead of the coin being
 * judged right now. The priority queue always drains first and is never capped; this bound applies
 * only to the speculative sweep, oldest-first, so the backlog cannot crowd out live work again.
 */
const MAX_BACKGROUND_QUEUE = 1_500;
/** Cheap batch retries before a token falls through to the (expensive) pool read. */
const DEX_MISS_RETRIES = 2;
/**
 * How far a pool read may differ from a live indexer price before it is refused.
 *
 * Generous on purpose: a memecoin genuinely moving 5x in a minute is ordinary here, and both sources
 * would move together. This only catches the case where they DISAGREE about the same moment, which
 * is a reading error, not a rally.
 */
const POOL_DISAGREEMENT_MAX = 20;
/** Shared-IP friendly spacing for DexScreener's public endpoint. */
const DEX_MIN_INTERVAL_MS = 1_500;
const DEX_429_COOLDOWN_MS = 60_000;
// Bound the caches on a long-running process (many discovered tokens).
const MAX_CACHE = 5_000;
/** On-chain supply backfills per refresh tick — 3 eth_calls each, so kept small. */
const MAX_SUPPLY_PER_TICK = 6;
/** Give up after this many failed supply reads; some contracts have no working
 *  totalSupply() and must not be retried on every evaluation forever. */
const MAX_SUPPLY_ATTEMPTS = 3;
const LIVE_STALE_MS = 30 * 60_000;
// How long a fetched ETH/USD reference rate stays usable.
const ETH_USD_REF_TTL_MS = 5 * 60_000;
/** Plausibility band for an ETH/USD rate. Wide on purpose: this exists to reject a
 *  catastrophically wrong rate (the observed failures were $1.00 and $0.0089), not to
 *  second-guess the market. Widen it before ETH ever threatens either end. */
const ETH_USD_MIN = 50;
const ETH_USD_MAX = 100_000;

/** Evict oldest-inserted entries until the map is under `max`. */
function capMap<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * USD price / market-cap oracle.
 *
 * Two REAL sources, tried in order, and nothing else:
 *
 *   1. DexScreener (when `DEXSCREENER_CHAIN` is set) — cached, refreshed in the
 *      background, filtered to the configured chain so we never pick a
 *      same-address token on the wrong chain. Carries market cap and liquidity.
 *   2. The token's deepest ETH-paired Uniswap v4/v3 pool, read straight off
 *      chain (chain/poolPrice.ts). Covers the gap DexScreener leaves on a
 *      brand-new pair — the window a sniper actually trades.
 *
 * When neither has an answer the price is **null**. Null means unknown, and
 * unknown is not a number: every consumer must fail closed on it rather than
 * substitute a placeholder. This is not a style preference — the synthetic
 * fallback that used to sit here (a hash of the token address, still available
 * behind PRICE_SYNTHETIC_FALLBACK for chainless dev runs) fabricated ANOA's
 * "$13.1M" market cap on 2026-08-04 and walked eight alerts on a $2.6k rug
 * straight through the $25k alert floor.
 */
export class PriceOracle {
  private readonly synthetic = new Map<string, number>();
  private readonly live = new Map<string, LivePrice>();
  /** Ordinary refresh work. It is deliberately bounded each tick. */
  private readonly queue = new Set<string>();
  /** Recently displayed tokens jump ahead of the long restored-token backlog. */
  private readonly priorityQueue = new Set<string>();
  /** Coalesce simultaneous requests for one token before any HTTP work starts. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** One public-DexScreener request at a time; Railway shares this egress IP. */
  private dexTail: Promise<void> = Promise.resolve();
  private dexNextAt = 0;
  /** Consecutive batch responses that did not carry a token, so a permanently un-indexed
   *  one falls through to the pool instead of cycling at priority forever. */
  private readonly dexMisses = new Map<string, number>();
  /** Tokens awaiting an on-chain supply read (see drainSupplyQueue). */
  private readonly supplyQueue = new Set<string>();
  /** Failed supply-read counts, so a hopeless contract is not retried forever. */
  private readonly supplyAttempts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** Highest market cap seen for each token since this process started
   *  tracking it (not a true lifetime ATH — DexScreener doesn't expose one —
   *  but the best signal available without a paid data source). */
  private readonly athMarketCap = new Map<string, number>();
  private readonly pools = new PoolPriceReader();
  /** Last ETH/USD rate fetched from WETH's own pairs — see ensureEthUsd(). */
  private ethUsdRef: { rate: number; at: number } | null = null;

  constructor(
    tokens: readonly TrackedToken[],
    private readonly store?: MemoryStore,
  ) {
    for (const t of tokens) this.synthetic.set(t.address, this.derive(t.address));
  }

  /** True when at least one real price source is available. */
  get liveEnabled(): boolean {
    return config.DEXSCREENER_CHAIN.length > 0 || this.pools.enabled;
  }

  private derive(address: string): number {
    let h = 0;
    for (let i = 2; i < address.length; i += 4) {
      h = (h * 31 + parseInt(address.slice(i, i + 4), 16)) % 1_000_000;
    }
    return 0.00002 + (h / 1_000_000) * 0.02;
  }

  /** DEV ONLY (PRICE_SYNTHETIC_FALLBACK). Null in production — see the class doc. */
  private syntheticPrice(address: string): number | null {
    if (!config.PRICE_SYNTHETIC_FALLBACK) return null;
    let p = this.synthetic.get(address);
    if (p === undefined) {
      p = this.derive(address);
      this.synthetic.set(address, p);
      if (this.synthetic.size > MAX_CACHE) capMap(this.synthetic, MAX_CACHE);
    }
    return p;
  }

  private fresh(address: string): LivePrice | null {
    const l = this.live.get(address.toLowerCase());
    if (l && Date.now() - l.fetchedAt < TTL_MS) return l;
    return null;
  }

  private maybeEnqueue(address: string): void {
    if (!this.liveEnabled) return;
    if (this.fresh(address)) return;
    this.queue.add(address.toLowerCase());
  }

  /**
   * Queue an on-chain supply read for a token whose cap is blocked only by an
   * unverified supply. Bounded by `supplyAttempts`: a contract with no working
   * totalSupply() must not be retried forever on every evaluation.
   */
  private maybeEnqueueSupply(address: string): void {
    const key = address.toLowerCase();
    if ((this.supplyAttempts.get(key) ?? 0) >= MAX_SUPPLY_ATTEMPTS) return;
    this.supplyQueue.add(key);
  }

  /** The token's USD price, or **null** when no real source has one. */
  priceOf(tokenAddress: string): number | null {
    const key = tokenAddress.toLowerCase();
    const live = this.fresh(key);
    this.maybeEnqueue(key);
    return live ? live.priceUsd : this.syntheticPrice(key);
  }

  /** USD notional of a token amount, or null when the price is unknown.
   *  Callers must NOT coerce null to 0: an unknown-value swap is unknown, not
   *  worthless, and treating it as 0 silently reclassifies it as dust. */
  usdValue(tokenAddress: string, humanAmount: number): number | null {
    const price = this.priceOf(tokenAddress);
    return price == null ? null : humanAmount * price;
  }

  /**
   * Market cap (USD), or **null** when unknown.
   *
   * Two independent unknowns have to be resolved, and both used to be papered
   * over. The price must come from a real source, AND the supply must be one we
   * actually read from the contract — `ensureToken` seeds a discovered token
   * with a placeholder 1e9 supply, so `price * totalSupply` on an unenriched
   * token is a guess multiplied by a guess. ANOA's fabricated $13.1M was
   * exactly that product.
   */
  marketCap(token: TrackedToken): number | null {
    return this.resolveCap(token).cap;
  }

  /**
   * Full cap resolution — the value, which source established it, and when
   * nothing could, why not. See chain/marketCap.ts for the ordering.
   *
   * Side effect by design: when a cap fails *only* because the supply was never
   * read from the contract, the token is queued for an on-chain supply backfill.
   * That failure used to be permanent — a single flaky totalSupply() left the
   * token capless for its whole life, and every cap gate suppressed it forever
   * after. Queuing (rather than fetching inline) keeps the hot detection path
   * synchronous and off the network; the next evaluation gets the answer.
   */
  resolveCap(token: TrackedToken): CapResult {
    const live = this.fresh(token.address);
    this.maybeEnqueue(token.address);
    const result = resolveMarketCap({
      sourceCap: live?.marketCap ?? null,
      price: this.priceOf(token.address),
      totalSupply: token.totalSupply,
      supplyVerified: token.supplyVerified === true,
    });
    // Queue the supply read on `no-price` TOO, not only on `unverified-supply`.
    //
    // This was a deadlock. `resolveMarketCap` short-circuits on price first, so a token with no
    // price reports `no-price` and never reaches the `unverified-supply` branch — meaning it was
    // never queued for a supply read. But a pool-derived price always stores `marketCap: null`, so a
    // pool-priced token can ONLY get a cap by deriving it from a verified supply. The token needed a
    // supply to get a cap, and needed a cap-with-price to be asked for a supply.
    //
    // Fetching the two independently costs nothing extra: `maybeEnqueueSupply` is already bounded by
    // MAX_SUPPLY_ATTEMPTS, so a contract with no working totalSupply() still gives up after 3 tries.
    if (result.reason === 'unverified-supply' || result.reason === 'no-price') {
      if (token.supplyVerified !== true) this.maybeEnqueueSupply(token.address);
    }
    return result;
  }

  /** Which source established the token's cap, or null when it has none. */
  marketCapSource(token: TrackedToken): CapSource | null {
    return this.resolveCap(token).source;
  }

  /** True when the token currently has a REAL price (DexScreener or its pool). */
  isLive(tokenAddress: string): boolean {
    return this.fresh(tokenAddress) !== null;
  }

  /** Which real source the current price came from, or null when unknown. */
  sourceOf(tokenAddress: string): PriceSource | null {
    return this.fresh(tokenAddress)?.source ?? null;
  }

  /** Live DEX liquidity (USD) for the token, or null if unknown. */
  liquidityOf(tokenAddress: string): number | null {
    return this.fresh(tokenAddress)?.liquidityUsd ?? null;
  }

  /** Pair creation time (unix ms) for the token, or null if unknown. */
  pairCreatedAt(tokenAddress: string): number | null {
    return this.fresh(tokenAddress)?.pairCreatedAt ?? null;
  }

  /** Highest market cap seen for this token since tracking began, or null if
   *  it has never had a live price. Always >= the current market cap. */
  athMarketCapOf(tokenAddress: string): number | null {
    return this.athMarketCap.get(tokenAddress.toLowerCase()) ?? null;
  }

  /** Volume/momentum confirmation for the token, or null if no live pair. */
  momentumOf(tokenAddress: string): MomentumReport | null {
    const l = this.fresh(tokenAddress);
    if (!l) return null;
    return computeMomentum({
      volumeUsd: l.volume24,
      priceChange1h: l.priceChangeH1,
      priceChange24h: l.priceChangeH24,
      buys: l.buys24,
      sells: l.sells24,
    });
  }

  /** DEX id (e.g. "uniswap") for the token's best pair, or null. */
  dexIdOf(tokenAddress: string): string | null {
    return this.fresh(tokenAddress)?.dexId ?? null;
  }

  /**
   * Native-token (ETH/WETH) USD price, derived from a live pair as
   * priceUsd / priceNative — a token's priceUsd is quoted against its QUOTE
   * currency, so that ratio is the quote token's USD rate.
   *
   * That is the ETH/USD rate ONLY IF the quote token is WETH. The original
   * version assumed it always was and took whichever pair was fetched most
   * recently, which is how a single stablecoin-quoted pair could set the
   * process-wide ETH rate to ~$1.00.
   *
   * [verified 2026-08-04] It did. Recovering the implied rate from 24 closed
   * positions (exitPriceUsd x tokensReceived / exitValueEth) gives 13 at ~$1900,
   * but 8 at ~$1.00, two at ~$113, one at ~$22 and one at ~$0.0089 — every
   * non-WETH quote in the cache, stamped onto whatever position happened to
   * close while it was the newest entry. Those exits recorded a fill price up to
   * ~1900x wrong.
   *
   * Three changes, in order of how much they matter:
   *  1. Only WETH-quoted pairs count. A pair whose quote we cannot identify is
   *     skipped, never guessed at — same rule as the rest of this file.
   *  2. The MEDIAN of the fresh candidates, not the newest one. One anomalous
   *     pair should not be able to move the rate the whole process prices with.
   *  3. A plausibility band. This is a backstop, not the fix: it rejects a
   *     catastrophically wrong rate rather than trying to correct one, and it
   *     is deliberately wide enough to never clip a real market move.
   *
   * Returns null when nothing qualifies — unknown, not a guess.
   */
  ethUsdPrice(): number | null {
    const weth = config.SNIPER_WETH?.toLowerCase();
    const now = Date.now();
    const rates: number[] = [];
    if (weth) {
      for (const l of this.live.values()) {
        if (!l.priceNative || l.priceNative <= 0) continue;
        if (l.quoteToken !== weth) continue; // not an ETH-quoted pair: its ratio is some OTHER token's USD rate
        if (now - l.fetchedAt > LIVE_STALE_MS) continue;
        const rate = l.priceUsd / l.priceNative;
        if (Number.isFinite(rate) && rate >= ETH_USD_MIN && rate <= ETH_USD_MAX) rates.push(rate);
      }
    }
    if (rates.length) {
      rates.sort((a, b) => a - b);
      const m = rates.length >> 1;
      return rates.length % 2 ? rates[m]! : (rates[m - 1]! + rates[m]!) / 2;
    }
    // Nothing qualifies — fall back to the last reference rate we fetched.
    return this.ethUsdRef && now - this.ethUsdRef.at < ETH_USD_REF_TTL_MS
      ? this.ethUsdRef.rate
      : null;
  }

  /**
   * The ETH/USD rate, fetching a reference if nothing cached provides one.
   *
   * The derived-from-any-live-pair trick above only works once some pair has
   * been fetched, which is not true early in a process — and "early in a
   * process, on a coin DexScreener hasn't indexed" is precisely when the pool
   * fallback runs. Without a rate the pool's ETH price cannot reach USD and the
   * token would report as unpriced for no good reason.
   *
   * Querying WETH's own token page solves it: DexScreener never lists WETH as a
   * BASE token, but it does return the pairs quoting it, and for any of those
   * `priceUsd / priceNative` IS the ETH/USD rate. Takes the deepest pair.
   */
  private async ensureEthUsd(): Promise<number | null> {
    const cached = this.ethUsdPrice();
    if (cached != null && cached > 0) return cached;
    if (!config.SNIPER_WETH) return null;
    // Primary reference is the canonical on-chain WETH/USDG market. That means
    // a cold process can price a fresh V3/V4 pool without waiting for a public
    // indexer to recover or index the pair.
    const onChain = await this.pools.ethUsdFromUsdG();
    if (onChain != null && onChain >= ETH_USD_MIN && onChain <= ETH_USD_MAX) {
      this.ethUsdRef = { rate: onChain, at: Date.now() };
      return onChain;
    }
    // Last-resort display fallback. Failure here returns unknown; it never
    // changes wallet-trade proof or discards a durable candidate.
    try {
      const res = await this.fetchDexScreener(`https://api.dexscreener.com/latest/dex/tokens/${config.SNIPER_WETH}`);
      if (!res.ok) return null;
      const json = (await res.json()) as { pairs?: DexPair[] };
      const chain = config.DEXSCREENER_CHAIN.toLowerCase();
      let best: { rate: number; liq: number } | null = null;
      for (const p of json.pairs ?? []) {
        if ((p.chainId ?? '').toLowerCase() !== chain) continue;
        const usd = Number(p.priceUsd);
        const native = Number(p.priceNative);
        if (!Number.isFinite(usd) || !Number.isFinite(native) || usd <= 0 || native <= 0) continue;
        const liq = p.liquidity?.usd ?? 0;
        if (!best || liq > best.liq) best = { rate: usd / native, liq };
      }
      if (!best) return null;
      this.ethUsdRef = { rate: best.rate, at: Date.now() };
      return best.rate;
    } catch (err) {
      logger.debug({ err: String(err) }, 'eth/usd reference fetch failed');
      return null;
    }
  }

  /** DexScreener pair identifier for the token's best pair, or null. On
   *  Uniswap v4 chains this is the 32-byte POOL ID — the sniper uses it to
   *  resolve the exact on-chain PoolKey instead of guessing pool params. */
  pairIdOf(tokenAddress: string): string | null {
    return this.fresh(tokenAddress)?.pairAddress || null;
  }

  /**
   * Fetch this token's price/market cap right now if we don't already have a
   * fresh value. Used at alert time so the market cap in a notification is the
   * real one, not the synthetic placeholder (important for just-discovered
   * tokens the background refresher hasn't reached yet).
   */
  async refreshNow(tokenAddress: string): Promise<void> {
    if (!this.liveEnabled) return;
    const key = tokenAddress.toLowerCase();
    if (this.fresh(key)) return;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = this.fetchOne(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    await work;
  }

  /**
   * Alert-time quote path. Reads the canonical pool before public market data,
   * so a DexScreener throttle is never on the path to a confirmed signal.
   */
  async refreshOnChainNow(tokenAddress: string): Promise<void> {
    if (!this.pools.enabled) return this.refreshNow(tokenAddress);
    const key = tokenAddress.toLowerCase();
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = (async () => {
      await this.fetchFromPool(key);
      // Preserve legacy/V2 display coverage. This only runs when canonical
      // V3/V4 pool discovery genuinely has no answer; it is never ahead of the
      // critical on-chain path.
      if (!this.fresh(key)) await this.fetchOne(key);
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    await work;
  }

  /**
   * Put a displayed token at the front of the next bounded refresh.  This is
   * intentionally asynchronous: chain detection never waits on DexScreener,
   * but a new visible row must not sit behind hundreds of restored tokens.
   */
  /**
   * Why a price is missing, made countable. "marketCap unresolved" was
   * undiagnosable without knowing whether the sweep is running, how deep the
   * queue is, and whether DexScreener is throttling — each a different fix.
   */
  private readonly debugCounters = { dex429: 0, dexErrors: 0, lastSweepAt: 0, poolDisagreements: 0 };

  debug(): Record<string, unknown> {
    return {
      backgroundQueue: this.queue.size,
      priorityQueue: this.priorityQueue.size,
      inflight: this.inflight.size,
      lastSweepAt: this.debugCounters.lastSweepAt || null,
      lastSweepAgeMs: this.debugCounters.lastSweepAt ? Date.now() - this.debugCounters.lastSweepAt : null,
      dex429Count: this.debugCounters.dex429,
    poolDisagreements: this.debugCounters.poolDisagreements,
      dexErrorCount: this.debugCounters.dexErrors,
      // Read from the constants, not restated. This said `1` for as long as MAX_PER_TICK was 1, so
      // the number that would have exposed the starvation was itself a literal nobody had to update.
      sweepPerTick: MAX_PER_TICK,
      sweepBatchSize: DEX_BATCH_SIZE,
      sweepIntervalMs: config.PRICE_REFRESH_MS,
    };
  }

  requestRefresh(tokenAddress: string): void {
    if (!this.liveEnabled) return;
    const key = tokenAddress.toLowerCase();
    if (this.fresh(key)) return;
    this.queue.delete(key);
    this.priorityQueue.add(key);
  }

  /**
   * Warm a small set of already-visible signals on boot. This is separate from
   * the broad scheduler because a durable feed can contain hundreds of tokens,
   * while the handful actually on screen should not wait behind that backlog.
   */
  async warmVisible(tokens: Iterable<string>, limit = 24): Promise<void> {
    const unique = [...new Set([...tokens].map((t) => t.toLowerCase()))].slice(0, limit);
    const concurrency = 1;
    for (let i = 0; i < unique.length; i += concurrency) {
      await Promise.all(unique.slice(i, i + concurrency).map((token) => this.refreshNow(token)));
    }
  }

  /** The display may say either how the price was established or why it is absent. */
  quoteState(tokenAddress: string): 'live' | 'pricing' | 'unavailable' {
    const key = tokenAddress.toLowerCase();
    if (this.fresh(key)) return 'live';
    if (this.priorityQueue.has(key) || this.queue.has(key)) return 'pricing';
    return 'unavailable';
  }

  /** Best DexScreener link: the precise pair page when known, else token search. */
  dexUrl(tokenAddress: string): string {
    const live = this.fresh(tokenAddress);
    if (live?.pairAddress) {
      return `https://dexscreener.com/${live.chainId}/${live.pairAddress}`;
    }
    return dexScreenerUrl(tokenAddress);
  }

  // ── Background refresh ────────────────────────────────────────────────────
  start(): void {
    if (!this.liveEnabled) {
      logger.warn(
        { synthetic: config.PRICE_SYNTHETIC_FALLBACK },
        'price oracle: NO real price source (set DEXSCREENER_CHAIN and/or CHAIN_HTTP_URL+SNIPER_WETH) — prices read as unknown',
      );
      return;
    }
    logger.info(
      { chain: config.DEXSCREENER_CHAIN, poolFallback: this.pools.enabled },
      'price oracle: live prices',
    );
    if (config.PRICE_SYNTHETIC_FALLBACK) {
      logger.warn('PRICE_SYNTHETIC_FALLBACK is ON — unpriced tokens get a FABRICATED price. Dev only.');
    }
    // Do not leave a recovered dashboard blank until the first interval.
    void this.refresh();
    this.timer = setInterval(() => {
      this.debugCounters.lastSweepAt = Date.now();
      void this.refresh();
    }, config.PRICE_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    // Re-price known tokens that have gone stale, plus anything newly queued.
    //
    // BOUNDED. This loop walks the whole registry, so on a long-running process it was re-adding
    // thousands of historical tokens every 15s and the queue only ever grew — measured at 12,345
    // entries against a drain of one. The speculative sweep now stops at a ceiling; the priority
    // queue is untouched by it, because that is where tokens under an actual decision live.
    if (this.store && this.queue.size < MAX_BACKGROUND_QUEUE) {
      for (const addr of this.store.tokensByAddress.keys()) {
        if (this.queue.size >= MAX_BACKGROUND_QUEUE) break;
        this.maybeEnqueue(addr);
      }
    }
    // Evict stale/overflowing live prices.
    const staleBefore = Date.now() - LIVE_STALE_MS;
    for (const [addr, l] of this.live) if (l.fetchedAt < staleBefore) this.live.delete(addr);
    capMap(this.live, MAX_CACHE);

    await this.drainSupplyQueue();

    if (this.priorityQueue.size === 0 && this.queue.size === 0) return;
    // Priority first and in full-tick order: a token something is deciding on must never wait behind
    // the speculative backlog, which is exactly what the old flat slice allowed.
    const batch = [...this.priorityQueue, ...this.queue].slice(0, MAX_PER_TICK);
    for (const a of batch) {
      this.priorityQueue.delete(a);
      this.queue.delete(a);
    }

    // Batched, sequentially — `fetchDexScreener` serializes and paces requests anyway, so issuing
    // these in parallel would only queue them behind each other while looking concurrent.
    for (let i = 0; i < batch.length; i += DEX_BATCH_SIZE) {
      const slice = batch.slice(i, i + DEX_BATCH_SIZE);
      const covered = await this.fetchBatch(slice);
      // Whatever the response did not cover — truncated by the 30-pair cap, throttled, or simply not
      // indexed — must not be silently forgotten. But it must not spin at priority forever either:
      // a token DexScreener genuinely does not carry would then loop ahead of real work, which is
      // the same starvation single-token requests were protecting against.
      //
      // So: retry the cheap way twice (truncation and throttles are transient), then fall through to
      // the pool ONCE, which is the answer for a brand-new pair no indexer has seen. Either way the
      // token leaves this loop.
      for (const addr of slice) {
        if (covered.has(addr) || this.fresh(addr)) {
          this.dexMisses.delete(addr);
          continue;
        }
        const misses = (this.dexMisses.get(addr) ?? 0) + 1;
        if (misses < DEX_MISS_RETRIES) {
          this.dexMisses.set(addr, misses);
          this.priorityQueue.add(addr);
          continue;
        }
        this.dexMisses.delete(addr);
        await this.fetchFromPool(addr).catch(() => undefined);
      }
    }
  }

  /**
   * Backfill supplies the metadata read never established, so a cap blocked on
   * `supplyVerified` can become resolvable instead of staying unknown for the
   * token's whole life. Reads the contract directly — the most authoritative
   * supply there is, and no third-party dependency.
   */
  private async drainSupplyQueue(): Promise<void> {
    if (this.supplyQueue.size === 0 || !this.store) return;
    const batch = [...this.supplyQueue].slice(0, MAX_SUPPLY_PER_TICK);
    for (const a of batch) this.supplyQueue.delete(a);
    await Promise.all(
      batch.map(async (address) => {
        this.supplyAttempts.set(address, (this.supplyAttempts.get(address) ?? 0) + 1);
        const meta = await fetchTokenMetadata(config.CHAIN_HTTP_URL, address).catch(() => null);
        if (!meta?.supplyVerified) return;
        this.store?.updateTokenMeta(address, meta);
        this.supplyAttempts.delete(address);
        logger.debug(
          { token: address, totalSupply: meta.totalSupply },
          'price: backfilled on-chain supply — market cap is now resolvable',
        );
      }),
    );
    capMap(this.supplyAttempts, MAX_CACHE);
  }

  /**
   * Price several tokens in ONE request, and report which ones actually came back.
   *
   * The multi-token route caps its response at 30 pairs, so a batch can be silently truncated. That
   * is the whole reason this codebase used single-token requests — the danger was never the batching,
   * it was trusting it. So this returns the covered set and the caller re-queues the difference; a
   * truncated response costs a retry, never a token that quietly stops being priced.
   *
   * On a non-OK response nothing is applied and NOTHING is marked covered, so the entire batch is
   * re-queued. A throttle must not read as "these tokens have no price".
   */
  private async fetchBatch(addresses: string[]): Promise<Set<string>> {
    const covered = new Set<string>();
    if (!addresses.length) return covered;
    const chain = config.DEXSCREENER_CHAIN.toLowerCase();
    try {
      const res = await this.fetchDexScreener(
        `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`,
      );
      if (!res.ok) {
        if (res.status === 429) this.debugCounters.dex429++;
        else this.debugCounters.dexErrors++;
        logger.warn({ batch: addresses.length, status: res.status }, 'price: DexScreener batch failed');
        return covered;
      }
      const json = (await res.json()) as DexTokenResponse;
      const pairs = Array.isArray(json) ? json : json.pairs ?? [];
      // Best (deepest) pair per requested address, on our chain, where it is the BASE token.
      const best = new Map<string, DexPair>();
      for (const p of pairs) {
        if ((p.chainId ?? '').toLowerCase() !== chain) continue;
        const addr = p.baseToken?.address?.toLowerCase();
        if (!addr || !addresses.includes(addr)) continue;
        const cur = best.get(addr);
        if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(addr, p);
      }
      for (const [addr, pair] of best) {
        if (this.applyPair(addr, pair)) covered.add(addr);
      }
    } catch (err) {
      logger.debug({ err: String(err) }, 'price: DexScreener batch fetch failed');
    }
    return covered;
  }

  /**
   * Write one DexScreener pair into the live cache. Returns false when the pair carries no usable
   * price, so the caller can fall through to the pool rather than record a token as "done".
   *
   * Shared by the single and batched paths so the two can never drift into recording a token
   * differently depending on how it happened to be fetched.
   */
  private applyPair(address: string, best: DexPair): boolean {
    const priceUsd = Number(best.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
    const priceNative = Number(best.priceNative);
    const marketCap = best.marketCap ?? best.fdv ?? null;
    this.recordAth(address, marketCap);
    this.live.set(address, {
      source: 'dexscreener',
      priceUsd,
      priceNative: Number.isFinite(priceNative) && priceNative > 0 ? priceNative : null,
      quoteToken: best.quoteToken?.address?.toLowerCase() ?? null,
      marketCap,
      liquidityUsd: best.liquidity?.usd ?? null,
      pairCreatedAt: best.pairCreatedAt ?? null,
      volume24: best.volume?.h24 ?? null,
      priceChangeH1: best.priceChange?.h1 ?? null,
      priceChangeH24: best.priceChange?.h24 ?? null,
      buys24: best.txns?.h24?.buys ?? null,
      sells24: best.txns?.h24?.sells ?? null,
      dexId: best.dexId ?? null,
      pairAddress: best.pairAddress ?? '',
      chainId: best.chainId ?? config.DEXSCREENER_CHAIN,
      fetchedAt: Date.now(),
    });
    // Enrich a discovered token's placeholder symbol from the real pair.
    const sym = best.baseToken?.symbol;
    const tok = this.store?.tokensByAddress.get(address);
    if (sym && tok?.discovered && tok.symbol.startsWith('TKN-')) {
      this.store?.updateTokenMeta(address, { symbol: sym, name: sym });
    }
    return true;
  }

  private async fetchOne(address: string): Promise<void> {
    const chain = config.DEXSCREENER_CHAIN.toLowerCase();
    try {
      // This chain-specific endpoint avoids the globally throttled
      // `latest/dex/tokens` fan-out route. It returns the same pair records,
      // but only for the chain we actually observe.
      const res = await this.fetchDexScreener(
        `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${address}`,
      );
      if (!res.ok) {
        if (res.status === 429) this.debugCounters.dex429++;
        else this.debugCounters.dexErrors++;
        logger.warn({ token: address, status: res.status }, 'price: DexScreener request failed');
        // A public-indexer throttle is not evidence the pool lacks a price.
        // Establish it on chain immediately; Dex is optional enrichment.
        await this.fetchFromPool(address).catch(() => undefined);
        if (res.status === 429 && !this.fresh(address)) this.requestRefresh(address);
        return;
      }
      const json = (await res.json()) as DexTokenResponse;
      const pairs = Array.isArray(json) ? json : json.pairs ?? [];

      // Highest-liquidity pair on the configured chain where this is the base token.
      let best: DexPair | null = null;
      for (const p of pairs) {
        if ((p.chainId ?? '').toLowerCase() !== chain) continue;
        if (p.baseToken?.address?.toLowerCase() !== address) continue;
        if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
      }
      // Not indexed yet (the normal state for a pair minutes old) — go to the
      // pool itself rather than leaving the token priceless.
      if (!best) {
        logger.debug({ token: address, chain }, 'price: no matching DexScreener pair; trying on-chain pool');
        await this.fetchFromPool(address);
        return;
      }

      // A pair with no usable price is not an answer — fall through to the pool.
      if (!this.applyPair(address, best)) await this.fetchFromPool(address);
    } catch (err) {
      logger.debug({ err: String(err) }, 'dexscreener price fetch failed');
      await this.fetchFromPool(address).catch(() => undefined);
    }
  }

  /**
   * DexScreener's public endpoint is quotaed by egress IP. Railway services
   * share one, so parallel fetches look like an abusive burst even when this
   * process is modest. A 429 pauses the entire lane instead of immediately
   * retrying the same failing pattern.
   */
  private async fetchDexScreener(url: string): Promise<Response> {
    let release: () => void = () => undefined;
    const previous = this.dexTail;
    this.dexTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, this.dexNextAt - Date.now());
      if (delay) await sleep(delay);
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 6_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        this.dexNextAt = Date.now() + (res.status === 429 ? DEX_429_COOLDOWN_MS : DEX_MIN_INTERVAL_MS);
        return res;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      release();
    }
  }

  /**
   * Price the token off its deepest ETH-paired pool. Used when DexScreener has
   * no pair — the brand-new-coin window.
   *
   * Needs an ETH/USD rate to reach USD, and that rate comes from any currently
   * live DexScreener pair (see ethUsdPrice). Pool-derived entries store
   * `priceNative: null` deliberately so they can never feed that derivation and
   * make it self-referential. No rate → no USD price → the token stays unknown,
   * which is the honest answer.
   */
  private async fetchFromPool(address: string): Promise<void> {
    if (!this.pools.enabled) return;
    const ethUsd = await this.ensureEthUsd();
    if (ethUsd == null || !(ethUsd > 0)) return;
    const pool = await this.pools.priceEthOf(address).catch(() => null);
    if (!pool) return;
    const priceUsd = pool.priceEth * ethUsd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
    // DISAGREEMENT GUARD. When the indexer already has a live price for this token and the pool read
    // is wildly different, one of the two is wrong and we cannot tell which — so the indexer wins
    // (it prices the deepest pair; a cold pool discovery can land on a shallow one) and the
    // disagreement is COUNTED rather than swallowed.
    //
    // [verified 2026-08-09] Eight records took pool prices 21x-334x below the truth on two-to-three
    // week old pairs with real liquidity, and every downstream number was computed from them. The
    // error ran LOW there, so the $25k floor rejected them — the safe direction. Inverted, it is the
    // ANOA incident this repo already paid for: a fabricated cap sailing through the one floor whose
    // only job was to stop it. A market cap is only as true as its price.
    const prior = this.fresh(address);
    if (prior && prior.source === 'dexscreener' && prior.priceUsd > 0) {
      const ratio = priceUsd > prior.priceUsd ? priceUsd / prior.priceUsd : prior.priceUsd / priceUsd;
      if (ratio > POOL_DISAGREEMENT_MAX) {
        this.debugCounters.poolDisagreements++;
        logger.warn(
          { token: address, venue: pool.venue, poolPriceUsd: priceUsd, indexerPriceUsd: prior.priceUsd, ratio: Math.round(ratio) },
          'price oracle: pool read disagrees with the indexer — keeping the indexer price',
        );
        return;
      }
    }
    logger.debug(
      { token: address, venue: pool.venue, priceUsd },
      'price oracle: priced from chain (no DexScreener pair)',
    );
    this.live.set(address, {
      source: 'pool',
      priceUsd,
      priceNative: null,
      quoteToken: null,
      // A pool knows a price, not a supply — market cap is derived by the
      // caller from a VERIFIED total supply, or left unknown.
      marketCap: null,
      // Depth here is raw uint128 L, which is not a USD figure and must not be
      // presented as one. Unknown until DexScreener indexes the pair.
      liquidityUsd: null,
      pairCreatedAt: pool.pairCreatedAt,
      volume24: null,
      priceChangeH1: null,
      priceChangeH24: null,
      buys24: null,
      sells24: null,
      dexId: pool.venue === 'v4' ? 'uniswap-v4' : 'uniswap-v3',
      pairAddress: '',
      chainId: config.DEXSCREENER_CHAIN,
      fetchedAt: Date.now(),
    });
    capMap(this.live, MAX_CACHE);
  }

  /** Track the highest market cap seen, ignoring unknowns. */
  private recordAth(address: string, marketCap: number | null): void {
    if (marketCap == null || !(marketCap > 0)) return;
    if (marketCap > (this.athMarketCap.get(address) ?? 0)) {
      this.athMarketCap.set(address, marketCap);
      capMap(this.athMarketCap, MAX_CACHE);
    }
  }
}

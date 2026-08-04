import type { MomentumReport, TrackedToken } from '../types.js';
import type { MemoryStore } from '../store/memory.js';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { dexScreenerUrl } from '../links.js';
import { computeMomentum } from './momentum.js';
import { PoolPriceReader } from './poolPrice.js';

/** Where a live price came from. Never 'synthetic' — a fabricated number is not
 *  a price, and is only ever produced when PRICE_SYNTHETIC_FALLBACK is on. */
export type PriceSource = 'dexscreener' | 'pool';

interface LivePrice {
  /** Which real source produced this price. */
  source: PriceSource;
  priceUsd: number;
  /** Price in the pair's quote currency (almost always WETH here) — lets us
   *  derive an ETH/USD rate from ANY live pair (priceUsd / priceNative), since
   *  DexScreener won't return a direct listing for WETH itself (it's the quote
   *  side of virtually every pair, never the base). */
  priceNative: number | null;
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

const TTL_MS = 60_000;
// Tokens re-priced per refresh tick. Each is a separate request because the
// multi-token endpoint caps at 30 pairs *total*, which starves busy tokens.
const MAX_PER_TICK = 12;
// Bound the caches on a long-running process (many discovered tokens).
const MAX_CACHE = 5_000;
const LIVE_STALE_MS = 30 * 60_000;
// How long a fetched ETH/USD reference rate stays usable.
const ETH_USD_REF_TTL_MS = 5 * 60_000;

/** Evict oldest-inserted entries until the map is under `max`. */
function capMap<T>(map: Map<string, T>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

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
  private readonly queue = new Set<string>();
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
    const live = this.fresh(token.address);
    this.maybeEnqueue(token.address);
    // DexScreener's own market cap is authoritative — it knows the real supply.
    if (live && live.marketCap != null && live.marketCap > 0) return live.marketCap;
    // Otherwise derive it, but only from a real price AND a verified supply.
    const price = this.priceOf(token.address);
    if (price == null || !(price > 0)) return null;
    if (!token.supplyVerified || !(token.totalSupply > 0)) return null;
    return price * token.totalSupply;
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
   * Native-token (ETH/WETH) USD price, derived from ANY currently-live pair as
   * priceUsd / priceNative — since a token's own priceUsd is already priced
   * against its quote currency (WETH here), that ratio IS the ETH/USD rate.
   * DexScreener never returns a direct "WETH" listing (WETH is the quote side
   * of virtually every pair, never the base), so this is the reliable source.
   * Returns null only if no live pair has been fetched yet.
   */
  ethUsdPrice(): number | null {
    let best: { rate: number; fetchedAt: number } | null = null;
    for (const l of this.live.values()) {
      if (!l.priceNative || l.priceNative <= 0) continue;
      const rate = l.priceUsd / l.priceNative;
      if (!best || l.fetchedAt > best.fetchedAt) best = { rate, fetchedAt: l.fetchedAt };
    }
    if (best) return best.rate;
    // Nothing cached yet — fall back to the last reference rate we fetched.
    return this.ethUsdRef && Date.now() - this.ethUsdRef.at < ETH_USD_REF_TTL_MS
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${config.SNIPER_WETH}`,
        { signal: ctrl.signal },
      );
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
    } finally {
      clearTimeout(t);
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
    await this.fetchOne(key);
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
    this.timer = setInterval(() => void this.refresh(), config.PRICE_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    // Re-price known tokens that have gone stale, plus anything newly queued.
    if (this.store) {
      for (const addr of this.store.tokensByAddress.keys()) this.maybeEnqueue(addr);
    }
    // Evict stale/overflowing live prices.
    const staleBefore = Date.now() - LIVE_STALE_MS;
    for (const [addr, l] of this.live) if (l.fetchedAt < staleBefore) this.live.delete(addr);
    capMap(this.live, MAX_CACHE);

    if (this.queue.size === 0) return;
    const batch = [...this.queue].slice(0, MAX_PER_TICK);
    for (const a of batch) this.queue.delete(a);
    await Promise.all(batch.map((a) => this.fetchOne(a)));
  }

  private async fetchOne(address: string): Promise<void> {
    const chain = config.DEXSCREENER_CHAIN.toLowerCase();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const json = (await res.json()) as { pairs?: DexPair[] };

      // Highest-liquidity pair on the configured chain where this is the base token.
      let best: DexPair | null = null;
      for (const p of json.pairs ?? []) {
        if ((p.chainId ?? '').toLowerCase() !== chain) continue;
        if (p.baseToken?.address?.toLowerCase() !== address) continue;
        if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
      }
      // Not indexed yet (the normal state for a pair minutes old) — go to the
      // pool itself rather than leaving the token priceless.
      if (!best) {
        await this.fetchFromPool(address);
        return;
      }

      const priceUsd = Number(best.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        await this.fetchFromPool(address);
        return;
      }
      const priceNative = Number(best.priceNative);
      const marketCap = best.marketCap ?? best.fdv ?? null;
      this.recordAth(address, marketCap);
      this.live.set(address, {
        source: 'dexscreener',
        priceUsd,
        priceNative: Number.isFinite(priceNative) && priceNative > 0 ? priceNative : null,
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
    } catch (err) {
      logger.debug({ err: String(err) }, 'dexscreener price fetch failed');
      await this.fetchFromPool(address).catch(() => undefined);
    } finally {
      clearTimeout(t);
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
    logger.debug(
      { token: address, venue: pool.venue, priceUsd },
      'price oracle: priced from chain (no DexScreener pair)',
    );
    this.live.set(address, {
      source: 'pool',
      priceUsd,
      priceNative: null,
      // A pool knows a price, not a supply — market cap is derived by the
      // caller from a VERIFIED total supply, or left unknown.
      marketCap: null,
      // Depth here is raw uint128 L, which is not a USD figure and must not be
      // presented as one. Unknown until DexScreener indexes the pair.
      liquidityUsd: null,
      pairCreatedAt: null,
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

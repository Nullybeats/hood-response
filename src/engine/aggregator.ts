import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import type { MemoryStore } from '../store/memory.js';
import type { PriceOracle } from '../chain/price.js';
import type { Swarm, SwapEvent } from '../types.js';
import { walletId } from '../walletId.js';
import { computeConviction } from './conviction.js';

interface WindowState {
  events: SwapEvent[];
  lastEmittedWallets: number;
}

/**
 * In-memory, time-windowed aggregation engine. Every swap is bucketed by
 * (token, direction); when the count of *unique* tracked wallets in the live
 * window crosses the detection floor, a swarm candidate is produced. Rotations
 * are detected when a fresh buy-swarm's wallets recently sold a different token.
 *
 * The engine never emits the same swarm twice for the same wallet set — it only
 * re-emits when the set grows — and it holds everything in memory so the hot
 * path stays sub-millisecond.
 */
/** Minimum gap between solo-buy candidates for the same token (ms). */
const SOLO_THROTTLE_MS = 60_000;

export class Aggregator {
  private readonly windows = new Map<string, WindowState>();
  private readonly lastSolo = new Map<string, number>();
  /** (wallet:token) pairs we've already seen a buy for — powers first-entry. */
  private readonly seenBuys = new Set<string>();

  /** Detection floor = smallest wallet threshold across all enabled rules. */
  detectionFloor = config.ALERT_MIN_WALLETS;
  /** Widest window (seconds) any rule cares about; bounds pruning. */
  maxWindowSeconds = config.ALERT_WINDOW_SECONDS;

  constructor(
    private readonly store: MemoryStore,
    private readonly price: PriceOracle,
  ) {}

  private key(token: string, direction: string): string {
    return `${token}:${direction}`;
  }

  private prune(now: number): void {
    const cutoff = now - this.maxWindowSeconds * 1000;
    for (const [key, state] of this.windows) {
      state.events = state.events.filter((e) => e.timestamp >= cutoff);
      if (state.events.length === 0) {
        this.windows.delete(key);
      } else {
        // If the window drained below the last emit size, allow re-emit later.
        const unique = new Set(state.events.map((e) => e.wallet)).size;
        if (unique < state.lastEmittedWallets) state.lastEmittedWallets = unique;
      }
    }
    // Solo throttle entries only matter within the throttle window.
    for (const [token, ts] of this.lastSolo) {
      if (now - ts > SOLO_THROTTLE_MS) this.lastSolo.delete(token);
    }
    // Bound the first-entry memory on a very long-running process.
    if (this.seenBuys.size > 200_000) this.seenBuys.clear();
  }

  /** Should this swap be considered for swarm detection? */
  private eligible(swap: SwapEvent): boolean {
    // An unvalued swap cannot clear a USD floor — we have no idea what it is
    // worth. Fails closed: detection would otherwise be sized in fabricated
    // dollars, which is what the synthetic price used to supply.
    if (config.IGNORE_DUST_USD > 0) {
      if (swap.usdValue == null || swap.usdValue < config.IGNORE_DUST_USD) return false;
    }
    // Skip settlement/quote tokens and tokenised equities — never gems, and the
    // quote-token leg of a real buy would otherwise fire a spurious sell.
    if (config.ignoreSymbols.has(swap.tokenSymbol.toUpperCase())) return false;
    if (config.IGNORE_STABLECOINS) {
      const token = this.store.tokensByAddress.get(swap.token);
      if (token?.stable) return false;
    }
    if (!this.store.isTracked(swap.wallet)) return false;
    // Muted wallet groups (e.g. HMM turned off) — drop before detection so they
    // never form or grow a swarm, solo, or first-entry.
    if (this.store.isWalletMuted(swap.wallet)) return false;
    return true;
  }

  /** Feed one swap; returns any swarms detected as a result. */
  ingest(swap: SwapEvent): Swarm[] {
    if (!this.eligible(swap)) return [];
    this.prune(swap.timestamp);

    const key = this.key(swap.token, swap.direction);
    const state = this.windows.get(key) ?? { events: [], lastEmittedWallets: 0 };
    state.events.push(swap);
    this.windows.set(key, state);

    const swarms: Swarm[] = [];
    const direct = this.detectDirect(key, state, swap);
    if (direct) {
      swarms.push(direct);
      const rotation = this.detectRotation(direct);
      if (rotation) swarms.push(rotation);
    }
    return swarms;
  }

  /**
   * Build a single-wallet SOLO buy candidate (throttled per token). The market
   * cap gate lives in the async pipeline, which fetches the real market cap
   * before deciding whether this low-cap-only alert should fire.
   */
  soloCandidate(swap: SwapEvent): Swarm | null {
    if (!config.SOLO_ALERTS || swap.direction !== 'BUY') return null;
    if (!this.eligible(swap)) return null;
    // Throttle per (wallet, token), not per token, so a busy wallet re-buying is
    // debounced but a DIFFERENT tracked wallet buying the same coin still
    // produces its own solo candidate (the engine dedups/escalates from there).
    const throttleKey = `${swap.wallet}:${swap.token}`;
    const last = this.lastSolo.get(throttleKey) ?? 0;
    if (swap.timestamp - last < SOLO_THROTTLE_MS) return null;
    this.lastSolo.set(throttleKey, swap.timestamp);
    return this.buildSwarm('SOLO', swap.token, [swap]);
  }

  /**
   * Build an ENTRY candidate when a qualifying-tier wallet makes its first-ever
   * (since start) buy of a token. Pair-freshness is confirmed later in the
   * pipeline, which has the live pair age. Marks the (wallet,token) as seen for
   * ALL buys so we never re-fire, regardless of tier.
   */
  firstEntryCandidate(swap: SwapEvent): Swarm | null {
    if (!config.FRESH_ENTRY_ALERTS || swap.direction !== 'BUY') return null;
    if (!this.eligible(swap)) return null;
    const key = `${swap.wallet}:${swap.token}`;
    const first = !this.seenBuys.has(key);
    this.seenBuys.add(key);
    if (!first) return null;
    const tier = this.store.wallets.get(swap.wallet)?.tier ?? 'delta';
    if (!config.freshEntryTiers.includes(tier)) return null;
    return this.buildSwarm('ENTRY', swap.token, [swap]);
  }

  private detectDirect(key: string, state: WindowState, swap: SwapEvent): Swarm | null {
    // Latest swap per unique wallet (ignore duplicate wallets rule).
    const latest = new Map<string, SwapEvent>();
    for (const e of state.events) latest.set(e.wallet, e);
    const uniqueCount = latest.size;

    if (uniqueCount < this.detectionFloor) return null;
    if (uniqueCount <= state.lastEmittedWallets) return null;
    state.lastEmittedWallets = uniqueCount;

    return this.buildSwarm(swap.direction === 'BUY' ? 'BUY' : 'SELL', swap.token, [
      ...latest.values(),
    ]);
  }

  private detectRotation(buySwarm: Swarm): Swarm | null {
    if (buySwarm.kind !== 'BUY') return null;
    const buyers = new Set(buySwarm.wallets);

    // Look for a recent SELL window (different token) sharing enough wallets.
    for (const [key, state] of this.windows) {
      const [token, direction] = key.split(':');
      if (direction !== 'SELL' || token === buySwarm.token) continue;
      const sellers = new Map<string, SwapEvent>();
      for (const e of state.events) if (buyers.has(e.wallet)) sellers.set(e.wallet, e);
      if (sellers.size < this.detectionFloor) continue;

      const swarm = this.buildSwarm('ROTATION', token!, [...sellers.values()]);
      swarm.rotatedIntoSymbol = buySwarm.tokenSymbol;
      return swarm;
    }
    return null;
  }

  private buildSwarm(kind: Swarm['kind'], tokenAddr: string, events: SwapEvent[]): Swarm {
    // ensureToken guarantees a registry entry even for freshly discovered tokens.
    const token = this.store.ensureToken(tokenAddr, events[0]?.tokenSymbol);
    const wallets = events.map((e) => e.wallet);
    const walletObjs = wallets
      .map((a) => this.store.wallets.get(a))
      .filter((w): w is NonNullable<typeof w> => Boolean(w));
    // Only priced legs contribute. `eligible()` already drops unvalued swaps
    // when a dust floor is set; this keeps the sum honest when it is not.
    const totalUsd = events.reduce((s, e) => s + (e.usdValue ?? 0), 0);
    const timestamps = events.map((e) => e.timestamp);
    const firstSeen = Math.min(...timestamps);
    const lastSeen = Math.max(...timestamps);
    const windowSeconds = Math.max((lastSeen - firstSeen) / 1000, 0.001);

    const marketCap = this.price.marketCap(token);
    const { score, breakdown } = computeConviction({
      wallets: walletObjs,
      swaps: events,
      token,
      windowSeconds,
      totalUsd,
      marketCap,
    });

    return {
      id: randomUUID(),
      kind,
      token: token.address,
      tokenSymbol: token.symbol,
      walletCount: wallets.length,
      wallets,
      walletSummary: summarizeWallets(walletObjs, wallets.length),
      walletLabels: walletObjs.map((w) => w.label),
      // Index-aligned with walletLabels (same source array) so a consumer can pair label→id.
      walletIds: walletObjs.map((w) => walletId(w.address)),
      alsoHold: crossHoldings(walletObjs, token.symbol),
      totalUsd,
      marketCap,
      newToken: token.discovered === true,
      dexUrl: this.price.dexUrl(token.address),
      priceLive: this.price.isLive(token.address),
      priceSource: this.price.sourceOf(token.address),
      conviction: score,
      convictionBreakdown: breakdown,
      windowSeconds: Number(windowSeconds.toFixed(2)),
      firstSeen,
      lastSeen,
    };
  }
}

const TIER_ORDER = ['alpha', 'beta', 'chroma', 'delta'];

/**
 * Build a privacy-preserving makeup string from wallet tiers, e.g.
 * "2 alpha · 1 beta · 1 delta" — no addresses are exposed.
 */
/** Other tracked coins these wallets also hold (excluding the swarm token). */
function crossHoldings(
  wallets: { holdsTokens: string[] }[],
  ownSymbol: string,
): string[] {
  const set = new Set<string>();
  for (const w of wallets) for (const c of w.holdsTokens) if (c !== ownSymbol) set.add(c);
  return [...set].sort();
}

function summarizeWallets(wallets: { tier?: string }[], total: number): string {
  if (wallets.length === 0) return `${total} tracked`;
  const counts = new Map<string, number>();
  for (const w of wallets) {
    const tier = w.tier ?? 'unknown';
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (TIER_ORDER.indexOf(a[0]) - TIER_ORDER.indexOf(b[0])) || b[1] - a[1])
    .map(([tier, n]) => `${n} ${tier}`)
    .join(' · ');
}

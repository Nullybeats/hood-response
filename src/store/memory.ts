import { EventEmitter } from 'node:events';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Alert,
  AlertRule,
  Swarm,
  SwapEvent,
  TrackedToken,
  TrackedWallet,
} from '../types.js';
import { SEED_TOKENS, SEED_WALLETS } from '../data/seed.js';
import { applyWalletOverrides } from './walletOverrides.js';
import { config } from '../config/env.js';
import { logger } from '../logger.js';

interface PersistedSettings {
  mutedTokens: string[];
  blueChipBuys: boolean;
  blueChipSells: boolean;
}

/** Fixed-size ring buffer of the most recent items. */
class Ring<T> {
  private buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  /** Newest first. */
  recent(limit = this.cap): T[] {
    return this.buf.slice(-limit).reverse();
  }
  /** Oldest first — the order `restore` expects back. */
  drain(): T[] {
    return [...this.buf];
  }
  /** Replace contents (oldest first), keeping the cap. Emits nothing by design. */
  restore(items: T[]): void {
    this.buf = items.slice(-this.cap);
  }
  get size(): number {
    return this.buf.length;
  }
}

export interface StoreEvents {
  swap: (e: SwapEvent) => void;
  swarm: (s: Swarm) => void;
  alert: (a: Alert) => void;
  metrics: (m: LatencyMetrics) => void;
}

export interface LatencyMetrics {
  wsConnected: boolean;
  mode: 'live' | 'simulator';
  rpcLatencyMs: number | null;
  lastBlock: number;
  lastEventAt: number | null;
  /**
   * Scan health. `lastBlock` is the chain HEAD — it advances whether or not we
   * managed to read the logs, so on its own it cannot distinguish "keeping up"
   * from "silently skipping". These four can:
   *
   *   cursor              last block actually scanned
   *   cursorLag           head - cursor (0 = caught up)
   *   consecutiveFailures resets to 0 on any successful scan
   *   lastScanAt          unix ms of the last successful scan
   */
  cursor: number;
  cursorLag: number;
  consecutiveFailures: number;
  lastScanAt: number | null;
  /** Blocks abandoned by a backfill clamp (FEED_MAX_BACKFILL_BLOCKS). Should stay 0. */
  skippedBlocks: number;
}

/**
 * Central in-memory state. Everything the bot needs to detect swarms and serve
 * the dashboard lives here so the hot path never touches the network or disk.
 * Postgres/Redis are optional write-behind sinks layered on top (see store/db).
 */
export class MemoryStore extends EventEmitter {
  readonly tokensByAddress = new Map<string, TrackedToken>();
  readonly tokensBySymbol = new Map<string, TrackedToken>();
  readonly wallets = new Map<string, TrackedWallet>();
  /** Coins (upper-case symbols) whose wallets are currently muted. Runtime-
   *  toggleable via the API; seeded from MUTE_WALLET_TOKENS. */
  readonly mutedTokens = new Set<string>();
  /** Whether tracked-wallet BUYS / SELLS of blue-chip (seed) coins can alert.
   *  Off = suppress whales just rotating money between coins we already track.
   *  Runtime-toggleable via the API; seeded from BLUE_CHIP_BUYS/SELLS. */
  blueChipBuys = config.BLUE_CHIP_BUYS;
  blueChipSells = config.BLUE_CHIP_SELLS;

  private readonly swaps = new Ring<SwapEvent>(2000);
  private readonly swarms = new Ring<Swarm>(500);
  private readonly alerts = new Ring<Alert>(500);
  readonly rules = new Map<string, AlertRule>();

  metrics: LatencyMetrics = {
    wsConnected: false,
    mode: config.chainMode,
    rpcLatencyMs: null,
    lastBlock: 0,
    lastEventAt: null,
    cursor: 0,
    cursorLag: 0,
    consecutiveFailures: 0,
    lastScanAt: null,
    skippedBlocks: 0,
  };

  /** Per-wallet, per-token running counts used by leaderboards. */
  readonly walletStats = new Map<
    string,
    { buys: number; sells: number; usdIn: number; usdOut: number }
  >();
  readonly tokenStats = new Map<
    string,
    { buys: number; sells: number; usdIn: number; usdOut: number; swarms: number }
  >();

  totals = { swaps: 0, swarms: 0, alerts: 0 };

  constructor() {
    super();
    this.setMaxListeners(0);
    for (const t of SEED_TOKENS) {
      this.tokensByAddress.set(t.address, t);
      this.tokensBySymbol.set(t.symbol, t);
    }
    for (const w of SEED_WALLETS) this.wallets.set(w.address, w);
    applyWalletOverrides(this.wallets); // re-apply the operator's manual add/remove/retier on top of the seed
    for (const sym of config.mutedWalletTokens) this.mutedTokens.add(sym.toUpperCase());
  }

  /** Restore Wallet Groups (mute) + Blue Chip filter settings from disk, so
   *  toggles made on the dashboard survive a redeploy instead of resetting to
   *  the MUTE_WALLET_TOKENS/BLUE_CHIP_* env defaults every restart. No-op
   *  unless STORE_SETTINGS_PATH is set (point it at a mounted Railway Volume). */
  async loadSettings(): Promise<void> {
    if (!config.STORE_SETTINGS_PATH) return;
    logger.info({ path: config.STORE_SETTINGS_PATH }, 'store: settings persistence enabled');
    try {
      const raw = await readFile(config.STORE_SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      if (Array.isArray(parsed.mutedTokens)) {
        this.mutedTokens.clear();
        for (const sym of parsed.mutedTokens) this.mutedTokens.add(String(sym).toUpperCase());
      }
      if (typeof parsed.blueChipBuys === 'boolean') this.blueChipBuys = parsed.blueChipBuys;
      if (typeof parsed.blueChipSells === 'boolean') this.blueChipSells = parsed.blueChipSells;
      logger.info(
        { muted: this.mutedTokens.size, blueChipBuys: this.blueChipBuys, blueChipSells: this.blueChipSells },
        'store: restored settings',
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') logger.warn({ err: String(err) }, 'store: could not load settings');
    }
  }

  /** Atomically persist Wallet Groups + Blue Chip settings (temp file + rename).
   *  No-op unless STORE_SETTINGS_PATH is set. */
  async saveSettings(): Promise<void> {
    if (!config.STORE_SETTINGS_PATH) return;
    const path = config.STORE_SETTINGS_PATH;
    const data: PersistedSettings = {
      mutedTokens: [...this.mutedTokens],
      blueChipBuys: this.blueChipBuys,
      blueChipSells: this.blueChipSells,
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, path);
    } catch (err) {
      logger.warn({ err: String(err) }, 'store: could not save settings');
    }
  }

  // ── Feed durability ────────────────────────────────────────────────────────
  // See store/feedState.ts. Only DISCOVERED tokens are exported: the seed set is
  // reconstructed in the constructor on every boot, so persisting it would just
  // grow the snapshot and risk a stale seed shadowing the compiled one.

  /** Discovered (auto-registered) tokens, for the durable snapshot. */
  exportDiscoveredTokens(): TrackedToken[] {
    return [...this.tokensByAddress.values()].filter((t) => t.discovered === true);
  }

  /**
   * Re-register tokens from a snapshot. Existing entries win — a live token has
   * already been enriched this boot, and the snapshot is by definition older.
   * Returns how many were actually added. Emits no 'token' event: this is a
   * restore of things already discovered, not a new discovery.
   */
  importTokens(tokens: TrackedToken[]): number {
    let added = 0;
    for (const t of tokens) {
      const key = t.address.toLowerCase();
      if (this.tokensByAddress.has(key)) continue;
      const token: TrackedToken = { ...t, address: key };
      this.tokensByAddress.set(key, token);
      // Never clobber a symbol the seed set owns — discovered symbols collide.
      if (!this.tokensBySymbol.has(token.symbol)) this.tokensBySymbol.set(token.symbol, token);
      added += 1;
    }
    return added;
  }

  /** Swarm/alert history for the durable snapshot (oldest first). */
  exportHistory(): { swarms: Swarm[]; alerts: Alert[]; swaps: SwapEvent[] } {
    // Swaps capped harder than their ring: 2,000 full events would dominate the
    // snapshot file for a panel that shows a few dozen.
    return { swarms: this.swarms.drain(), alerts: this.alerts.drain(), swaps: this.swaps.drain().slice(-200) };
  }

  /**
   * Restore swarm/alert history for DISPLAY ONLY.
   *
   * Deliberately does not emit 'swarm'/'alert'. Those events are what the SSE
   * stream — and therefore the sniper's FeedSubscriber — consume, so re-emitting
   * a persisted alert on boot would replay old calls as if they were live and
   * could open duplicate positions. Totals are not restored either; they count
   * this process's work and are reported next to `uptimeSeconds`.
   */
  restoreHistory(swarms: Swarm[], alerts: Alert[], swaps: SwapEvent[] = []): void {
    if (swarms.length) this.swarms.restore(swarms);
    if (alerts.length) this.alerts.restore(alerts);
    // Display-only, like the rest of the history: restored swaps do NOT touch
    // totals, walletStats or metrics — they are yesterday's news being kept on
    // screen, not events happening again.
    if (swaps.length) this.swaps.restore(swaps);
  }

  isTracked(wallet: string): boolean {
    return this.wallets.has(wallet.toLowerCase());
  }

  /**
   * A wallet is muted only when EVERY coin it is a tracked top-holder of is in
   * the muted set — so silencing "HMM" drops wallets sourced purely from HMM,
   * but keeps any wallet that also holds another tracked gem.
   */
  isWalletMuted(wallet: string): boolean {
    if (this.mutedTokens.size === 0) return false;
    const w = this.wallets.get(wallet.toLowerCase());
    if (!w || w.holdsTokens.length === 0) return false;
    return w.holdsTokens.every((c) => this.mutedTokens.has(c.toUpperCase()));
  }

  /** A blue chip is a coin from the seed set (a tracked token that wasn't
   *  auto-discovered) — the established coins we already follow. */
  isBlueChip(tokenAddress: string): boolean {
    const t = this.tokensByAddress.get(tokenAddress.toLowerCase());
    return !!t && t.discovered !== true;
  }

  /** True when an alert should be suppressed because it's a blue-chip buy/sell
   *  and that side is toggled off. Buy side = BUY/SOLO/ENTRY, sell side =
   *  SELL/ROTATION. */
  blueChipSuppressed(kind: string, tokenAddress: string): boolean {
    if (!this.isBlueChip(tokenAddress)) return false;
    const buySide = kind === 'BUY' || kind === 'SOLO' || kind === 'ENTRY';
    const sellSide = kind === 'SELL' || kind === 'ROTATION';
    if (buySide && !this.blueChipBuys) return true;
    if (sellSide && !this.blueChipSells) return true;
    return false;
  }

  /**
   * Return the token for `address`, auto-registering a *discovered* token if we
   * have never seen it before. This is what lets the bot surface brand-new
   * coins that tracked wallets buy without them being pre-listed. Symbol/supply
   * are best-effort placeholders that chain metadata can later enrich.
   */
  ensureToken(address: string, symbol?: string): TrackedToken {
    const key = address.toLowerCase();
    const existing = this.tokensByAddress.get(key);
    if (existing) return existing;
    const token: TrackedToken = {
      address: key,
      symbol: symbol || `TKN-${key.slice(2, 6).toUpperCase()}`,
      name: symbol || `Discovered ${key.slice(0, 10)}`,
      // PLACEHOLDER until the on-chain metadata read lands (see chain/metadata.ts).
      // supplyVerified stays false meanwhile, which is what stops the oracle
      // reporting `price * 1e9` as a market cap.
      totalSupply: 1_000_000_000,
      supplyVerified: false,
      stable: false,
      discovered: true,
      firstSeen: Date.now(),
    };
    this.tokensByAddress.set(key, token);
    this.tokensBySymbol.set(token.symbol, token);
    this.emit('token', token);
    return token;
  }

  /** Patch a discovered token's metadata once real values are known. */
  updateTokenMeta(address: string, meta: Partial<TrackedToken>): void {
    const key = address.toLowerCase();
    const token = this.tokensByAddress.get(key);
    if (!token) return;
    const oldSymbol = token.symbol;
    Object.assign(token, meta);
    if (meta.symbol && meta.symbol !== oldSymbol) {
      this.tokensBySymbol.delete(oldSymbol);
      this.tokensBySymbol.set(token.symbol, token);
    }
  }

  recordSwap(e: SwapEvent): void {
    this.swaps.push(e);
    this.totals.swaps += 1;
    this.metricStamps.set('swaps', Date.now());
    this.metrics.lastEventAt = e.timestamp;
    this.metrics.lastBlock = Math.max(this.metrics.lastBlock, e.blockNumber);

    const ws = this.walletStats.get(e.wallet) ?? {
      buys: 0,
      sells: 0,
      usdIn: 0,
      usdOut: 0,
    };
    const ts = this.tokenStats.get(e.token) ?? {
      buys: 0,
      sells: 0,
      usdIn: 0,
      usdOut: 0,
      swarms: 0,
    };
    // Counts include every swap; the USD totals only the ones we could price,
    // so an unpriced token adds nothing rather than adding a made-up figure.
    const usd = e.usdValue ?? 0;
    if (e.direction === 'BUY') {
      ws.buys += 1;
      ws.usdIn += usd;
      ts.buys += 1;
      ts.usdIn += usd;
    } else {
      ws.sells += 1;
      ws.usdOut += usd;
      ts.sells += 1;
      ts.usdOut += usd;
    }
    this.walletStats.set(e.wallet, ws);
    this.tokenStats.set(e.token, ts);
    // Bound per-token stats on a long-running process (many discovered tokens).
    while (this.tokenStats.size > 10_000) {
      const oldest = this.tokenStats.keys().next().value;
      if (oldest === undefined) break;
      this.tokenStats.delete(oldest);
    }
    this.emit('swap', e);
  }

  recordSwarm(s: Swarm): void {
    this.swarms.push(s);
    this.totals.swarms += 1;
    this.metricStamps.set('swarms', Date.now());
    const ts = this.tokenStats.get(s.token);
    if (ts) ts.swarms += 1;
    this.emit('swarm', s);
  }

  recordAlert(a: Alert): void {
    this.alerts.push(a);
    this.totals.alerts += 1;
    this.metricStamps.set('alerts', Date.now());
    this.emit('alert', a);
  }

  /**
   * When each metric was last actually written, keyed by field name.
   *
   * Exists because the dashboard renders values with no freshness: after a
   * restart, `lastBlock: 0` and `rpcLatencyMs: null` rendered as "block – /
   * rpc –ms" and were indistinguishable from a dead listener. A metric's age is
   * the difference between "just booted" and "broken", and without a stamp
   * nobody can compute it.
   */
  private readonly metricStamps = new Map<string, number>();

  updateMetrics(patch: Partial<LatencyMetrics>): void {
    const now = Date.now();
    for (const key of Object.keys(patch)) this.metricStamps.set(key, now);
    this.metrics = { ...this.metrics, ...patch };
    this.emit('metrics', this.metrics);
  }

  /** ms since a metric was last written, or null if never this boot. */
  metricAgeMs(key: string): number | null {
    const at = this.metricStamps.get(key);
    return at == null ? null : Date.now() - at;
  }

  recentSwaps(limit = 100): SwapEvent[] {
    return this.swaps.recent(limit);
  }
  recentSwarms(limit = 100): Swarm[] {
    return this.swarms.recent(limit);
  }
  recentAlerts(limit = 100): Alert[] {
    return this.alerts.recent(limit);
  }
}

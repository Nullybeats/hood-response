import WebSocket from 'ws';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { MemoryStore } from '../store/memory.js';
import type { SwapEvent, TrackedWallet } from '../types.js';
import { PriceOracle } from './price.js';
import {
  TRANSFER_TOPIC,
  addressToTopic,
  decodeTransfer,
  directionFor,
  toHuman,
  type EthLog,
} from './decoder.js';
import { fetchTokenMetadata } from './metadata.js';
import { receiptConfirmsSwap, receiptDiagnostic } from './receipt.js';
import { LiveTradeVerifier, logLiveTradeShadow, type V4PoolMembershipResolver } from './liveTradeVerifier.js';
import { logHttpFailure, logRpcError, logRpcThrow, rpcHost } from './rpcLog.js';
import { schedulerFor } from '../attrib/scheduler.js';

export type SwapHandler = (e: SwapEvent) => void;

// Shared by both WS and polling listeners. The verifier memoizes immutable
// receipt/transaction context by hash, so one multi-log transaction never pays
// for the same proof repeatedly.
/**
 * Bounded retry queue for a discovery race: a token Transfer can land before a
 * flaky RPC answers decimals().  The old path returned null and the polling
 * cursor advanced, making that fresh token permanently invisible until it
 * traded again.  Retain the immutable log and retry metadata with backoff.
 *
 * This is intentionally bounded. A hostile stream of malformed contracts must
 * not turn a best-effort enrichment feature into unbounded process memory.
 */
class MetadataRetryQueue {
  private readonly pending = new Map<string, { token: string; log: EthLog; attempts: number; timer: NodeJS.Timeout | null }>();
  private stopped = false;

  constructor(
    private readonly store: MemoryStore,
    private readonly onReady: (log: EthLog) => Promise<void>,
  ) {}

  enqueue(token: string, log: EthLog): void {
    if (this.stopped) return;
    const key = `${log.transactionHash ?? ''}:${log.logIndex ?? ''}:${token}`;
    if (this.pending.has(key)) return;
    if (this.pending.size >= 512) {
      logger.warn({ queued: this.pending.size, token }, 'metadata retry queue full; candidate remains suppressed');
      return;
    }
    const item = { token, log, attempts: 0, timer: null as NodeJS.Timeout | null };
    this.pending.set(key, item);
    this.schedule(key, item, 1_000);
  }

  restore(logs: EthLog[]): void {
    for (const log of logs.slice(0, 512)) {
      const transfer = decodeTransfer(log);
      if (transfer) this.enqueue(transfer.token, log);
    }
  }

  snapshot(): EthLog[] {
    return [...this.pending.values()].map((item) => item.log);
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    for (const item of this.pending.values()) if (item.timer) clearTimeout(item.timer);
    this.pending.clear();
  }

  private schedule(key: string, item: { token: string; log: EthLog; attempts: number; timer: NodeJS.Timeout | null }, delay: number): void {
    item.timer = setTimeout(() => void this.retry(key, item), delay);
    item.timer.unref();
  }

  private async retry(key: string, item: { token: string; log: EthLog; attempts: number; timer: NodeJS.Timeout | null }): Promise<void> {
    if (this.stopped || this.pending.get(key) !== item) return;
    const meta = await fetchTokenMetadata(config.CHAIN_HTTP_URL, item.token, 'normal').catch(() => null);
    if (meta?.decimals != null) {
      this.pending.delete(key);
      this.store.updateTokenMeta(item.token, meta);
      await this.onReady(item.log).catch((err) =>
        logger.warn({ err: String(err), tx: item.log.transactionHash }, 'metadata retry: candidate reprocess failed'),
      );
      return;
    }
    item.attempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(item.attempts, 6));
    this.schedule(key, item, delay);
  }
}

export interface ChainListener {
  start(): void;
  stop(): void;
  /** Resume scanning from a persisted cursor. Only the polling listener
   *  implements durability; the simulator and WS variants ignore it. */
  resumeAt?(cursor: number): void;
  /** Last block fully scanned, for the durable snapshot. */
  readonly cursor?: number;
  /** Bounded metadata candidates that must survive cursor advancement. */
  pendingMetadata?(): EthLog[];
  restorePendingMetadata?(logs: EthLog[]): void;
}

/**
 * Decode a Transfer log into a swap for a tracked wallet, shared by the WS and
 * HTTP listeners. Registers brand-new tokens in discovery mode (invoking
 * `onNewToken`); returns null for anything not involving a tracked wallet.
 */
async function buildSwapFromLog(
  store: MemoryStore,
  price: PriceOracle,
  log: EthLog,
  liveTradeVerifier: LiveTradeVerifier,
  onNewToken?: (addr: string) => void,
  onMetadataPending?: (token: string, log: EthLog) => void,
): Promise<SwapEvent | null> {
  const transfer = decodeTransfer(log);
  if (!transfer) return null;
  const match = directionFor(transfer, (a) => store.isTracked(a));
  if (!match) return null;

  let token = store.tokensByAddress.get(transfer.token);
  if (!token) {
    if (!config.DISCOVERY_MODE) return null;
    token = store.ensureToken(transfer.token);
    onNewToken?.(transfer.token);
  }

  const strictMode = config.LIVE_VERIFIED_TRADE_SHADOW || config.LIVE_VERIFIED_TRADE_GATE;
  // Carried onto the SwapEvent rather than discarded: the strict verdict is the
  // only sound input for the v2 pipeline, and recomputing it downstream would
  // mean a second RPC round-trip for an answer already established here.
  let verifiedTrade: boolean | undefined;
  let verifiedCategory: string | undefined;
  let isDistribution = false;
  if (strictMode) {
    const verdict = await liveTradeVerifier.verify(log, transfer, match.wallet, match.direction);
    if (config.LIVE_VERIFIED_TRADE_SHADOW) logLiveTradeShadow(transfer.txHash, verdict);
    verifiedTrade = verdict.confirmed;
    verifiedCategory = verdict.category;
    // Shadow preserves today's live calls exactly; the gate is a separate,
    // explicit promotion after a reviewed measurement window.
    if (!verdict.legacyCandidate || (config.LIVE_VERIFIED_TRADE_GATE && !verdict.confirmed)) {
      // A succeeded, receipt-exact transfer IN with no swap event is a
      // DISTRIBUTION — an allocation/airdrop/claim. The untouched 47e1 instance
      // proved these are a signal (its best calls were exactly this, verified
      // on-chain: 0 of 14 winning "buy" receipts contained a Swap event), and
      // the receipt check here was silently discarding it. Let the event
      // continue through metadata/pricing so the v2 shadow can classify it
      // honestly; the caller (index.ts) diverts it before any legacy store,
      // aggregator, alert or snipe path sees it.
      isDistribution =
        verdict.receiptOk === true &&
        verdict.exactTransfer === true &&
        !verdict.legacyCandidate &&
        match.direction === 'BUY';
      if (!isDistribution) {
        receiptDiagnostic(log);
        return null;
      }
    }
  } else if (!(await receiptConfirmsSwap(log, transfer))) {
    receiptDiagnostic(log);
    return null;
  }
  if (token.decimals == null) {
    const meta = await fetchTokenMetadata(config.CHAIN_HTTP_URL, transfer.token).catch(() => null);
    if (!meta || meta.decimals == null) {
      onMetadataPending?.(transfer.token, log);
      return null;
    }
    store.updateTokenMeta(transfer.token, meta);
    token = store.tokensByAddress.get(transfer.token) ?? token;
  }

  const amount = toHuman(transfer.rawValue, token.decimals);
  return {
    txHash: transfer.txHash,
    wallet: match.wallet,
    token: transfer.token,
    tokenSymbol: token.symbol,
    direction: match.direction,
    amount,
    usdValue: price.usdValue(transfer.token, amount),
    blockNumber: transfer.blockNumber || store.metrics.lastBlock,
    logIndex: transfer.logIndex,
    timestamp: Date.now(),
    verifiedTrade,
    verifiedCategory,
    distribution: isDistribution || undefined,
  };
}

/** Best-effort, one-time on-chain metadata enrichment for a discovered token. */
function enrichToken(store: MemoryStore, tokenAddr: string, inflight: Set<string>): void {
  if (!config.CHAIN_HTTP_URL || inflight.has(tokenAddr)) return;
  inflight.add(tokenAddr);
  void fetchTokenMetadata(config.CHAIN_HTTP_URL, tokenAddr, 'background')
    .then((meta) => {
      if (meta) store.updateTokenMeta(tokenAddr, meta);
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(tokenAddr));
}

/**
 * Live listener: subscribes to ERC-20 Transfer logs for the tracked tokens over
 * a JSON-RPC WebSocket, decodes them into BUY/SELL swaps for tracked wallets,
 * and auto-reconnects with exponential backoff. Transfer logs already carry a
 * block number; block-head and latency telemetry are optional because a fast
 * L2's all-head stream is needlessly expensive on a metered WebSocket.
 */
export class LiveChainListener implements ChainListener {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private pingTimer: NodeJS.Timeout | null = null;
  private latencyTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private readonly pendingLatency = new Map<number, number>();
  private readonly enriching = new Set<string>();
  private readonly metadataRetries: MetadataRetryQueue;
  private readonly liveTradeVerifier: LiveTradeVerifier;

  constructor(
    private readonly store: MemoryStore,
    private readonly price: PriceOracle,
    private readonly onSwap: SwapHandler,
    v4PoolContainsToken?: V4PoolMembershipResolver,
  ) {
    this.liveTradeVerifier = new LiveTradeVerifier(v4PoolContainsToken);
    this.metadataRetries = new MetadataRetryQueue(store, (log) => this.handleLog(log).then(() => undefined));
  }

  start(): void {
    this.stopped = false;
    this.metadataRetries.start();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    this.ws?.close();
    this.ws = null;
    this.metadataRetries.stop();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = config.CHAIN_WS_URL;
    // Host only: a WSS endpoint can carry its API key in the path.
    logger.info({ host: rpcHost(url) }, 'connecting to Robinhood Chain RPC');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
      this.store.updateMetrics({ wsConnected: true });
      logger.info('chain websocket connected');
      if (config.DISCOVERY_MODE) {
        // Discovery: watch Transfer logs by tracked WALLET (any token), so
        // brand-new coins the wallets buy are captured. `to`=wallet ⇒ BUY,
        // `from`=wallet ⇒ SELL. Wallet addresses are indexed topics, so the
        // node does the filtering.
        const walletTopics = [...this.store.wallets.keys()].map(addressToTopic);
        this.send('eth_subscribe', [
          'logs',
          { topics: [TRANSFER_TOPIC, null, walletTopics] }, // buys
        ]);
        this.send('eth_subscribe', [
          'logs',
          { topics: [TRANSFER_TOPIC, walletTopics, null] }, // sells
        ]);
        logger.info({ wallets: walletTopics.length }, 'discovery mode: subscribed by wallet');
      } else {
        // Legacy: only the seeded/tracked tokens.
        const addresses = [...this.store.tokensByAddress.keys()];
        this.send('eth_subscribe', ['logs', { address: addresses, topics: [TRANSFER_TOPIC] }]);
      }
      if (config.CHAIN_WS_INCLUDE_HEADS) this.send('eth_subscribe', ['newHeads']);
      if (config.CHAIN_WS_LATENCY_PROBE_MS > 0) this.startLatencyProbe();
    });

    ws.on('message', (data) => this.onMessage(data.toString()));

    ws.on('close', () => {
      this.store.updateMetrics({ wsConnected: false });
      if (this.latencyTimer) clearInterval(this.latencyTimer);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'chain websocket error');
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    logger.warn({ delay }, 'reconnecting to chain RPC');
    setTimeout(() => this.connect(), delay);
  }

  private send(method: string, params: unknown[]): number {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  private startLatencyProbe(): void {
    this.latencyTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const id = this.send('eth_blockNumber', []);
      this.pendingLatency.set(id, Date.now());
    }, config.CHAIN_WS_LATENCY_PROBE_MS);
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Latency probe reply.
    if (msg.id && this.pendingLatency.has(msg.id)) {
      const sent = this.pendingLatency.get(msg.id)!;
      this.pendingLatency.delete(msg.id);
      this.store.updateMetrics({ rpcLatencyMs: Date.now() - sent });
      return;
    }

    if (msg.method !== 'eth_subscription') return;
    const result = msg.params?.result;
    if (!result) return;

    // newHeads carry { number }.
    if (typeof result.number === 'string' && !result.topics) {
      this.store.updateMetrics({ lastBlock: Number(BigInt(result.number)) });
      return;
    }

    void this.handleLog(result as EthLog);
  }

  private async handleLog(log: EthLog): Promise<void> {
    const swap = await buildSwapFromLog(this.store, this.price, log, this.liveTradeVerifier, (a) =>
      enrichToken(this.store, a, this.enriching),
      (token, retryLog) => this.metadataRetries.enqueue(token, retryLog),
    );
    if (swap) this.onSwap(swap);
  }

  pendingMetadata(): EthLog[] { return this.metadataRetries.snapshot(); }
  restorePendingMetadata(logs: EthLog[]): void { this.metadataRetries.restore(logs); }
}

/**
 * Simulator: replays synthetic activity against the seeded wallets so the full
 * pipeline runs with zero external dependencies. Every tick it either emits
 * scattered background swaps or fires a *coordinated* swarm — several wallets
 * hitting the same token inside the alert window — so alerts actually trigger.
 */
export class SimulatorChainListener implements ChainListener {
  private timer: NodeJS.Timeout | null = null;
  private block = 21_000_000;
  private readonly walletList: TrackedWallet[];

  constructor(
    private readonly store: MemoryStore,
    private readonly price: PriceOracle,
    private readonly onSwap: SwapHandler,
  ) {
    this.walletList = [...store.wallets.values()];
  }

  start(): void {
    this.store.updateMetrics({ wsConnected: true, mode: 'simulator' });
    logger.info('simulator listener started (no CHAIN_WS_URL set)');
    this.timer = setInterval(() => this.tick(), config.SIM_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.updateMetrics({ wsConnected: false });
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
  }

  /** Mint a plausible brand-new token (not in the seed set) for discovery demos. */
  private newToken(): { address: string; symbol: string } {
    const names = ['MOONPIG', 'GIGACHAD', 'FLYCOIN', 'RUGME', 'BONKJR', 'HOODRAT', 'PEPE2', 'WAGMI', 'DEGEN', 'SNIPER'];
    const symbol = `${this.pick(names)}${Math.floor(Math.random() * 900 + 100)}`;
    let addr = '0x';
    for (let i = 0; i < 40; i++) addr += Math.floor(Math.random() * 16).toString(16);
    return { address: addr.toLowerCase(), symbol };
  }

  private emitSwap(
    wallet: TrackedWallet,
    token: { address: string; symbol: string },
    direction: 'BUY' | 'SELL',
  ): void {
    const amount = Math.floor(50_000 + Math.random() * 4_000_000);
    this.block += Math.random() < 0.3 ? 1 : 0;
    const swap: SwapEvent = {
      txHash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
      wallet: wallet.address,
      token: token.address,
      tokenSymbol: token.symbol,
      direction,
      amount,
      usdValue: this.price.usdValue(token.address, amount),
      blockNumber: this.block,
      timestamp: Date.now(),
    };
    this.store.updateMetrics({
      lastBlock: this.block,
      rpcLatencyMs: Math.round(20 + Math.random() * 60),
    });
    this.onSwap(swap);
  }

  private tokenBySymbol(symbol: string): { address: string; symbol: string } {
    const t = this.store.tokensBySymbol.get(symbol)!;
    return { address: t.address, symbol: t.symbol };
  }

  private tick(): void {
    if (Math.random() < config.SIM_SWARM_CHANCE) {
      const discovery = config.DISCOVERY_MODE && Math.random() < config.SIM_DISCOVERY_CHANCE;

      let token: { address: string; symbol: string };
      let direction: 'BUY' | 'SELL';
      let pool: TrackedWallet[];

      if (discovery) {
        // Tracked wallets coordinate into a brand-new coin — the early signal.
        token = this.newToken();
        direction = 'BUY';
        pool = this.walletList;
      } else {
        const symbol = this.pick([...this.store.tokensBySymbol.keys()]);
        token = this.tokenBySymbol(symbol);
        direction = Math.random() < 0.65 ? 'BUY' : 'SELL';
        const holders = this.walletList.filter((w) => w.holdsTokens.includes(symbol));
        pool = holders.length >= 3 ? holders : this.walletList;
      }

      const count = 3 + Math.floor(Math.random() * 4);
      const chosen = new Set<TrackedWallet>();
      while (chosen.size < Math.min(count, pool.length)) chosen.add(this.pick(pool));
      // Fire them within a fraction of the alert window so they aggregate.
      let delay = 0;
      for (const w of chosen) {
        setTimeout(() => this.emitSwap(w, token, direction), delay);
        delay += Math.floor(Math.random() * 800);
      }
    } else {
      // Background noise: a single random swap on a seeded token.
      const w = this.pick(this.walletList);
      const symbol = w.holdsTokens.length
        ? this.pick(w.holdsTokens)
        : this.pick([...this.store.tokensBySymbol.keys()]);
      this.emitSwap(w, this.tokenBySymbol(symbol), Math.random() < 0.5 ? 'BUY' : 'SELL');
    }
  }
}

/**
 * HTTP polling listener: works against a plain JSON-RPC HTTP endpoint (no
 * WebSocket needed), such as Robinhood Chain's public RPC. Each tick it reads
 * the chain head and pulls Transfer logs for tracked wallets over the new block
 * range via `eth_getLogs`, decoding them into swaps. This is what makes the bot
 * genuinely live without a paid streaming provider.
 */
export type RpcFn = (method: string, params: unknown[]) => Promise<any>;

export class HttpPollingChainListener implements ChainListener {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Last block FULLY scanned. Advances only when a range is completely processed. */
  private lastBlock = 0;
  private polling = false;
  private walletTopics: string[] = [];
  private pollCount = 0;
  private readonly enriching = new Set<string>();
  private readonly metadataRetries: MetadataRetryQueue;
  private readonly liveTradeVerifier: LiveTradeVerifier;
  private static readonly MAX_RANGE = 5000;
  /** Floor for the adaptive range; below this a shrink cannot help. */
  private static readonly MIN_RANGE = 32;
  /** Heartbeat log cadence in polls (~every 60s at the default interval). */
  private readonly heartbeatEvery = Math.max(1, Math.round(60_000 / config.POLL_INTERVAL_MS));

  // ── Scan health ────────────────────────────────────────────────────────────
  private consecutiveFailures = 0;
  private lastScanAt: number | null = null;
  private skippedBlocks = 0;
  /** Wall-clock until which polling is backed off after a failure. */
  private backoffUntil = 0;
  /**
   * Adaptive range ceiling. A range the RPC cannot serve within the timeout
   * would otherwise retry forever at the same width; halving on failure lets it
   * find a width that works, and doubling on success restores throughput. This
   * is what makes "never skip" terminate instead of stalling.
   */
  private rangeLimit = HttpPollingChainListener.MAX_RANGE;
  /** Seeded from a durable snapshot before start(); null = begin at chain head. */
  private resumeFrom: number | null = null;

  constructor(
    private readonly store: MemoryStore,
    private readonly price: PriceOracle,
    private readonly onSwap: SwapHandler,
    /** Injectable transport, for tests. Defaults to the real JSON-RPC call. */
    private readonly rpcFn?: RpcFn,
    v4PoolContainsToken?: V4PoolMembershipResolver,
  ) {
    this.liveTradeVerifier = new LiveTradeVerifier(v4PoolContainsToken);
    this.metadataRetries = new MetadataRetryQueue(store, (log) => this.handleLog(log).then(() => undefined));
  }

  /** Resume the cursor from a persisted snapshot. Must be called before start(). */
  resumeAt(cursor: number): void {
    if (Number.isFinite(cursor) && cursor > 0) this.resumeFrom = Math.floor(cursor);
  }

  /** Last block fully scanned — what gets persisted. */
  get cursor(): number {
    return this.lastBlock;
  }

  start(): void {
    this.stopped = false;
    this.metadataRetries.start();
    this.walletTopics = [...this.store.wallets.keys()].map(addressToTopic);
    this.store.updateMetrics({ mode: 'live' });
    logger.info({ host: rpcHost(config.CHAIN_HTTP_URL) }, 'HTTP polling listener started');
    void this.init();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.metadataRetries.stop();
    this.store.updateMetrics({ wsConnected: false });
  }

  private async handleLog(log: EthLog): Promise<boolean> {
    const swap = await buildSwapFromLog(this.store, this.price, log, this.liveTradeVerifier, (a) =>
      enrichToken(this.store, a, this.enriching),
      (token, retryLog) => this.metadataRetries.enqueue(token, retryLog),
    );
    if (!swap) return false;
    this.onSwap(swap);
    return true;
  }

  pendingMetadata(): EthLog[] { return this.metadataRetries.snapshot(); }
  restorePendingMetadata(logs: EthLog[]): void { this.metadataRetries.restore(logs); }

  private async init(): Promise<void> {
    const head = await this.blockNumber();
    if (head == null) {
      // No head yet: keep any resumed cursor and let poll() retry. Starting at 0
      // here would make the first successful poll try to scan the entire chain.
      this.lastBlock = this.resumeFrom ?? 0;
      this.store.updateMetrics({ wsConnected: false, cursor: this.lastBlock });
      this.timer = setInterval(() => void this.poll(), config.POLL_INTERVAL_MS);
      return;
    }

    if (this.resumeFrom == null) {
      // Cold start: begin at the head. Nothing before it was ever ours to scan.
      this.lastBlock = head;
      logger.info({ head }, 'listener: cold start at chain head');
    } else if (this.resumeFrom >= head) {
      // Snapshot from the future (chain reset, or a clock/rollback oddity).
      this.lastBlock = head;
      logger.warn(
        { cursor: this.resumeFrom, head },
        'listener: persisted cursor is ahead of head — restarting at head',
      );
    } else {
      const lag = head - this.resumeFrom;
      if (lag > config.FEED_MAX_BACKFILL_BLOCKS) {
        // Bounded catch-up. Scanning days of blocks would pin the poller in the
        // past while live alerts went unseen — so we clamp, and we say so.
        this.lastBlock = head - config.FEED_MAX_BACKFILL_BLOCKS;
        this.skippedBlocks = this.lastBlock - this.resumeFrom;
        logger.warn(
          { cursor: this.resumeFrom, head, lag, skipped: this.skippedBlocks, cap: config.FEED_MAX_BACKFILL_BLOCKS },
          'listener: cursor too far behind — clamping backfill (blocks SKIPPED)',
        );
      } else {
        this.lastBlock = this.resumeFrom;
        logger.info({ cursor: this.resumeFrom, head, lag }, 'listener: resuming from persisted cursor');
      }
    }

    this.store.updateMetrics({
      wsConnected: true,
      lastBlock: head,
      cursor: this.lastBlock,
      cursorLag: Math.max(0, head - this.lastBlock),
      skippedBlocks: this.skippedBlocks,
    });
    this.timer = setInterval(() => void this.poll(), config.POLL_INTERVAL_MS);
  }

  /** Record a successful scan: clears backoff and widens the range again. */
  private markSuccess(head: number): void {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.lastScanAt = Date.now();
    this.rangeLimit = Math.min(HttpPollingChainListener.MAX_RANGE, this.rangeLimit * 2);
    this.store.updateMetrics({
      cursor: this.lastBlock,
      cursorLag: Math.max(0, head - this.lastBlock),
      consecutiveFailures: 0,
      lastScanAt: this.lastScanAt,
    });
  }

  /**
   * Record a failed scan. The cursor is NOT advanced, so the range is retried
   * whole on the next poll. Backoff is bounded and the range is narrowed.
   */
  private markFailure(what: string, from?: number, to?: number): void {
    this.consecutiveFailures += 1;
    const delay = Math.min(
      config.FEED_BACKOFF_MAX_MS,
      config.FEED_BACKOFF_MIN_MS * 2 ** (this.consecutiveFailures - 1),
    );
    this.backoffUntil = Date.now() + delay;
    if (from != null && to != null) {
      this.rangeLimit = Math.max(
        HttpPollingChainListener.MIN_RANGE,
        Math.floor(this.rangeLimit / 2),
      );
    }
    this.store.updateMetrics({
      consecutiveFailures: this.consecutiveFailures,
      cursor: this.lastBlock,
    });
    logger.warn(
      {
        what,
        ...(from != null && to != null ? { retryRange: `${from}-${to}` } : {}),
        consecutiveFailures: this.consecutiveFailures,
        backoffMs: delay,
        nextRangeLimit: this.rangeLimit,
      },
      'scan failed — cursor held, range will be retried',
    );
  }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    if (this.rpcFn) return this.rpcFn(method, params);
    // Range, when this is a log query — so a failure says WHICH blocks were lost.
    const p0 = params[0] as { fromBlock?: string; toBlock?: string } | undefined;
    const range =
      p0?.fromBlock && p0?.toBlock
        ? `${Number(BigInt(p0.fromBlock))}-${Number(BigInt(p0.toBlock))}`
        : undefined;
    const ctx = {
      op: method === 'eth_getLogs' ? 'logs' : 'chain',
      url: config.CHAIN_HTTP_URL,
      method,
      ...(range ? { range } : {}),
    };
    const sched = schedulerFor(config.CHAIN_HTTP_URL);
    try {
      return await sched.run(async () => {
        // Start the request timeout only after admission. Starting it while
        // waiting in the shared queue turns polite back-pressure into a fake
        // transport failure before the request has even reached the node.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(config.CHAIN_HTTP_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: ctrl.signal,
          });
          // A 429 here is the single most consequential failure this service has,
          // and it used to return null with no trace at all.
          if (!res.ok) {
            logHttpFailure(ctx, res.status, res.statusText);
            if (res.status === 429 || res.status === 503) sched.penalise(1_000);
            return null;
          }
          const json = (await res.json()) as { result?: unknown; error?: unknown };
          if (json.error) {
            logRpcError(ctx, json.error);
            return null;
          }
          return json.result ?? null;
        } finally {
          clearTimeout(t);
        }
      }, 'live');
    } catch (err) {
      logRpcThrow(ctx, err);
      return null;
    }
  }

  private async blockNumber(): Promise<number | null> {
    const start = Date.now();
    const r = (await this.rpc('eth_blockNumber', [])) as string | null;
    if (r == null) return null;
    this.store.updateMetrics({ rpcLatencyMs: Date.now() - start });
    return Number(BigInt(r));
  }

  /**
   * One scan tick.
   *
   * The invariant, and the whole point of this method: **the cursor advances
   * only after a range has been fetched AND processed in full.** It used to
   * advance unconditionally, and because a failed `rpc()` returns null which
   * `flatMap` folded into `[]`, an RPC timeout was indistinguishable from "no
   * activity in these blocks". Every timeout permanently skipped its range —
   * measured at 14 of 40 log lines on the Railway feed, 2026-08-05.
   *
   * Nothing is emitted before both log sets are known-good, so a retry of a
   * failed range re-processes it exactly once rather than double-emitting the
   * half that had already succeeded.
   */
  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    if (Date.now() < this.backoffUntil) return;
    this.polling = true;
    try {
      const head = await this.blockNumber();
      if (head == null) {
        this.store.updateMetrics({ wsConnected: false });
        this.markFailure('eth_blockNumber');
        return;
      }
      this.store.updateMetrics({ wsConnected: true, lastBlock: head });
      if (head <= this.lastBlock) {
        // Caught up — a real success, so it clears any prior failure state.
        this.markSuccess(head);
        return;
      }

      const from = this.lastBlock + 1;
      const to = Math.min(head, from + this.rangeLimit - 1);
      const fromHex = '0x' + from.toString(16);
      const toHex = '0x' + to.toString(16);
      const base: Record<string, unknown> = config.DISCOVERY_MODE
        ? {} // any token
        : { address: [...this.store.tokensByAddress.keys()] };

      const [buys, sells] = await Promise.all([
        this.rpc('eth_getLogs', [
          { ...base, fromBlock: fromHex, toBlock: toHex, topics: [TRANSFER_TOPIC, null, this.walletTopics] },
        ]) as Promise<EthLog[] | null>,
        this.rpc('eth_getLogs', [
          { ...base, fromBlock: fromHex, toBlock: toHex, topics: [TRANSFER_TOPIC, this.walletTopics, null] },
        ]) as Promise<EthLog[] | null>,
      ]);

      // ATOMIC GATE. Both sides must be real arrays. A null (timeout, !res.ok,
      // JSON-RPC error) or a non-array body from a proxy means we do not know
      // what happened in these blocks — which is not the same as nothing having
      // happened. Hold the cursor and retry the whole range.
      if (!Array.isArray(buys) || !Array.isArray(sells)) {
        this.markFailure('eth_getLogs', from, to);
        return;
      }

      const seen = new Set<string>();
      let hits = 0;
      const logs = [...(buys as EthLog[]), ...(sells as EthLog[])];
      for (const log of logs) {
        const key = `${log.transactionHash}:${(log as { logIndex?: string }).logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // One malformed log must not abort the range: an exception here would
        // leave the cursor un-advanced with swaps already emitted, so the retry
        // would re-emit them. Skip the bad log, keep the range atomic.
        try {
          if (await this.handleLog(log)) hits += 1;
        } catch (err) {
          logger.warn(
            { err: String(err), tx: log.transactionHash },
            'scan: skipping undecodable log',
          );
        }
      }
      this.lastBlock = to;
      this.markSuccess(head);

      // Visible proof of life: log when a scan finds tracked-wallet activity,
      // and a periodic heartbeat so the logs show it is actively watching.
      this.pollCount += 1;
      if (hits > 0) {
        logger.info({ blocks: `${from}-${to}`, trackedWalletTxs: hits }, 'scan: tracked-wallet activity');
      } else if (this.pollCount % this.heartbeatEvery === 0) {
        logger.info(
          {
            watchingWallets: this.walletTopics.length,
            block: to,
            cursorLag: Math.max(0, head - this.lastBlock),
            totalSwaps: this.store.totals.swaps,
          },
          'heartbeat: watching wallets, no new tracked-wallet buys/sells this window',
        );
      }
    } finally {
      this.polling = false;
    }
  }
}

export function createListener(
  store: MemoryStore,
  price: PriceOracle,
  onSwap: SwapHandler,
  v4PoolContainsToken?: V4PoolMembershipResolver,
): ChainListener {
  if (config.chainMode !== 'live') return new SimulatorChainListener(store, price, onSwap);
  // Prefer a streaming WS endpoint; otherwise poll the HTTP RPC.
  return config.CHAIN_WS_URL
    ? new LiveChainListener(store, price, onSwap, v4PoolContainsToken)
    : new HttpPollingChainListener(store, price, onSwap, undefined, v4PoolContainsToken);
}

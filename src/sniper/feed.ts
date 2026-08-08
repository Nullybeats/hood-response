import { logger } from '../logger.js';
import { config } from '../config/env.js';
import { notifyBotState } from '../notify/state.js';
import type { PriceOracle } from '../chain/price.js';
import type { SniperRegistry } from './registry.js';
import type { Alert, Swarm } from '../types.js';
import type { V2Match } from '../v2/emit.js';
import { selectCatchUp, remember } from './feedCatchUp.js';

/**
 * Carry a v2 match on the same rails as a legacy alert.
 *
 * Everything downstream of the buy gate — price enrichment, the in-flight lock,
 * position bookkeeping, exits — is shared, and duplicating it for v2 would mean
 * two copies of the code that spends money. So the match is widened to the same
 * shape, WITHOUT inventing the fields it does not have:
 *
 *   kind        stays undefined — an allocation is not SOLO/ENTRY/BUY
 *   conviction  stays undefined — `score` is its own field, on its own scale
 *   prime       stays undefined — a v2 lane is not the legacy PRIME tier
 *
 * `isV2Signal` routes it to the lane rules before any of those are consulted, so
 * their absence is a guarantee rather than a gap.
 */
function v2ToSignal(m: V2Match): Swarm {
  return {
    // Identity and timing.
    id: m.id,
    token: m.token,
    tokenSymbol: m.tokenSymbol,
    firstSeen: m.firedAt,
    // v2 discriminator + everything the lane rules read.
    source: 'v2',
    lanes: m.lanes,
    laneReasons: m.laneReasons,
    score: m.score,
    emittedAt: m.emittedAt,
    eventType: m.eventType,
    cohortSize: m.cohortSize,
    seedTier: m.seedTier,
    capBand: m.capBand,
    walletGrade: m.walletGrade,
    marketCap: m.marketCap,
    pairAgeHours: m.pairAgeHours,
    // Crowd shape, stated honestly: v2 knows how many watched wallets touched
    // the token, and deliberately does not publish which.
    walletCount: m.cohortSize,
    walletSummary: m.cohortSize === 1 ? '1 wallet' : `${m.cohortSize} wallets`,
    walletLabels: [],
    walletIds: [m.walletId],
    wallets: [],
    // Price is filled by the local enrichment below; the sniper fails closed
    // without it, which is the behaviour we want either way.
  } as unknown as Swarm;
}

/** How far back a reconnect may replay. Deliberately just wider than the observed ~1.4s gap: this
 *  recovers what we were blind for, never resurrects history. The engine's own 15s freshness gate is
 *  the second, independent bound. */
const CATCHUP_MAX_AGE_MS = 20_000;
/** Alert ids retained for de-duplication. Far more than any catch-up window can surface. */
const SEEN_CAP = 500;

/**
 * FeedSubscriber — makes the swarm feed the single source of truth for the sniper.
 *
 * The sniper must NEVER originate a buy. It may only act on coins the canonical
 * swarm feed (the "swarm the fly" engine that also drives cipherfi's Signals
 * Feed) has called out. This subscribes to that engine's SSE `/events` stream and
 * routes every `alert` into the sniper registry — so "what the operator sees in
 * the feed" is exactly "what the sniper can buy". This box engine's own local
 * alert generation no longer drives buys (that divergence bought PIPEDOG, a coin
 * the feed never surfaced).
 *
 * On start it also pre-seeds the durable first-signal ledger from the feed's
 * recent alert history, so a token the feed already called (even days ago) reads
 * as "not new" and can't slip past the operator's "New coins only" filter — the
 * exact hole that let a stale re-fire through.
 *
 * All buy filtering (kinds, conviction, prime, require-safe, new-coins-only,
 * recoup/trailing/size) stays in the sniper engine, applied downstream. The feed
 * stays fully independent; this only carries its calls to the executor.
 */
export class FeedSubscriber {
  private abort: AbortController | null = null;
  private stopped = false;
  private reconnectMs = 1000;
  /** Last time ANY bytes arrived on the stream (not just alerts) — drives the
   *  staleness watchdog. Most SSE servers heartbeat, so a long silence means a
   *  half-open/dead connection even though no error fired. */
  private lastDataAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private connected = false;
  /** Whether we're currently in a reported-dead state, so recovery fires once. */
  private feedDead = false;
  /** Alert ids already dispatched, so a catch-up replay cannot handle one twice. Bounded. */
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** False until the first successful connect — the first one seeds the ledger instead. */
  private hadConnection = false;

  constructor(
    private readonly registry: SniperRegistry,
    private readonly price: PriceOracle,
    private readonly baseUrl: string,
  ) {}

  start(): void {
    if (!this.baseUrl) {
      logger.warn('sniper feed: SNIPER_FEED_URL is empty — the sniper will receive NO alerts');
      return;
    }
    this.stopped = false;
    void this.seedLedger();
    void this.loop();
    // Watchdog: a silently-dead feed (no bytes past the stale threshold while we
    // believe we're connected) = a dark sniper. Force a reconnect + health alert.
    const staleMs = Math.max(30, config.SNIPER_FEED_STALE_SEC) * 1000;
    this.watchdog = setInterval(() => {
      if (!this.connected || this.lastDataAt === 0) return;
      if (Date.now() - this.lastDataAt > staleMs) {
        logger.warn({ staleSec: config.SNIPER_FEED_STALE_SEC }, 'sniper feed: stale — forcing reconnect');
        if (!this.feedDead) {
          this.feedDead = true;
          notifyBotState('feed-dead', `no feed data for ${config.SNIPER_FEED_STALE_SEC}s — reconnecting (sniper is blind until it recovers)`);
        }
        this.connected = false;
        this.abort?.abort(); // breaks consume(), loop() reconnects with backoff
      }
    }, 60_000);
    logger.info({ url: this.baseUrl }, 'sniper feed: subscribing to swarm feed');
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.abort?.abort();
  }

  /** Mark every token in the feed's recent history as already-seen so only a
   *  genuinely first feed call reads as a new coin. Never fires a buy. */
  private async seedLedger(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/alerts?limit=1000`);
      if (!res.ok) return;
      const body = (await res.json()) as Alert[] | { alerts?: Alert[] };
      const alerts: Alert[] = Array.isArray(body) ? body : body.alerts ?? [];
      let seeded = 0;
      for (const a of alerts) {
        const token = a?.swarm?.token;
        if (token) {
          this.registry.state.claimFirstSignal(token, a.id, a.swarm?.tokenSymbol);
          seeded++;
        }
      }
      logger.info({ seeded }, 'sniper feed: pre-seeded first-signal ledger from feed history');
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper feed: ledger pre-seed failed (continuing)');
    }
  }

  /**
   * Replay alerts that fired while we were reconnecting.
   *
   * Best-effort by design: a failure here must never stop the stream we just re-established. The
   * sniper being live on new alerts matters more than recovering one we may have missed.
   */
  private async catchUp(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/alerts?limit=50`);
      if (!res.ok) return;
      const body = (await res.json()) as Alert[] | { alerts?: Alert[] };
      const alerts: Alert[] = Array.isArray(body) ? body : body.alerts ?? [];
      const missed = selectCatchUp(alerts, this.seen, Date.now(), CATCHUP_MAX_AGE_MS);
      if (missed.length === 0) return;
      logger.warn(
        { count: missed.length, tokens: missed.map((a) => a.swarm?.tokenSymbol ?? a.swarm?.token) },
        'sniper feed: replaying alerts missed during the reconnect gap',
      );
      for (const a of missed) {
        if (a.id) remember(this.seen, this.seenOrder, a.id, SEEN_CAP);
        if (a.swarm?.token) void this.handle(a.swarm);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper feed: catch-up failed (continuing)');
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const res = await fetch(`${this.baseUrl}/events`, {
          headers: { accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`feed /events HTTP ${res.status}`);
        logger.info({ url: this.baseUrl }, 'sniper feed: connected');
        // Reset to an IMMEDIATE first retry, not 1s. Railway kills this stream every 900s no matter
        // what, so the overwhelmingly common "disconnect" is routine and expected — waiting a second
        // before redialling turns a ~350ms handshake gap into ~1.35s of blindness, 96 times a day.
        // Backoff still applies from the second consecutive failure, which is the real-outage case.
        this.reconnectMs = 0;
        this.connected = true;
        this.lastDataAt = Date.now();
        if (this.feedDead) {
          this.feedDead = false;
          notifyBotState('feed-recovered', 'feed reconnected — sniper is live again');
        }
        // A reconnect means we were blind for the gap. Replay anything that fired in it. Skipped on
        // the very first connect, where seedLedger() has already read the same history for a
        // different purpose (marking tokens seen, never buying).
        if (this.hadConnection) await this.catchUp();
        this.hadConnection = true;
        await this.consume(res.body);
      } catch (err) {
        this.connected = false;
        if (this.stopped) return;
        logger.warn(
          { err: String(err instanceof Error ? err.message : err), retryMs: this.reconnectMs },
          'sniper feed: disconnected, reconnecting',
        );
      }
      if (this.stopped) return;
      if (this.reconnectMs > 0) await new Promise((r) => setTimeout(r, this.reconnectMs));
      // 0 → 1s on the first failed retry, then capped exponential backoff.
      this.reconnectMs = this.reconnectMs === 0 ? 1000 : Math.min(this.reconnectMs * 2, 30_000);
    }
  }

  /** Parse the SSE byte stream into events (blank-line separated) and dispatch. */
  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.lastDataAt = Date.now(); // any byte (incl. SSE heartbeat/comment) = alive
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + (buf.slice(idx).match(/^\r?\n\r?\n/)?.[0].length ?? 2));
        this.dispatch(rawEvent);
      }
    }
  }

  private dispatch(rawEvent: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    // Two streams, kept distinct all the way down: `alert` is the legacy engine
    // (kind + conviction), `v2-match` is the v2 brain (lanes + score). They are
    // gated by different rules in the sniper, so conflating them here would
    // apply legacy thresholds to a signal that has none.
    if (dataLines.length === 0) return;
    if (event !== 'alert' && event !== 'v2-match') return;

    if (event === 'v2-match') {
      let match: V2Match;
      try {
        match = JSON.parse(dataLines.join('\n')) as V2Match;
      } catch {
        return;
      }
      if (!match?.token || !Array.isArray(match.lanes) || match.lanes.length === 0) return;
      if (match.id) remember(this.seen, this.seenOrder, match.id, SEEN_CAP);
      void this.handle(v2ToSignal(match));
      return;
    }

    let alert: Alert;
    try {
      alert = JSON.parse(dataLines.join('\n')) as Alert;
    } catch {
      return;
    }
    const swarm = alert?.swarm;
    if (!swarm?.token) return;
    // Record before handling so a catch-up replay right after this can tell it was already seen.
    if (alert.id) remember(this.seen, this.seenOrder, alert.id, SEEN_CAP);
    void this.handle(swarm);
  }

  /** Enrich with LOCAL live price (execution needs a live price + pair), preserving
   *  the feed's own conviction/prime/kind as the source of truth, then hand to the
   *  sniper registry (which claims first-signal and fans out to each operator). */
  private async handle(swarm: Swarm): Promise<void> {
    const receivedAt = Date.now();
    swarm.receivedAt = receivedAt;
    try {
      await this.price.refreshNow(swarm.token);
      swarm.priceLive = this.price.isLive(swarm.token);
      swarm.priceSource = this.price.sourceOf(swarm.token);
      // priceOf() is null when no real source has a price — never overwrite the
      // feed's own price with a placeholder. The entry gate below fails closed
      // on a missing price, which is the behaviour we want either way.
      const p = this.price.priceOf(swarm.token);
      if (p && p > 0) swarm.priceUsd = p;
      swarm.liquidityUsd = this.price.liquidityOf(swarm.token);
      swarm.dexUrl = this.price.dexUrl(swarm.token);
    } catch {
      /* leave feed price as-is — the sniper fails closed on a missing live price */
    }
    swarm.enrichMs = Date.now() - receivedAt; // measured: is the blocking Dexscreener enrich the bottleneck?
    // Entry-latency diagnostic (every alert, not just buys): ageMs = how old the alert already is when
    // the box receives it = Railway detection→emit + SSE hop. If this dominates, the entry latency is
    // upstream (feed-side), not box-side, and the box can only gate staleness — not speed entries up.
    // For a v2 match the meaningful age is since it was EMITTED: v2 waits up to
    // ~3 minutes for facts to land and settles an allocation for 90s, so block
    // age would look catastrophic while the hop was in fact instant.
    const agedFrom = swarm.source === 'v2' ? swarm.emittedAt : swarm.firstSeen;
    const ageMs = agedFrom ? receivedAt - agedFrom : null;
    logger.info(
      {
        token: swarm.tokenSymbol,
        source: swarm.source ?? 'legacy',
        kind: swarm.kind ?? swarm.lanes?.join('+'),
        ageMs,
        enrichMs: swarm.enrichMs,
        conviction: swarm.conviction ?? swarm.score,
      },
      'sniper feed: signal received (entry-latency diag)',
    );
    this.registry.onAlert(swarm);
  }
}

/** Effective feed URL (Railway swarm engine), trailing slash stripped. */
export const SNIPER_FEED_URL = (config.SNIPER_FEED_URL || '').replace(/\/+$/, '');

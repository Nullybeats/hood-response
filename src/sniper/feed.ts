import { logger } from '../logger.js';
import { config } from '../config/env.js';
import type { PriceOracle } from '../chain/price.js';
import type { SniperRegistry } from './registry.js';
import type { Alert, Swarm } from '../types.js';

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
    logger.info({ url: this.baseUrl }, 'sniper feed: subscribing to swarm feed');
  }

  stop(): void {
    this.stopped = true;
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
        this.reconnectMs = 1000;
        await this.consume(res.body);
      } catch (err) {
        if (this.stopped) return;
        logger.warn(
          { err: String(err instanceof Error ? err.message : err), retryMs: this.reconnectMs },
          'sniper feed: disconnected, reconnecting',
        );
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.reconnectMs));
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000); // capped exponential backoff
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
    if (event !== 'alert' || dataLines.length === 0) return; // only rule-passed alerts drive buys
    let alert: Alert;
    try {
      alert = JSON.parse(dataLines.join('\n')) as Alert;
    } catch {
      return;
    }
    const swarm = alert?.swarm;
    if (!swarm?.token) return;
    void this.handle(swarm);
  }

  /** Enrich with LOCAL live price (execution needs a live price + pair), preserving
   *  the feed's own conviction/prime/kind as the source of truth, then hand to the
   *  sniper registry (which claims first-signal and fans out to each operator). */
  private async handle(swarm: Swarm): Promise<void> {
    try {
      await this.price.refreshNow(swarm.token);
      swarm.priceLive = this.price.isLive(swarm.token);
      const p = this.price.priceOf(swarm.token);
      if (p && p > 0) swarm.priceUsd = p;
      swarm.liquidityUsd = this.price.liquidityOf(swarm.token);
      swarm.dexUrl = this.price.dexUrl(swarm.token);
    } catch {
      /* leave feed price as-is — the sniper fails closed on a missing live price */
    }
    this.registry.onAlert(swarm);
  }
}

/** Effective feed URL (Railway swarm engine), trailing slash stripped. */
export const SNIPER_FEED_URL = (config.SNIPER_FEED_URL || '').replace(/\/+$/, '');

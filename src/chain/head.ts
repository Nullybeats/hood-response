/**
 * The chain head, from a free source.
 *
 * The head has to come from somewhere that is NOT the wallet-log stream: that
 * stream only fires when a watched wallet acts, so a quiet stretch froze the
 * number while the chain ran on — measured at 1,000 blocks behind, which read
 * as a stalled feed when the feed was healthy.
 *
 * Three ways to get it, and the cost is why this module exists:
 *
 *   newHeads subscription  ~10 notifications/sec  (0.1s blocks) — metered
 *   eth_blockNumber probe  1 request / interval                 — metered
 *   HyperSync /height      1 request / interval                 — FREE
 *
 * HyperSync is already the off-meter backbone for attribution and smart-money
 * capture here, for exactly this reason: an Alchemy CU runaway once came from
 * leaving a firehose subscribed. A number we refresh every few seconds has no
 * business being billed.
 *
 * `/height` needs no token — the token gates `/query`. That distinction matters:
 * a height reply is NOT evidence the token works, which is how a malformed token
 * once stalled the whole attribution shadow while /height kept answering.
 */

import { logger } from '../logger.js';
import type { MemoryStore } from '../store/memory.js';

export interface HeadPollerOptions {
  /** HyperSync base URL; `/height` is appended. */
  url: string;
  intervalMs: number;
  /** Abandon a probe that hangs, so a stuck request cannot stall the loop. */
  timeoutMs: number;
}

export const DEFAULT_HEAD_POLLER_OPTIONS: HeadPollerOptions = {
  url: 'https://robinhood.hypersync.xyz',
  intervalMs: 3_000,
  timeoutMs: 5_000,
};

/** Read one height. Exported for the test; returns null rather than throwing. */
export async function fetchHeight(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ height: number; latencyMs: number } | null> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/height`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { height?: unknown };
    const height = Number(body?.height);
    if (!Number.isFinite(height) || height <= 0) return null;
    return { height, latencyMs: Date.now() - started };
  } catch {
    // A missed sample is not an incident: the next tick is three seconds away,
    // and the head has never been load-bearing for any trading decision.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keeps `lastBlock` current from a free endpoint, and records how long the
 * lookup took plus which source answered — so the dashboard can say "head is
 * 3s old, from hypersync" rather than showing a bare number of unknown age.
 */
export class HeadPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly store: MemoryStore,
    private readonly opts: HeadPollerOptions = DEFAULT_HEAD_POLLER_OPTIONS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    this.timer.unref?.();
    logger.info({ url: this.opts.url, intervalMs: this.opts.intervalMs }, 'head poller: tracking the chain head (off-meter)');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Public so a test can drive it without a timer. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const r = await fetchHeight(this.opts.url, this.opts.timeoutMs, this.fetchImpl);
      if (!r) {
        this.consecutiveFailures++;
        // Loud only once it is persistent — a single missed sample is noise.
        if (this.consecutiveFailures === 10) {
          logger.warn({ url: this.opts.url }, 'head poller: 10 consecutive failures — head will go stale');
        }
        return;
      }
      this.consecutiveFailures = 0;
      // Never move the head backwards: an indexer a block or two behind the node
      // must not undo a newer block already stamped by a processed log.
      if (r.height > this.store.metrics.lastBlock) {
        this.store.updateMetrics({ lastBlock: r.height });
      }
      this.store.updateMetrics({ headLatencyMs: r.latencyMs, headSource: 'hypersync' });
    } finally {
      this.inFlight = false;
    }
  }

  get failures(): number {
    return this.consecutiveFailures;
  }
}

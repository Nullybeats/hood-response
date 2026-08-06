import { rpcHost } from '../chain/rpcLog.js';

/**
 * ONE token bucket per RPC HOST, shared by every caller.
 *
 * The reason this is global rather than per-feature: a rate limit is a property
 * of the HOST, not of the feature making the call. Receipts, transaction
 * context, pool verification, factory round-trips and retries all land on the
 * same endpoint. Give each its own "polite" limiter and the host still sees the
 * sum, so five well-behaved buckets produce one badly-behaved client — and the
 * 429s that follow are indistinguishable from the ones a single unlimited
 * caller would cause. The only bucket that can honour a limit is the one that
 * sees every request.
 *
 * Hence `scheduleFor(url)` returns a PROCESS-WIDE instance keyed by host. There
 * is deliberately no way to construct a second scheduler for the same host
 * through the public API.
 *
 * The counters exist because a first run has to answer "were we slow because
 * the chain was quiet, or because we were throttling ourselves?" — a question
 * that is unanswerable after the fact unless queue depth and throttle waits are
 * recorded while they happen.
 */

export interface SchedulerStats {
  host: string;
  /** Requests admitted through the bucket. */
  dispatched: number;
  /** Requests currently waiting for a token. */
  queueDepth: number;
  /** High-water mark of `queueDepth` — a mean would hide the burst. */
  peakQueueDepth: number;
  /** Times a caller had to wait for a token at all. */
  throttled: number;
  /** Total milliseconds spent waiting on the bucket. */
  throttleWaitMs: number;
  /** Retries triggered by a 429 or a Retry-After. */
  rateLimitRetries: number;
  /** Currently in a cooldown imposed by a 429. */
  cooling: boolean;
}

export interface SchedulerOptions {
  /** Sustained requests per second. */
  ratePerSec: number;
  /** Burst capacity. Defaults to one second of rate, minimum 1. */
  burst?: number;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

export class RpcScheduler {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly rate: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serialises token acquisition so two callers cannot take the same token. */
  private gate: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;

  private dispatched = 0;
  private queueDepth = 0;
  private peakQueueDepth = 0;
  private throttled = 0;
  private throttleWaitMs = 0;
  private rateLimitRetries = 0;

  constructor(
    readonly host: string,
    opts: SchedulerOptions,
  ) {
    this.rate = Math.max(opts.ratePerSec, 0.001);
    this.capacity = Math.max(opts.burst ?? Math.ceil(this.rate), 1);
    this.tokens = this.capacity;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.last = this.now();
  }

  /**
   * Run `fn` under the bucket.
   *
   * Note that the queue-depth counter is incremented BEFORE the wait and
   * decremented after `fn` settles, so an in-flight request still counts as
   * occupying the host. Counting only the waiting ones would report a depth of
   * zero at exactly the moment the host is most loaded.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    if (this.queueDepth > this.peakQueueDepth) this.peakQueueDepth = this.queueDepth;
    try {
      await this.acquire();
      this.dispatched += 1;
      return await fn();
    } finally {
      this.queueDepth -= 1;
    }
  }

  /** Chain onto the gate so refills and takes never interleave. */
  private acquire(): Promise<void> {
    const next = this.gate.then(() => this.take());
    // Swallow here only; the caller still sees the rejection through `next`.
    this.gate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      const cool = this.cooldownUntil - t;
      if (cool > 0) {
        this.throttled += 1;
        this.throttleWaitMs += cool;
        await this.sleep(cool);
        continue;
      }
      this.refill(t);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(Math.ceil(((1 - this.tokens) / this.rate) * 1000), 1);
      this.throttled += 1;
      this.throttleWaitMs += waitMs;
      await this.sleep(waitMs);
    }
  }

  private refill(t: number): void {
    const elapsed = Math.max(t - this.last, 0);
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
  }

  /**
   * Report a 429 (or an explicit Retry-After).
   *
   * This pauses EVERY caller on the host, not just the one that was rejected.
   * A limiter that only slows the unlucky request keeps the aggregate rate
   * exactly where it was — which is what earned the 429 in the first place.
   */
  penalise(retryAfterMs = 1000): void {
    this.rateLimitRetries += 1;
    const until = this.now() + Math.max(retryAfterMs, 0);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  stats(): SchedulerStats {
    return {
      host: this.host,
      dispatched: this.dispatched,
      queueDepth: this.queueDepth,
      peakQueueDepth: this.peakQueueDepth,
      throttled: this.throttled,
      throttleWaitMs: Math.round(this.throttleWaitMs),
      rateLimitRetries: this.rateLimitRetries,
      cooling: this.cooldownUntil > this.now(),
    };
  }
}

const registry = new Map<string, RpcScheduler>();

/**
 * The process-wide scheduler for a URL's host, created on first use.
 *
 * `rpcHost()` reduces the URL to a hostname, dropping userinfo, path and query
 * — so two URLs differing only by API key share one bucket, which is correct:
 * the host counts them together whether we do or not.
 */
export function schedulerFor(url: string, opts?: Partial<SchedulerOptions>): RpcScheduler {
  const host = rpcHost(url);
  let s = registry.get(host);
  if (!s) {
    s = new RpcScheduler(host, { ratePerSec: opts?.ratePerSec ?? 8, ...opts });
    registry.set(host, s);
  }
  return s;
}

export function allSchedulerStats(): SchedulerStats[] {
  return [...registry.values()].map((s) => s.stats());
}

/** Tests only — the registry is process-wide by design. */
export function resetSchedulers(): void {
  registry.clear();
}

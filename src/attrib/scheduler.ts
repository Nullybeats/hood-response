import { logger } from '../logger.js';
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
  /** Sustained requests per second this bucket is admitting. */
  ratePerSec: number;
  /** Calls dropped at the front of the queue because their deadline had passed. */
  expired: number;
}

/** A queued call whose caller's deadline elapsed before the bucket reached it. */
export class RpcDeadlineExceeded extends Error {
  constructor(host: string, waitedMs: number) {
    super(`rpc scheduler: ${host} deadline exceeded after ${Math.round(waitedMs)}ms in queue`);
    this.name = 'RpcDeadlineExceeded';
  }
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

/**
 * The public RPC is shared by the real-time listener and shadow accounting.
 * The listener protects the live feed; attribution can wait. `normal` is for
 * enrichment that is needed to finish a detected transaction but is not the
 * block scanner itself.
 */
export type SchedulerPriority = 'live' | 'normal' | 'background';

interface QueuedCall {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Wall-clock time after which dispatching this call is pointless. */
  expiresAt: number | null;
  queuedAt: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

export class RpcScheduler {
  private tokens: number;
  private last: number;
  private capacity: number;
  private rate: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * One queue, three lanes. A token is always charged against this one bucket;
   * priority only selects the NEXT request. This is deliberately not separate
   * "live" and "shadow" buckets — the node sees their aggregate rate.
   */
  private readonly queues: Record<SchedulerPriority, QueuedCall[]> = {
    live: [], normal: [], background: [],
  };
  private draining = false;
  private cooldownUntil = 0;

  private dispatched = 0;
  private queueDepth = 0;
  private peakQueueDepth = 0;
  private throttled = 0;
  private throttleWaitMs = 0;
  private rateLimitRetries = 0;
  private expired = 0;

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

  /** The sustained rate this bucket admits. Reported so it is verifiable live
   *  rather than inferred from `dispatched / uptime` after an incident. */
  get ratePerSec(): number {
    return this.rate;
  }

  /**
   * Raise the sustained rate. Only ever upward, and only from an explicit
   * configured request — see `schedulerFor`. Lowering is deliberately not
   * offered: a caller that wants to be gentle should queue less, not slow every
   * other caller on the host down with it.
   */
  raiseRate(ratePerSec: number): void {
    if (!(ratePerSec > this.rate)) return;
    const from = this.rate;
    this.rate = Math.max(ratePerSec, 0.001);
    this.capacity = Math.max(Math.ceil(this.rate), 1);
    logger.info({ host: this.host, from, to: this.rate }, 'rpc scheduler: rate raised by an explicit request');
  }

  /**
   * Run `fn` under the bucket.
   *
   * Note that the queue-depth counter is incremented BEFORE the wait and
   * decremented after `fn` settles, so an in-flight request still counts as
   * occupying the host. Counting only the waiting ones would report a depth of
   * zero at exactly the moment the host is most loaded.
   */
  async run<T>(fn: () => Promise<T>, priority: SchedulerPriority = 'normal', deadlineMs?: number): Promise<T> {
    this.queueDepth += 1;
    if (this.queueDepth > this.peakQueueDepth) this.peakQueueDepth = this.queueDepth;
    const queuedAt = this.now();
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        expiresAt: deadlineMs != null && deadlineMs > 0 ? queuedAt + deadlineMs : null,
        queuedAt,
      });
      void this.drain();
    });
  }

  /**
   * The next call worth dispatching — dropping any whose deadline passed while
   * it waited.
   *
   * Without this the queue compounds instead of recovering. Measured on the
   * feed 2026-08-08: v2 asked for a quote on every distribution, ~2,200 pool
   * reads piled up against a 2/s bucket, and each one was still dispatched
   * ~18 minutes later — long after the 180s gate that wanted it had given up.
   * The bucket spent its entire budget answering dead questions, so the live
   * ones behind them timed out too, and market cap resolved on 0.5% of sheets.
   *
   * A caller that has stopped waiting must stop consuming the host's rate.
   */
  private next(): QueuedCall | undefined {
    for (;;) {
      const job = this.queues.live.shift() ?? this.queues.normal.shift() ?? this.queues.background.shift();
      if (!job) return undefined;
      if (this.dropIfExpired(job)) continue;
      return job;
    }
  }

  /** Reject and account for a job past its deadline. True when it was dropped. */
  private dropIfExpired(job: QueuedCall): boolean {
    const t = this.now();
    if (job.expiresAt == null || t < job.expiresAt) return false;
    this.expired += 1;
    this.queueDepth -= 1;
    job.reject(new RpcDeadlineExceeded(this.host, t - job.queuedAt));
    return true;
  }

  /**
   * Admit requests at the global host rate while selecting live work first.
   * We intentionally do not await a network call before admitting the next
   * token: rate, not response time, is the host's contract. Queue depth stays
   * occupied until the request settles, so the report still shows in-flight
   * work.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const job = this.next();
        if (!job) return;
        await this.take();
        // Waiting for a token is where a queued call spends its life, so the
        // deadline has to be re-checked here — checking only on dequeue admits
        // every doomed call that was merely first in line. The token is handed
        // back: nothing was sent, so nothing was owed to the host.
        if (this.dropIfExpired(job)) {
          this.tokens += 1;
          continue;
        }
        this.dispatched += 1;
        void job.fn().then(job.resolve, job.reject).finally(() => {
          this.queueDepth -= 1;
        });
      }
    } finally {
      this.draining = false;
      // A request may have queued while the drain was completing its last
      // iteration. Start a new drain rather than leaving that request parked.
      if (this.queues.live.length || this.queues.normal.length || this.queues.background.length) {
        void this.drain();
      }
    }
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
      ratePerSec: this.rate,
      expired: this.expired,
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
  if (s) {
    // The bucket is created by whichever subsystem touches the host FIRST, and
    // every later caller's options were silently discarded. That made the rate
    // depend on module import order: `PRICE_RPC_RPS=8` was configured, believed
    // to be in effect, and measured at 2.02/s on the live feed because attrib
    // had registered the same host at the default first. A rate that quietly
    // means something other than what it says is the whole bug class this file
    // was written to prevent, so an explicit higher request now RAISES the
    // shared bucket — and says so.
    if (opts?.ratePerSec != null && opts.ratePerSec > s.ratePerSec) s.raiseRate(opts.ratePerSec);
    return s;
  }
  {
    // The free Robinhood RPC has repeatedly 429ed above this rate. Two requests
    // per second sustains the 4-second live poll (head + two Transfer queries)
    // while leaving sparse capacity for shadow enrichment. A source that proves
    // it can do more may opt in at construction; the safe default must work on
    // the deployed public node.
    s = new RpcScheduler(host, { ratePerSec: opts?.ratePerSec ?? 2, burst: opts?.burst ?? 1, ...opts });
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

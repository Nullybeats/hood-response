import { describe, it, expect, beforeEach } from 'vitest';
import {
  RpcScheduler,
  schedulerFor,
  resetSchedulers,
  allSchedulerStats,
} from '../attrib/scheduler.js';
import { PoolVerifier, type EthCall } from '../attrib/poolVerify.js';
import { V3_FACTORY } from '../chain/uniswap.js';

/** A controllable clock, so rate limiting is tested by arithmetic not by waiting. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('shared RPC scheduler', () => {
  beforeEach(() => resetSchedulers());

  it('is ONE bucket per host, shared across every feature', () => {
    // The whole point: receipts, pool verification and retries must not each
    // get their own "polite" limiter, because the host sees only the sum.
    const a = schedulerFor('https://rpc.example.com/receipts');
    const b = schedulerFor('https://rpc.example.com/verify?key=secret');
    expect(b).toBe(a);
  });

  it('does not conflate distinct hosts', () => {
    expect(schedulerFor('https://a.example.com')).not.toBe(schedulerFor('https://b.example.com'));
  });

  it('throttles the AGGREGATE, not each caller separately', async () => {
    const c = fakeClock();
    const s = new RpcScheduler('h', { ratePerSec: 10, burst: 2, now: c.now, sleep: c.sleep });
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => s.run(async () => void order.push(i))),
    );
    expect(order).toHaveLength(6);
    const st = s.stats();
    expect(st.dispatched).toBe(6);
    // 2 free from the burst, the remaining 4 each waited.
    expect(st.throttled).toBe(4);
    expect(st.throttleWaitMs).toBeGreaterThan(0);
  });

  it('admits live polling before queued background attribution', async () => {
    // Priority is sequencing only: both calls still consume the same host
    // bucket. This makes a slow shadow backfill yield to the live feed rather
    // than creating a second, competing rate limit.
    const s = new RpcScheduler('h', { ratePerSec: 1_000, burst: 1_000 });
    const order: string[] = [];
    const bgA = s.run(async () => { order.push('background-a'); }, 'background');
    const bgB = s.run(async () => { order.push('background-b'); }, 'background');
    const live = s.run(async () => { order.push('live'); }, 'live');
    await Promise.all([bgA, bgB, live]);
    // A request already admitted cannot be cancelled, but the queued live poll
    // jumps ahead of the next queued attribution call.
    expect(order).toEqual(['background-a', 'live', 'background-b']);
  });

  it('a 429 slows EVERY caller on the host, not just the rejected one', async () => {
    const c = fakeClock();
    const s = new RpcScheduler('h', { ratePerSec: 1000, burst: 1000, now: c.now, sleep: c.sleep });
    s.penalise(500);
    expect(s.stats().cooling).toBe(true);
    const start = c.now();
    await s.run(async () => 'ok'); // an UNRELATED caller
    expect(c.now() - start).toBeGreaterThanOrEqual(500);
    expect(s.stats().rateLimitRetries).toBe(1);
  });

  it('records queue depth as a peak, which a mean would hide', async () => {
    const c = fakeClock();
    const s = new RpcScheduler('h', { ratePerSec: 5, burst: 1, now: c.now, sleep: c.sleep });
    await Promise.all(Array.from({ length: 5 }, () => s.run(async () => 1)));
    expect(s.stats().peakQueueDepth).toBe(5);
    expect(s.stats().queueDepth).toBe(0);
  });

  it('decrements queue depth even when the call throws', async () => {
    const s = new RpcScheduler('h', { ratePerSec: 100 });
    await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(s.stats().queueDepth).toBe(0);
  });

  it('one throwing call does not wedge the gate for the next', async () => {
    const s = new RpcScheduler('h', { ratePerSec: 100 });
    await expect(s.run(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(s.run(async () => 'fine')).resolves.toBe('fine');
  });

  it('reports every host for the first-run summary', () => {
    schedulerFor('https://a.example.com');
    schedulerFor('https://b.example.com');
    expect(allSchedulerStats().map((s) => s.host).sort()).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });
});

/**
 * The failure these prevent was measured, not imagined. On 2026-08-08 the live
 * feed queued ~2,200 pool reads against a 2/s bucket; each was dispatched about
 * eighteen minutes later, long after the 180s gate that asked for it had given
 * up. Market cap resolved on 0.5% of fact sheets and the sniper's only working
 * lane could never match.
 */
describe('a queued call that nobody is waiting for any more', () => {
  beforeEach(() => resetSchedulers());

  it('is dropped instead of dispatched once its deadline passes', async () => {
    const c = fakeClock();
    // One request per second, so the second call waits ~1s for a token.
    const s = new RpcScheduler('h', { ratePerSec: 1, burst: 1, now: c.now, sleep: c.sleep });
    const ran: string[] = [];
    const first = s.run(async () => void ran.push('first'));
    const doomed = s.run(async () => void ran.push('doomed'), 'normal', 500);
    await first;
    await expect(doomed).rejects.toThrow(/deadline exceeded/);
    expect(ran).toEqual(['first']);
    expect(s.stats().expired).toBe(1);
    expect(s.stats().dispatched).toBe(1);
  });

  /**
   * The negative control for the fix above: with no deadline the same call is
   * still dispatched after the same wait. If this ever starts failing, the
   * expiry is dropping work it was never asked to drop.
   */
  it('is still dispatched when the caller set no deadline', async () => {
    const c = fakeClock();
    const s = new RpcScheduler('h', { ratePerSec: 1, burst: 1, now: c.now, sleep: c.sleep });
    const ran: string[] = [];
    await Promise.all([
      s.run(async () => void ran.push('first')),
      s.run(async () => void ran.push('patient')),
    ]);
    expect(ran).toEqual(['first', 'patient']);
    expect(s.stats().expired).toBe(0);
  });

  it('does not leak queue depth when it expires', async () => {
    const c = fakeClock();
    const s = new RpcScheduler('h', { ratePerSec: 1, burst: 1, now: c.now, sleep: c.sleep });
    const first = s.run(async () => undefined);
    const doomed = s.run(async () => undefined, 'normal', 1);
    await first;
    await expect(doomed).rejects.toThrow();
    expect(s.stats().queueDepth).toBe(0);
  });
});

describe('the rate a host actually gets', () => {
  beforeEach(() => resetSchedulers());

  /**
   * `PRICE_RPC_RPS=8` was configured, believed to be in effect, and measured at
   * 2.02 rps on the live feed — because attribution had registered the same
   * host at the default first and every later caller's options were discarded.
   * A knob that silently means something else is worse than no knob.
   */
  it('is raised by a later explicit request, not silently discarded', () => {
    const first = schedulerFor('https://rpc.example.com/attrib');
    expect(first.ratePerSec).toBe(2);
    const second = schedulerFor('https://rpc.example.com/price', { ratePerSec: 8 });
    expect(second).toBe(first);
    expect(first.ratePerSec).toBe(8);
  });

  it('is never lowered by a later caller that wants to be gentle', () => {
    const s = schedulerFor('https://rpc.example.com', { ratePerSec: 8 });
    schedulerFor('https://rpc.example.com', { ratePerSec: 1 });
    expect(s.ratePerSec).toBe(8);
  });
});

describe('pool verification is deduplicated and single-flight', () => {
  const POOL = '0x2dc56aa90f90a328e0fad9660bf01115bac2d628';
  const FACTORY = V3_FACTORY.toLowerCase();
  const word = (v: string) => '0x' + v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const numWord = (n: number) => '0x' + n.toString(16).padStart(64, '0');

  /** Counts calls and resolves only when released, so overlap is observable. */
  function countingNode() {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const call: EthCall = async (to, data) => {
      calls += 1;
      await gate;
      const t = to.toLowerCase();
      if (t === POOL) {
        if (data === '0xc45a0155') return { ok: true, result: word(FACTORY) };
        if (data === '0x0dfe1681') return { ok: true, result: word('0xaa') };
        if (data === '0xd21220a7') return { ok: true, result: word('0xbb') };
        if (data === '0xddca3f43') return { ok: true, result: numWord(10000) };
      }
      if (t === FACTORY) return { ok: true, result: word(POOL) };
      return { ok: true, result: '0x' };
    };
    return { call, release, calls: () => calls };
  }

  it('COALESCES concurrent verifications of the same pool into one', async () => {
    // 40 candidate txs touching one hot pool must not issue 40 verification
    // runs (200 RPC calls) — nothing is cached until the first one returns.
    const node = countingNode();
    const v = new PoolVerifier(node.call);
    const all = Promise.all(Array.from({ length: 40 }, () => v.verifyV3(POOL)));
    node.release();
    const results = await all;

    expect(results.every((r) => r.status === 'verified')).toBe(true);
    expect(node.calls()).toBe(5); // one verification, not forty
    const st = v.stats();
    expect(st.coalesced).toBe(39);
    expect(st.cacheMisses).toBe(1);
    expect(st.hitRate).toBeCloseTo(39 / 40, 5);
  });

  it('serves later lookups from cache with zero RPC', async () => {
    const node = countingNode();
    node.release();
    const v = new PoolVerifier(node.call);
    await v.verifyV3(POOL);
    const before = node.calls();
    await v.verifyV3(POOL);
    await v.verifyV3(POOL);
    expect(node.calls()).toBe(before);
    expect(v.stats().cacheHits).toBe(2);
  });

  it('REGRESSION: a failed flight is not cached, so the pool is retried', async () => {
    let n = 0;
    const flaky: EthCall = async () => {
      n += 1;
      return { ok: false, detail: 'http 429' };
    };
    const v = new PoolVerifier(flaky);
    await Promise.all([v.verifyV3(POOL), v.verifyV3(POOL)]);
    const afterFirst = n;
    await v.verifyV3(POOL);
    // Retried rather than concluded — a 429 must never disqualify a pool.
    expect(n).toBeGreaterThan(afterFirst);
    expect(v.stats().uniqueAwaitingVerification).toBe(1);
    expect(v.pendingSet().has(POOL)).toBe(true);
  });
});

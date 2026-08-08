/**
 * The head must stay current without costing anything.
 *
 * It cannot come from the wallet-log stream (that only fires when a watched
 * wallet acts, so a quiet hour froze the number 1,000 blocks behind and read as
 * a dead feed), and it should not come from a metered RPC for a number that
 * drives nothing but the dashboard. HyperSync's /height is free; these tests pin
 * the behaviour that makes relying on it safe.
 */
import { describe, expect, it, vi } from 'vitest';

import { HeadPoller, fetchHeight, DEFAULT_HEAD_POLLER_OPTIONS } from '../chain/head.js';
import { MemoryStore } from '../store/memory.js';

const ok = (height: unknown) =>
  ({ ok: true, json: async () => ({ height }) }) as unknown as Response;

function poller(fetchImpl: typeof fetch) {
  const store = new MemoryStore();
  return {
    store,
    p: new HeadPoller(store, { ...DEFAULT_HEAD_POLLER_OPTIONS, url: 'https://hs.test' }, fetchImpl),
  };
}

describe('HeadPoller', () => {
  it('stamps the head and the latency, naming the source', async () => {
    const { store, p } = poller((async () => ok(30_725_344)) as unknown as typeof fetch);
    await p.tick();
    expect(store.metrics.lastBlock).toBe(30_725_344);
    expect(store.metrics.headSource).toBe('hypersync');
    expect(store.metrics.headLatencyMs).not.toBeNull();
    // Freshness is the half that makes the value readable.
    expect(store.metricAgeMs('lastBlock')).not.toBeNull();
  });

  it('calls /height on the configured host', async () => {
    const spy = vi.fn(async () => ok(1)) as unknown as typeof fetch;
    const { p } = poller(spy);
    await p.tick();
    expect((spy as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe('https://hs.test/height');
  });

  /** An indexer can sit a block or two behind the node we already heard from. */
  it('never moves the head backwards', async () => {
    const { store, p } = poller((async () => ok(100)) as unknown as typeof fetch);
    store.updateMetrics({ lastBlock: 500 });
    await p.tick();
    expect(store.metrics.lastBlock).toBe(500);
  });

  it('survives a failing endpoint and counts the failures', async () => {
    const { store, p } = poller((async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    store.updateMetrics({ lastBlock: 42 });
    await expect(p.tick()).resolves.toBeUndefined();
    expect(store.metrics.lastBlock).toBe(42);
    expect(p.failures).toBe(1);
  });

  it('resets the failure count once the endpoint recovers', async () => {
    let fail = true;
    const { p } = poller((async () => {
      if (fail) throw new Error('down');
      return ok(7);
    }) as unknown as typeof fetch);
    await p.tick();
    expect(p.failures).toBe(1);
    fail = false;
    await p.tick();
    expect(p.failures).toBe(0);
  });

  it('ignores a garbage height rather than zeroing the block', async () => {
    const { store, p } = poller((async () => ok('not-a-height')) as unknown as typeof fetch);
    store.updateMetrics({ lastBlock: 9 });
    await p.tick();
    expect(store.metrics.lastBlock).toBe(9);
  });

  it('does not overlap requests', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const slow = (async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(1);
    }) as unknown as typeof fetch;
    const { p } = poller(slow);
    await Promise.all([p.tick(), p.tick(), p.tick()]);
    expect(maxConcurrent).toBe(1);
  });
});

describe('fetchHeight', () => {
  it('returns null on a non-ok response instead of throwing', async () => {
    const res = await fetchHeight('https://hs.test', 100, (async () =>
      ({ ok: false }) as unknown as Response) as unknown as typeof fetch);
    expect(res).toBeNull();
  });

  it('gives up on a hung request rather than stalling the loop', async () => {
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(fetchHeight('https://hs.test', 20, hang)).resolves.toBeNull();
  });
});

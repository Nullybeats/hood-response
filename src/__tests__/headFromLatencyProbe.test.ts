/**
 * The head must advance even when no watched wallet is doing anything.
 *
 * Before this, `lastBlock` was stamped only from processed wallet logs, so a
 * quiet stretch froze the number on the dashboard while the chain ran on —
 * measured live at 1,000 blocks (~100s) behind the untouched instance, which
 * read as "the feed is stuck" when the feed was fine. The latency probe already
 * asks for the head; these tests pin that its answer is used.
 */
import { describe, expect, it } from 'vitest';

import { LiveChainListener } from '../chain/listener.js';
import { MemoryStore } from '../store/memory.js';
import type { PriceOracle } from '../chain/price.js';

/** Reach into the private probe map and message handler — this is the seam under test. */
interface Probe {
  pendingLatency: Map<number, number>;
  onMessage: (raw: string) => void;
}

function listener(): { store: MemoryStore; probe: Probe } {
  const store = new MemoryStore();
  const l = new LiveChainListener(store, {} as PriceOracle, async () => undefined);
  return { store, probe: l as unknown as Probe };
}

const hex = (n: number) => '0x' + n.toString(16);

describe('chain head from the latency probe', () => {
  it('stamps both the latency and the head from one probe reply', () => {
    const { store, probe } = listener();
    probe.pendingLatency.set(7, Date.now() - 40);
    probe.onMessage(JSON.stringify({ id: 7, result: hex(30_718_755) }));

    expect(store.metrics.lastBlock).toBe(30_718_755);
    expect(store.metrics.rpcLatencyMs).toBeGreaterThanOrEqual(0);
    // Freshness is what makes the number readable; a value with no age cannot
    // tell "just booted" from "broken".
    expect(store.metricAgeMs('lastBlock')).not.toBeNull();
  });

  /**
   * Negative control: with the head ignored (a reply carrying no result), the
   * metric stays where it was — which is exactly the frozen-head symptom.
   */
  it('leaves the head untouched when the reply carries no block', () => {
    const { store, probe } = listener();
    store.updateMetrics({ lastBlock: 100 });
    probe.pendingLatency.set(1, Date.now());
    probe.onMessage(JSON.stringify({ id: 1 }));
    expect(store.metrics.lastBlock).toBe(100);
  });

  /** A late reply must not rewind a newer block already stamped by a real log. */
  it('never moves the head backwards', () => {
    const { store, probe } = listener();
    store.updateMetrics({ lastBlock: 30_718_755 });
    probe.pendingLatency.set(2, Date.now());
    probe.onMessage(JSON.stringify({ id: 2, result: hex(30_717_000) }));
    expect(store.metrics.lastBlock).toBe(30_718_755);
  });

  it('ignores a malformed block without throwing into the socket handler', () => {
    const { store, probe } = listener();
    store.updateMetrics({ lastBlock: 5 });
    probe.pendingLatency.set(3, Date.now());
    expect(() => probe.onMessage(JSON.stringify({ id: 3, result: 'not-a-number' }))).not.toThrow();
    expect(store.metrics.lastBlock).toBe(5);
  });
});

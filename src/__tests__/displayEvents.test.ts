/**
 * Transfers belong on screen, and nowhere else.
 *
 * Allocations are ~90% of watched-wallet activity, so a feed that hides them
 * renders a busy hour as an empty page — the original "the feed is showing
 * nothing" complaint. But they are not trades: 47e1 counted them as buys and
 * its cards read "1 alpha bought @ $101k MC" for tokens that arrived with no
 * swap in the receipt. These tests hold both halves at once.
 */
import { describe, expect, it } from 'vitest';

import { MemoryStore } from '../store/memory.js';
import type { SwapEvent } from '../types.js';

const WALLET = '0xaaaa000000000000000000000000000000000001';
const TOKEN = '0xtoken0000000000000000000000000000000001';

function ev(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    txHash: '0xtx1',
    wallet: WALLET,
    token: TOKEN,
    tokenSymbol: 'WOOF',
    direction: 'BUY',
    amount: 1000,
    usdValue: 5000,
    blockNumber: 30_000_000,
    timestamp: Date.now(),
    ...over,
  };
}

describe('recordDisplayEvent', () => {
  it('puts the event in the feed', () => {
    const store = new MemoryStore();
    store.recordDisplayEvent(ev({ distribution: true }));
    expect(store.recentSwaps(10)).toHaveLength(1);
    expect(store.recentSwaps(10)[0]!.distribution).toBe(true);
  });

  /** The invariant: an allocation must never reach the numbers the aggregator reads. */
  it('never counts as a trade', () => {
    const store = new MemoryStore();
    store.recordDisplayEvent(ev({ distribution: true }));
    expect(store.totals.swaps).toBe(0);
    expect(store.walletStats.get(WALLET)).toBeUndefined();
    expect(store.tokenStats.get(TOKEN)).toBeUndefined();
  });

  /** Negative control: a real swap DOES move all of it, so the test above is meaningful. */
  it('a real swap still counts everywhere', () => {
    const store = new MemoryStore();
    store.recordSwap(ev());
    expect(store.totals.swaps).toBe(1);
    expect(store.walletStats.get(WALLET)?.buys).toBe(1);
    expect(store.tokenStats.get(TOKEN)?.buys).toBe(1);
  });

  it('proves the listener is alive, so an allocation-only hour is not read as an outage', () => {
    const store = new MemoryStore();
    store.recordDisplayEvent(ev({ distribution: true, blockNumber: 30_500_000 }));
    expect(store.metrics.lastBlock).toBe(30_500_000);
    expect(store.metrics.lastEventAt).not.toBeNull();
  });

  it('emits on the live stream so the feed updates without a reload', () => {
    const store = new MemoryStore();
    const seen: SwapEvent[] = [];
    store.on('swap', (e) => seen.push(e));
    store.recordDisplayEvent(ev({ distribution: true }));
    expect(seen).toHaveLength(1);
  });

  it('never rewinds the head', () => {
    const store = new MemoryStore();
    store.updateMetrics({ lastBlock: 30_900_000 });
    store.recordDisplayEvent(ev({ distribution: true, blockNumber: 30_000_000 }));
    expect(store.metrics.lastBlock).toBe(30_900_000);
  });
});

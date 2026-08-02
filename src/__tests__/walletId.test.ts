import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { PriceOracle } from '../chain/price.js';
import { Aggregator } from '../engine/aggregator.js';
import { walletId } from '../walletId.js';
import type { SwapEvent } from '../types.js';

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';

function swap(wallet: string, token: string, ts: number): SwapEvent {
  return {
    txHash: '0x0',
    wallet,
    token,
    tokenSymbol: 'CASHCAT',
    direction: 'BUY',
    amount: 100_000,
    usdValue: 5_000,
    blockNumber: 1,
    timestamp: ts,
  };
}

describe('walletId', () => {
  it('is stable for the same address', () => {
    expect(walletId(ADDR_A)).toBe(walletId(ADDR_A));
  });

  it('is case-insensitive — the same wallet never splits in two', () => {
    expect(walletId(ADDR_A.toUpperCase())).toBe(walletId(ADDR_A));
  });

  it('distinguishes different addresses', () => {
    expect(walletId(ADDR_A)).not.toBe(walletId(ADDR_B));
  });

  it('leaks no part of the address', () => {
    const id = walletId(ADDR_A);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('1111');
    expect(ADDR_A.toLowerCase()).not.toContain(id);
  });
});

describe('Swarm wallet ids', () => {
  it('emits ids index-aligned with labels, and never an address', () => {
    const store = new MemoryStore();
    const price = new PriceOracle([...store.tokensByAddress.values()]);
    const agg = new Aggregator(store, price);
    agg.detectionFloor = 3;
    agg.maxWindowSeconds = 30;
    const token = store.tokensBySymbol.get('CASHCAT')!.address;
    const wallets = [...store.wallets.keys()].slice(0, 3);
    const now = Date.now();

    agg.ingest(swap(wallets[0]!, token, now));
    agg.ingest(swap(wallets[1]!, token, now + 100));
    const detected = agg.ingest(swap(wallets[2]!, token, now + 200));

    expect(detected).toHaveLength(1);
    const s = detected[0]!;
    expect(s.walletIds).toHaveLength(s.walletLabels.length);
    // The id at position i must belong to the wallet whose label is at position i.
    expect(s.walletIds).toEqual(s.wallets.map((a) => walletId(a)));
    // The privacy invariant: no id is an address, and none appears in the address list.
    for (const id of s.walletIds) {
      expect(id).not.toMatch(/^0x/);
      expect(s.wallets).not.toContain(id);
    }
  });
});

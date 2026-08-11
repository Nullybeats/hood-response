import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwapExecutor } from '../sniper/executor.js';
import { config } from '../config/env.js';

/**
 * The display-path balance cache.
 *
 * Every /api/sniper snapshot used to do an uncached eth_getBalance on the executor's METERED RPC.
 * That snapshot is polled by each open dashboard AND once per registered operator every 90s by
 * cipherfi's portfolio poll, so the read count grew with the user table rather than with demand —
 * nobody had to be logged in for it to.
 *
 * What must stay true, and is asserted below:
 *  • the TRADE path never reads the cache — sizing and the gas-reserve gate act on fresh state;
 *  • a failed read is not cached, or one RPC blip pins "unavailable" for the whole TTL;
 *  • a trade drops the cache, so the UI cannot keep showing a pre-trade balance.
 */

/**
 * Executor with the provider/wallet swapped for counters.
 *
 * No need to fake `ready` (it is a getter with no setter): `init()` opens with
 * `if (this.wallet || !this.ready) return`, so a pre-set wallet short-circuits it before `ready`
 * is ever consulted.
 */
function stubbed(balances: number[]): { ex: SwapExecutor; reads: () => number } {
  let i = 0;
  let reads = 0;
  const ex = new SwapExecutor() as unknown as SwapExecutor & {
    wallet: unknown;
    provider: unknown;
  };
  ex.wallet = { address: '0x0000000000000000000000000000000000000001' };
  ex.provider = {
    async getBalance() {
      reads++;
      const next = balances[Math.min(i, balances.length - 1)];
      i++;
      if (next < 0) throw new Error('rpc down');
      return BigInt(Math.round(next * 1e18));
    },
  };
  return { ex: ex as SwapExecutor, reads: () => reads };
}

describe('display-path balance cache', () => {
  const original = config.SNIPER_BALANCE_CACHE_MS;

  beforeEach(() => {
    (config as { SNIPER_BALANCE_CACHE_MS: number }).SNIPER_BALANCE_CACHE_MS = 30_000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    (config as { SNIPER_BALANCE_CACHE_MS: number }).SNIPER_BALANCE_CACHE_MS = original;
  });

  it('serves repeat display reads from one on-chain call', async () => {
    const { ex, reads } = stubbed([1.5]);
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(1.5, 9);
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(1.5, 9);
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(1.5, 9);
    expect(reads(), 'three snapshots, one eth_getBalance').toBe(1);
  });

  it('re-reads once the TTL expires', async () => {
    const { ex, reads } = stubbed([1.5, 2.5]);
    await ex.balanceEthForDisplay();
    vi.advanceTimersByTime(31_000);
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(2.5, 9);
    expect(reads()).toBe(2);
  });

  it('NEVER serves the trade path from cache', async () => {
    const { ex, reads } = stubbed([1.5, 1.5, 1.5]);
    await ex.balanceEthForDisplay(); // warm it
    await ex.balanceEth();
    await ex.balanceEth();
    expect(reads(), 'sizing and the gas-reserve gate must see fresh state').toBe(3);
  });

  it('does not cache a failed read', async () => {
    const { ex, reads } = stubbed([-1, 2]); // first call throws
    expect(await ex.balanceEthForDisplay()).toBeNull();
    // A cached null would render as "balance unavailable" for the full TTL on one blip.
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(2, 9);
    expect(reads()).toBe(2);
  });

  it('drops the cache when a trade moves the balance', async () => {
    const { ex, reads } = stubbed([1.5, 0.9]);
    await ex.balanceEthForDisplay();
    ex.invalidateBalanceCache();
    expect(await ex.balanceEthForDisplay()).toBeCloseTo(0.9, 9);
    expect(reads()).toBe(2);
  });

  it('is fully off at 0, restoring the previous read-every-time behaviour', async () => {
    (config as { SNIPER_BALANCE_CACHE_MS: number }).SNIPER_BALANCE_CACHE_MS = 0;
    const { ex, reads } = stubbed([1.5, 1.5]);
    await ex.balanceEthForDisplay();
    await ex.balanceEthForDisplay();
    expect(reads()).toBe(2);
  });
});

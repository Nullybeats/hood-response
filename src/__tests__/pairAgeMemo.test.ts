import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceOracle } from '../chain/price.js';

const TOKEN = '0xabc0000000000000000000000000000000000a';
const CREATED = 1_700_000_000_000;

/** A DexScreener pair record, optionally carrying `pairCreatedAt`. */
function dexResponse(pairCreatedAt?: number) {
  return {
    ok: true,
    json: async () => ({
      pairs: [
        {
          chainId: 'robinhood',
          dexId: 'uniswap',
          pairAddress: '0xpair',
          baseToken: { address: TOKEN, symbol: 'GEM' },
          priceUsd: '1',
          priceNative: '0.0004',
          marketCap: 100_000,
          liquidity: { usd: 50_000 },
          ...(pairCreatedAt == null ? {} : { pairCreatedAt }),
        },
      ],
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Pair creation is immutable, so it must not live behind the 60s price TTL.
 *
 * The bug this pins: `pairCreatedAt()` read through `fresh()`, so 60s after a
 * quote the token read as "pair age unknown" again — and v2's
 * `pairAgeHoursBelow` ceiling rejects on unknown. Negative control below.
 */
describe('pair age survives the price TTL', () => {
  it('still knows the creation time after the price entry has gone stale', async () => {
    vi.useFakeTimers();
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexResponse(CREATED)));

    await oracle.refreshNow(TOKEN);
    expect(oracle.pairCreatedAt(TOKEN)).toBe(CREATED);

    // Past TTL_MS (60s): the price is rightly stale, the creation time is not.
    vi.advanceTimersByTime(120_000);
    expect(oracle.priceOf(TOKEN)).toBeNull();
    expect(oracle.pairCreatedAt(TOKEN)).toBe(CREATED);
  });

  it('does not let a later record without pairCreatedAt erase a known one', async () => {
    vi.useFakeTimers();
    const oracle = new PriceOracle([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexResponse(CREATED)));
    await oracle.refreshNow(TOKEN);
    expect(oracle.pairCreatedAt(TOKEN)).toBe(CREATED);

    // Past the TTL, so the second record genuinely re-applies rather than being
    // served from cache — without this the erasure path is never exercised.
    vi.advanceTimersByTime(120_000);
    // DexScreener re-indexes and omits the field — coverage differs, the fact does not.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexResponse(undefined)));
    await oracle.refreshNow(TOKEN);
    expect(oracle.priceOf(TOKEN)).not.toBeNull();
    expect(oracle.pairCreatedAt(TOKEN)).toBe(CREATED);
  });

  it('stays unknown when no source has ever supplied a creation time', async () => {
    const oracle = new PriceOracle([]);
    expect(oracle.pairCreatedAt(TOKEN)).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexResponse(undefined)));
    await oracle.refreshNow(TOKEN);
    // Unknown, never assumed — CLAUDE.md rule 7.
    expect(oracle.pairCreatedAt(TOKEN)).toBeNull();
  });
});

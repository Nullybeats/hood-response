import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceOracle } from '../chain/price.js';
import { PoolPriceReader } from '../chain/poolPrice.js';

const TOKEN = '0xabc0000000000000000000000000000000000a';

function dexResponse(marketCap: number) {
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
          marketCap,
          liquidity: { usd: 50_000 },
          pairCreatedAt: Date.now(),
        },
      ],
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PriceOracle ATH tracking', () => {
  it('prioritises a displayed token and exposes its honest interim state', async () => {
    const oracle = new PriceOracle([]);
    expect(oracle.quoteState(TOKEN)).toBe('unavailable');

    oracle.requestRefresh(TOKEN);
    expect(oracle.quoteState(TOKEN)).toBe('pricing');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexResponse(100_000)));
    await oracle.refreshNow(TOKEN);
    expect(oracle.quoteState(TOKEN)).toBe('live');
  });

  it('warms visible tokens immediately without waiting for the broad refresh tick', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi.fn().mockResolvedValue(dexResponse(100_000));
    vi.stubGlobal('fetch', fetchMock);

    await oracle.warmVisible([TOKEN, TOKEN]);

    expect(oracle.quoteState(TOKEN)).toBe('live');
    // A repeated durable swarm does not create repeated price work.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a throttled visible token pending instead of calling it unpriced', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    // A 429 now attempts the canonical-pool fallback immediately. Keep this
    // unit test about retry state, not a real provider call.
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(2_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(TOKEN);

    expect(oracle.quoteState(TOKEN)).toBe('pricing');
  });

  it('prices a confirmed pool immediately when DexScreener throttles', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(2_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue({
      priceEth: 0.001,
      venue: 'v3',
      liquidity: 1n,
      poolAddress: '0x0000000000000000000000000000000000000001',
      pairCreatedAt: 1_700_000_000_000,
    });

    await oracle.refreshNow(TOKEN);

    expect(oracle.priceOf(TOKEN)).toBe(2);
    expect(oracle.sourceOf(TOKEN)).toBe('pool');
    expect(oracle.pairCreatedAt(TOKEN)).toBe(1_700_000_000_000);
  });

  it('accepts the chain-specific token-pairs response shape', async () => {
    const oracle = new PriceOracle([]);
    const body = await dexResponse(123_456).json();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body.pairs }));

    await oracle.refreshNow(TOKEN);

    expect(oracle.priceOf(TOKEN)).toBe(1);
    expect(oracle.marketCap({ address: TOKEN, symbol: 'GEM', name: 'GEM', totalSupply: 1 })).toBe(123_456);
  });

  it('tracks the highest market cap seen and never lowers it on a dip', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(dexResponse(100_000))
      .mockResolvedValueOnce(dexResponse(400_000))
      .mockResolvedValueOnce(dexResponse(150_000));
    vi.stubGlobal('fetch', fetchMock);

    await oracle.refreshNow(TOKEN);
    expect(oracle.athMarketCapOf(TOKEN)).toBe(100_000);

    // Force a re-fetch (refreshNow no-ops while the cached price is fresh).
    (oracle as unknown as { live: Map<string, { fetchedAt: number }> }).live.delete(
      TOKEN.toLowerCase(),
    );
    await oracle.refreshNow(TOKEN);
    expect(oracle.athMarketCapOf(TOKEN)).toBe(400_000);

    (oracle as unknown as { live: Map<string, { fetchedAt: number }> }).live.delete(
      TOKEN.toLowerCase(),
    );
    await oracle.refreshNow(TOKEN);
    // Price dipped but ATH must hold at the prior peak.
    expect(oracle.athMarketCapOf(TOKEN)).toBe(400_000);
    expect(oracle.marketCap({ address: TOKEN, symbol: 'GEM', name: 'GEM', totalSupply: 1 })).toBe(
      150_000,
    );
  });

  it('returns null for a token that has never had a live price', () => {
    const oracle = new PriceOracle([]);
    expect(oracle.athMarketCapOf('0xnope')).toBeNull();
  });
});

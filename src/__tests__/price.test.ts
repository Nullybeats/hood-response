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

/**
 * Batching the indexer is what turns a 12,345-deep queue draining at one token per 15s into
 * something that keeps up. The danger was never the batching — it was TRUSTING it: the multi-token
 * route caps its response at 30 pairs, so a batch can come back truncated and the tokens past the
 * cap would simply stop being priced, silently and forever. That is why this codebase used one
 * request per token.
 *
 * So the contract is not "we asked for 8" but "we know which 8 came back".
 */
describe('PriceOracle batched refresh', () => {
  const A = '0xaaa0000000000000000000000000000000000001';
  const B = '0xbbb0000000000000000000000000000000000002';

  /** A response carrying only SOME of the requested tokens — the truncation case. */
  function partial(addresses: string[]) {
    return {
      ok: true,
      json: async () => ({
        pairs: addresses.map((a) => ({
          chainId: 'robinhood',
          dexId: 'uniswap',
          pairAddress: '0xpair' + a.slice(-2),
          baseToken: { address: a, symbol: 'GEM' },
          priceUsd: '1',
          priceNative: '0.0004',
          marketCap: 100_000,
          liquidity: { usd: 50_000 },
        })),
      }),
    };
  }

  it('prices every token the response covered, in ONE request', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi.fn().mockResolvedValue(partial([A, B]));
    vi.stubGlobal('fetch', fetchMock);

    oracle.requestRefresh(A);
    oracle.requestRefresh(B);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(oracle.priceOf(A)).toBe(1);
    expect(oracle.priceOf(B)).toBe(1);
  });

  /**
   * THE ONE THAT MATTERS. B is requested and omitted from the reply; it must come back on the
   * queue rather than being quietly dropped.
   *
   * NEGATIVE CONTROL: stop re-queueing the uncovered set and this fails, because B leaves the
   * queue on the first tick and nothing ever asks for it again.
   */
  it('re-queues a requested token the response did NOT cover', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(partial([A])));

    oracle.requestRefresh(A);
    oracle.requestRefresh(B);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    // Assert on the PRIORITY queue, and before touching priceOf(B).
    //
    // `quoteState` is true for either queue, and `priceOf` enqueues as a side effect — so the
    // obvious assertion (`quoteState(B) === 'pricing'` after reading its price) passes whether or
    // not the re-queue exists. Verified by deleting the re-queue: this test still went green. It was
    // measuring its own side effect.
    expect((oracle.debug() as { priorityQueue: number }).priorityQueue).toBe(1);
    expect(oracle.priceOf(A)).toBe(1);
    expect(oracle.priceOf(B)).toBeNull();
  });

  /**
   * A throttle is not evidence a token has no price — so on a 429 the batch falls back to the CHAIN,
   * which has no shared quota, exactly as the single-token path always did.
   *
   * This mattered more than it looks. A 429 freezes the whole indexer lane for 60s, so without a
   * fallback a token needed two failed rounds (~2 min) before anything tried the pool, against a gate
   * that gives up at 90s. [verified 2026-08-09] ROB was dropped as "marketCap still unresolved after
   * 30 attempts" while sitting on DexScreener at a $157k cap with $38k of liquidity.
   */
  it('prices from the CHAIN when the batch is throttled', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue({
      priceEth: 0.001, venue: 'v4', liquidity: 1n,
      poolAddress: '0x0000000000000000000000000000000000000001', pairCreatedAt: 1_700_000_000_000,
    });

    oracle.requestRefresh(A);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    expect(oracle.priceOf(A)).toBe(3);
    expect(oracle.sourceOf(A)).toBe('pool');
    expect((oracle.debug() as { dex429Count: number }).dex429Count).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  /** And when the chain cannot answer either, the token is re-queued rather than written off. */
  it('re-queues a throttled token the chain could not price either', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    oracle.requestRefresh(A);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    expect(oracle.priceOf(A)).toBeNull();
    expect((oracle.debug() as { priorityQueue: number }).priorityQueue).toBe(1);
    vi.restoreAllMocks();
  });
});

/**
 * A market cap is only as true as its price, and the $25k floor is the one threshold everything in
 * this system leans on.
 *
 * [verified 2026-08-09] Eight ledger records took pool-derived prices 21x-334x BELOW the truth, on
 * pairs two to three weeks old carrying $26k-$56k of liquidity, and produced outcomes reading up to
 * +33,682% that were pure mispricing. The error ran low there, so the floor rejected them — the safe
 * direction. Inverted, it is the ANOA incident this repo already paid for: a fabricated cap sailing
 * through the one floor whose only job was to stop it.
 */
describe('PriceOracle pool/indexer disagreement', () => {
  const T = '0xccc0000000000000000000000000000000000003';

  const dexAt = (priceUsd: string) => ({
    ok: true,
    json: async () => ({
      pairs: [{
        chainId: 'robinhood', dexId: 'uniswap', pairAddress: '0xp',
        baseToken: { address: T, symbol: 'REAL' },
        priceUsd, priceNative: '0.0004', marketCap: 100_000, liquidity: { usd: 50_000 },
      }],
    }),
  });

  it('keeps the indexer price when a pool read disagrees wildly', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexAt('1')));
    await oracle.refreshNow(T);
    expect(oracle.priceOf(T)).toBe(1);

    // A pool that would price it 300x lower — the observed failure shape.
    const pools = { enabled: true, priceEthOf: async () => ({ priceEth: 1e-9, venue: 'v4' }) };
    Object.defineProperty(oracle, 'pools', { value: pools, configurable: true });
    Object.defineProperty(oracle, 'ensureEthUsd', { value: async () => 3_000, configurable: true });
    await (oracle as unknown as { fetchFromPool: (a: string) => Promise<void> }).fetchFromPool(T);

    // Unchanged, and the disagreement is counted rather than swallowed.
    expect(oracle.priceOf(T)).toBe(1);
    expect((oracle.debug() as { poolDisagreements: number }).poolDisagreements).toBe(1);
  });

  /** The guard must not fire on ordinary movement, or it becomes a second outage. */
  it('accepts a pool read that merely moved, rather than disagreeing', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dexAt('1')));
    await oracle.refreshNow(T);

    // 3x — a real memecoin minute, well inside the band.
    const pools = { enabled: true, priceEthOf: async () => ({ priceEth: 0.001, venue: 'v4' }) };
    Object.defineProperty(oracle, 'pools', { value: pools, configurable: true });
    Object.defineProperty(oracle, 'ensureEthUsd', { value: async () => 3_000, configurable: true });
    await (oracle as unknown as { fetchFromPool: (a: string) => Promise<void> }).fetchFromPool(T);

    expect(oracle.priceOf(T)).toBe(3);
    expect((oracle.debug() as { poolDisagreements: number }).poolDisagreements).toBe(0);
  });
});

/**
 * The rate-limit spiral, pinned.
 *
 * [verified 2026-08-09, probing from inside the Railway container] DexScreener's public endpoint
 * refuses this egress IP and, critically, a request made WHILE the penalty is running RESETS it to a
 * fresh ~60s. Ten probes 20s apart returned 0 successes, with Retry-After counting 55 -> 35 -> 15 and
 * then jumping back to 57 exactly when it would have expired. The same probe from the box IP returned
 * 10/10 200s and never sent the header at all.
 *
 * The old code paced from a flat 60s constant measured from when WE saw the 429 and ignored the header
 * entirely, so it re-poked the window just before it opened, forever: dex429Count climbed ~1/min from
 * boot and successful responses were approximately zero. These tests exist so that never returns.
 */
describe('PriceOracle DexScreener rate-limit discipline', () => {
  const R = '0xddd0000000000000000000000000000000000004';
  const S = '0xeee0000000000000000000000000000000000005';
  const T2 = '0xfff0000000000000000000000000000000000006';
  const U = '0x1110000000000000000000000000000000000007';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const limited = (retryAfter: string | null) => ({
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => ({}),
  });

  it('honours Retry-After instead of its own constant', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited('30')));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(R);

    const d = oracle.debug() as { dexPenaltyMsRemaining: number };
    // 30s from the header (+ grace), NOT the 60s fallback constant.
    expect(d.dexPenaltyMsRemaining).toBeGreaterThan(25_000);
    expect(d.dexPenaltyMsRemaining).toBeLessThan(40_000);
  });

  it('sends NOTHING while the penalty window is still shut', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi.fn().mockResolvedValue(limited('60'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(R);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Every subsequent caller, by every path, must be refused locally rather than on the wire.
    await oracle.refreshNow(S);
    oracle.requestRefresh(S);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((oracle.debug() as { dexSkippedRateLimited: number }).dexSkippedRateLimited).toBeGreaterThan(0);
  });

  it('resumes once the window reopens', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi.fn().mockResolvedValue(limited('1'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(R);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Negative control for the test above: the hold is time-based, not a permanent latch. Without
    // this, a bug that never cleared dexPenaltyUntil would still pass "sends NOTHING while shut".
    await new Promise((r) => setTimeout(r, 3_200));
    await oracle.refreshNow(S);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a throttled token still reads as pricing, and never at the head of the lane', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited('60')));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(R);

    // 'unavailable' would tell the UI and the ledger the coin has no price; it means we were refused.
    expect(oracle.quoteState(R)).toBe('pricing');
    // ...but it must sit in the BACKGROUND queue. At priority it cycled at the head forever, retried
    // into a shut window while newly-seen tokens waited behind it.
    const d = oracle.debug() as { priorityQueue: number; backgroundQueue: number };
    expect(d.priorityQueue).toBe(0);
    expect(d.backgroundQueue).toBe(1);
  });

  it('a bad Retry-After cannot wedge the lane or open it early', async () => {
    for (const [header, lo, hi] of [
      ['0', 55_000, 65_000],        // 0 means "no useful answer", not "send now"
      ['-5', 55_000, 65_000],       // negative likewise falls back
      ['99999', 115_000, 125_000],  // clamped to the 120s ceiling
      [null, 55_000, 65_000],       // absent falls back to the constant
    ] as [string | null, number, number][]) {
      const oracle = new PriceOracle([]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited(header)));
      vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
      vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

      await oracle.refreshNow(R);

      const ms = (oracle.debug() as { dexPenaltyMsRemaining: number }).dexPenaltyMsRemaining;
      expect(ms, `retry-after=${header}`).toBeGreaterThan(lo);
      expect(ms, `retry-after=${header}`).toBeLessThan(hi);
      vi.restoreAllMocks();
    }
  });

  it('a refusal buys at most one metered pool read, and the counters attribute it', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited('60')));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    const pool = vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    // A full batch of speculative tokens, all refused in one request.
    for (const a of [R, S, T2, U]) oracle.requestRefresh(a);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    // It was 4. With the window permanently shut the "fallback" became the primary path, and 3
    // batches a tick x 4 tokens x ~12 RPC calls each is how a refused indexer turned into ~213k
    // metered Alchemy calls a day.
    expect(pool.mock.calls.length).toBeLessThanOrEqual(1);
    const d = oracle.debug() as { poolFallbackFromThrottle: number; dexRequests: number; dexOk: number };
    expect(d.poolFallbackFromThrottle).toBeLessThanOrEqual(1);
    // The denominator that made this diagnosable at all.
    expect(d.dexRequests).toBe(1);
    expect(d.dexOk).toBe(0);
  });

  it('keeps pricing priority tokens from the chain while the indexer is shut', async () => {
    const oracle = new PriceOracle([]);
    const fetchMock = vi.fn().mockResolvedValue(limited('60'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue({
      priceEth: 0.001, venue: 'v4', liquidity: 1n,
      poolAddress: '0x0000000000000000000000000000000000000001', pairCreatedAt: 1_700_000_000_000,
    });

    // Shut the window.
    await oracle.refreshNow(U);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // On the feed's egress IP the window is shut essentially all the time, so a sweep that merely
    // waits for the indexer means a displayed row is NEVER priced. It must still reach the chain.
    oracle.requestRefresh(R);
    await (oracle as unknown as { refresh: () => Promise<void> }).refresh();

    expect(oracle.priceOf(R)).toBe(3);
    expect(oracle.sourceOf(R)).toBe('pool');
    // ...without touching the indexer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not spend metered reads on the speculative backlog while shut', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited('60')));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    const pool = vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(U);
    const before = pool.mock.calls.length;

    // Background queue only — nobody is deciding on these. The chain is not free.
    const self = oracle as unknown as { queue: Set<string>; refresh: () => Promise<void> };
    for (const a of [R, S, T2]) self.queue.add(a);
    await self.refresh();

    expect(pool.mock.calls.length).toBe(before);
  });

  it('only a LIVE caller buys a metered read while the indexer is shut', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limited('60')));
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    const pool = vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    await oracle.refreshNow(U); // shuts the window
    const base = pool.mock.calls.length;

    // Bulk/display callers — the outcome ledger sampling ~100 records a tick, snapshot() fanning out
    // over every open position, the performance tracker. [measured 2026-08-09] giving each of these a
    // pool read took metered RPC from ~148/min to ~449/min within two minutes of deploy.
    await oracle.refreshNow(R);
    await oracle.refreshNow(S);
    await oracle.refreshNow(T2);
    expect(pool.mock.calls.length).toBe(base);
    // ...but they must not read as 'unavailable' either. Queued, so the sweep picks them up.
    expect(oracle.quoteState(R)).toBe('pricing');

    // A decision in flight does get one.
    await oracle.refreshNow(R, { live: true });
    expect(pool.mock.calls.length).toBe(base + 1);
  });

  it('does not start a second sweep while one is still in flight', async () => {
    const oracle = new PriceOracle([]);
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((r) => { release = r; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await gate;
      return limited('60');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(PoolPriceReader.prototype, 'ethUsdFromUsdG').mockResolvedValue(3_000);
    vi.spyOn(PoolPriceReader.prototype, 'priceEthOf').mockResolvedValue(null);

    oracle.requestRefresh(R);
    const refresh = () => (oracle as unknown as { refresh: () => Promise<void> }).refresh();
    const first = refresh();
    const second = refresh();
    const third = refresh();

    release(undefined);
    await Promise.all([first, second, third]);

    // Overlapping passes each appended a request to the serialized lane AND pulled tokens out of both
    // queues into a local array, so those tokens appeared in NEITHER queue and quoteState() called
    // them 'unavailable' while we were in fact holding them.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

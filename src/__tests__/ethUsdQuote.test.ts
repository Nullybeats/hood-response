import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceOracle } from '../chain/price.js';
import { config } from '../config/env.js';

/**
 * The ETH/USD rate must come from an ETH-quoted pair.
 *
 * Failure this pins, from live data [verified 2026-08-04]: recovering the implied rate from 24
 * closed positions (exitPriceUsd x tokensReceived / exitValueEth) found 13 at ~$1900 but 8 at
 * ~$1.00, two at ~$113, one at ~$22 and one at ~$0.0089. `ethUsdPrice()` took whichever live pair
 * was fetched most recently and divided priceUsd by priceNative — which is the QUOTE token's USD
 * rate, so a stablecoin-quoted pair set the process-wide ETH price to ~$1 and every position that
 * closed in that window recorded a fill price ~1900x wrong.
 */

const WETH = config.SNIPER_WETH.toLowerCase();
const USDC = '0x1111111111111111111111111111111111111111';
const MEME = '0x2222222222222222222222222222222222222222';

type LiveMap = Map<string, Record<string, unknown>>;
/** Seed the live cache directly — this is about how the rate is DERIVED, not about fetching. */
function seed(oracle: PriceOracle, rows: { token: string; quote: string; usd: number; native: number; ageMs?: number }[]) {
  const live = (oracle as unknown as { live: LiveMap }).live;
  for (const r of rows) {
    live.set(r.token, {
      source: 'dexscreener',
      priceUsd: r.usd,
      priceNative: r.native,
      quoteToken: r.quote,
      marketCap: null,
      liquidityUsd: null,
      pairCreatedAt: null,
      volume24: null,
      priceChangeH1: null,
      priceChangeH24: null,
      buys24: null,
      sells24: null,
      dexId: 'uniswap',
      pairAddress: '0xpair',
      chainId: 'robinhood',
      fetchedAt: Date.now() - (r.ageMs ?? 0),
    });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('ethUsdPrice quote-token discipline', () => {
  it('ignores a stablecoin-quoted pair even when it is the newest entry', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [
      { token: '0xa', quote: WETH, usd: 0.7602, native: 0.0004, ageMs: 5_000 }, // → $1900.50
      // The poison: quoted in a $1 stablecoin, so priceUsd/priceNative ≈ 1. Newest, so the old
      // "most recently fetched wins" rule would return ~$1.00 here.
      { token: '0xb', quote: USDC, usd: 2.5, native: 2.5, ageMs: 0 },
    ]);
    const rate = oracle.ethUsdPrice()!;
    expect(rate).toBeGreaterThan(1800);
    expect(rate).toBeLessThan(2000);
    expect(rate).not.toBeCloseTo(1, 1); // the observed failure, explicitly
  });

  it('ignores a memecoin-quoted pair (the ~$113 and ~$22 rows)', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [
      { token: '0xa', quote: WETH, usd: 0.7602, native: 0.0004 },
      { token: '0xb', quote: MEME, usd: 113, native: 1, ageMs: 0 },
    ]);
    expect(oracle.ethUsdPrice()!).toBeGreaterThan(1800);
  });

  it('takes the median of ETH-quoted pairs, so one anomaly cannot move the rate', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [
      { token: '0xa', quote: WETH, usd: 1.9, native: 0.001 },   // 1900
      { token: '0xb', quote: WETH, usd: 1.91, native: 0.001 },  // 1910
      { token: '0xc', quote: WETH, usd: 9.5, native: 0.001, ageMs: 0 }, // 9500 — bad print
    ]);
    expect(oracle.ethUsdPrice()!).toBeCloseTo(1910, 6); // median, not the 9500 outlier
  });

  it('rejects an implausible rate rather than pricing with it', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [{ token: '0xa', quote: WETH, usd: 0.0089, native: 1 }]); // the observed $0.0089
    expect(oracle.ethUsdPrice()).toBeNull();
  });

  it('skips stale entries and returns null rather than guessing', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [{ token: '0xa', quote: WETH, usd: 0.76, native: 0.0004, ageMs: 60 * 60_000 }]);
    expect(oracle.ethUsdPrice()).toBeNull();
  });

  it('NEGATIVE CONTROL: the old rule reproduces the ~$1.00 rate on the same cache', () => {
    const oracle = new PriceOracle([]);
    seed(oracle, [
      { token: '0xa', quote: WETH, usd: 0.7602, native: 0.0004, ageMs: 5_000 },
      { token: '0xb', quote: USDC, usd: 2.5, native: 2.5, ageMs: 0 },
    ]);
    // Verbatim pre-fix logic: newest live pair wins, quote token never consulted.
    const live = (oracle as unknown as { live: LiveMap }).live;
    let best: { rate: number; fetchedAt: number } | null = null;
    for (const l of live.values()) {
      const native = l.priceNative as number;
      if (!native || native <= 0) continue;
      const rate = (l.priceUsd as number) / native;
      const fetchedAt = l.fetchedAt as number;
      if (!best || fetchedAt > best.fetchedAt) best = { rate, fetchedAt };
    }
    // The bug, on the very cache the first test now handles correctly.
    expect(best!.rate).toBeCloseTo(1, 5);
    expect(oracle.ethUsdPrice()).toBeGreaterThan(1800);
  });
});

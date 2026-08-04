import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceOracle } from '../chain/price.js';
import { priceEthFromSqrtX96 } from '../chain/poolPrice.js';
import { computeConviction } from '../engine/conviction.js';
import type { SwapEvent, TrackedToken, TrackedWallet } from '../types.js';

/**
 * The ANOA regression (2026-08-04).
 *
 * ANOA (0xf8b3224659fa5883b1122cfa3ae0fa61ed279ed4) fired eight escalating BUY
 * alerts showing a market cap of $13.1M, identical on every one. Its real cap
 * was $2,598 on $2.6k of liquidity, down 65% in 6h — a rug. The $13.1M was
 * `derive(address) * 1e9`: a hash of the token address multiplied by a
 * PLACEHOLDER supply, produced because DexScreener had not indexed the
 * hours-old pair. That fiction then cleared ALERT_MIN_MARKETCAP ($25k), the
 * floor whose entire job was to suppress a $2.6k coin.
 *
 * Two independent fabrications had to line up: an invented price, and an
 * invented supply. These tests pin both shut, and the gates that consumed them.
 */

const TOKEN = '0xf8b3224659fa5883b1122cfa3ae0fa61ed279ed4';

/** The exact synthetic the old oracle derived for ANOA's address. */
const ANOA_SYNTHETIC_PRICE = 0.01309876;

function token(over: Partial<TrackedToken> = {}): TrackedToken {
  return {
    address: TOKEN,
    symbol: 'ANOA',
    name: 'Anoa',
    totalSupply: 1_000_000_000,
    supplyVerified: false,
    discovered: true,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PriceOracle — unknown means null, never a fabricated number', () => {
  it('reports no price for a token no real source can price', () => {
    const oracle = new PriceOracle([]);
    expect(oracle.priceOf(TOKEN)).toBeNull();
    expect(oracle.usdValue(TOKEN, 1_000_000)).toBeNull();
    expect(oracle.isLive(TOKEN)).toBe(false);
    expect(oracle.sourceOf(TOKEN)).toBeNull();
  });

  it('reports no market cap for it — not the $13.1M that alerted eight times', () => {
    const oracle = new PriceOracle([]);
    expect(oracle.marketCap(token())).toBeNull();
  });

  /**
   * NEGATIVE CONTROL. Re-enabling the synthetic fallback reproduces the exact
   * number that shipped to Telegram — so the assertions above are demonstrably
   * held up by the fix, not by the test environment happening to be quiet.
   */
  it('reproduces the original $13.1M when the synthetic fallback is switched back on', async () => {
    vi.stubEnv('PRICE_SYNTHETIC_FALLBACK', 'true');
    vi.resetModules();
    const { PriceOracle: Fresh } = await import('../chain/price.js');
    const oracle = new Fresh([]);

    const price = oracle.priceOf(TOKEN);
    expect(price).toBeCloseTo(ANOA_SYNTHETIC_PRICE, 8);
    // Even with the fallback on, a market cap still needs a VERIFIED supply —
    // the second fabrication is closed independently of the first.
    expect(oracle.marketCap(token())).toBeNull();
    // Grant the placeholder supply the verification it never had, and the
    // original headline number reappears exactly.
    expect(oracle.marketCap(token({ supplyVerified: true }))).toBeCloseTo(13_098_760, 0);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('will not derive a cap from an unverified (placeholder) supply even with a real price', async () => {
    const oracle = new PriceOracle([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: 'robinhood',
              baseToken: { address: TOKEN, symbol: 'ANOA' },
              priceUsd: '0.000002598',
              priceNative: '0.000000001388',
              // DexScreener omits the cap — the case that forced the derivation.
              liquidity: { usd: 2614 },
            },
          ],
        }),
      }),
    );
    await oracle.refreshNow(TOKEN);

    expect(oracle.priceOf(TOKEN)).toBeCloseTo(0.000002598, 12);
    expect(oracle.sourceOf(TOKEN)).toBe('dexscreener');
    // Price is real, supply is a guess → cap stays unknown.
    expect(oracle.marketCap(token())).toBeNull();
    // Supply read from the contract → cap is now computable, and it is tiny.
    expect(oracle.marketCap(token({ supplyVerified: true }))).toBeCloseTo(2598, 0);
  });
});

describe('conviction with an unknown market cap', () => {
  const wallets: TrackedWallet[] = [
    {
      address: '0x1',
      label: 'a',
      category: 'whale',
      tier: 'alpha',
      rank: 1,
      confidence: 0.9,
      holdsTokens: ['X', 'Y'],
    },
  ];
  const swaps = [{ direction: 'BUY' }] as SwapEvent[];
  const base = {
    wallets,
    swaps,
    token: token(),
    windowSeconds: 10,
    totalUsd: 5_000,
  };

  it('does not score the cap-derived factors at all', () => {
    const { breakdown } = computeConviction({ ...base, marketCap: null });
    expect(breakdown.marketCap).toBe(0);
    expect(breakdown.liquidity).toBe(0);
  });

  it('renormalises rather than scoring an unknown cap as the worst possible cap', () => {
    const unknown = computeConviction({ ...base, marketCap: null }).score;
    // A cap so large both factors score ~0 is the "worst cap" case. An unknown
    // cap must land ABOVE it — absence of evidence is not evidence of a bad coin.
    const hugeCap = computeConviction({ ...base, marketCap: 1e12 }).score;
    expect(unknown).toBeGreaterThan(hugeCap);
  });

  it('leaves the known-cap score untouched (weights already sum to 1)', () => {
    const known = computeConviction({ ...base, marketCap: 60_000 });
    expect(known.breakdown.marketCap).toBeGreaterThan(0);
    expect(known.score).toBeGreaterThan(0);
  });
});

describe('priceEthFromSqrtX96', () => {
  // sqrtPriceX96 for a 1:1 raw ratio is exactly 2^96.
  const ONE = 2n ** 96n;

  it('prices a same-decimals pair at parity', () => {
    expect(priceEthFromSqrtX96(ONE, true, 18)).toBeCloseTo(1, 12);
    expect(priceEthFromSqrtX96(ONE, false, 18)).toBeCloseTo(1, 12);
  });

  it('undoes the decimal difference between the two sides', () => {
    // A raw 1:1 ratio means 1 base unit of token trades for 1 wei. For a
    // 6-decimal token that is 1e6 wei per whole token = 1e-12 ETH — NOT 1.
    // Skipping this correction is how an 18-decimal token comes out right by
    // luck while everything else is wrong by orders of magnitude.
    expect(priceEthFromSqrtX96(ONE, true, 6)).toBeCloseTo(1e-12, 20);
    // Same pool, token on the other side: the ratio inverts, the decimal
    // correction inverts with it, and the answer is unchanged.
    expect(priceEthFromSqrtX96(ONE, false, 6)).toBeCloseTo(1e-12, 20);
  });

  it('returns null for an uninitialised pool rather than 0 or NaN', () => {
    expect(priceEthFromSqrtX96(0n, true, 18)).toBeNull();
  });
});

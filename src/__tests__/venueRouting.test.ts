import { describe, it, expect } from 'vitest';
import { parseEther, parseUnits } from 'ethers';
import { pickBestQuote, type VenueQuote } from '../sniper/executor.js';

/**
 * Regression fixtures for the 2026-08-01/02 decoy-pool incident.
 *
 * IOU (0xf391999f…0bed) and HMN (0x94eb2e58…f8d8) each had their real market on
 * a 1%-fee Uniswap V3 pool, plus one or more near-worthless V4 pools charging
 * 75–99.9%. The old router picked a single V4 pool by raw uint128 liquidity —
 * which the decoy legitimately won, since L says nothing about fee — quoted the
 * round trip at −100%, and the depth gate skipped both tokens as "too thin".
 * Both were tradeable at ~2.1% round-trip the whole time.
 *
 * All numbers below are real: measured on-chain at 0.0049 Ξ, the live buy size.
 */

const SIZE = parseEther('0.0049');
const DEC = 18;

// Measured: V3 fee-tier 10000 pool 0x074A398f…d423.
//   buy  0.0049 Ξ -> 285,226.594355723239674139 IOU
//   sell that back -> 0.004792849449068975 Ξ   (round trip -2.19%)
const IOU_V3: VenueQuote = {
  venue: 'v3',
  fee: 10000,
  amountOut: 285226594355723239674139n,
  ethBack: parseEther('0.004792849449068975'),
};

// Measured: V4 pool fee 950123 / tickSpacing 200, the pool the old code chose.
// Spot there prices IOU ~16x cheaper than the real market, so even behind a
// 95.01% fee the BUY quote stays competitive — 230,640 tokens, 0.81x the real
// pool. The exit is what exposes it: ~nothing comes back.
const IOU_V4_DECOY: VenueQuote = {
  venue: 'v4',
  fee: 950123,
  amountOut: parseUnits('230640', DEC),
  ethBack: parseEther('0.00001199'), // 0.0049 behind two 95% fees -> -99.76%
};

describe('pickBestQuote — venue selection', () => {
  it('routes IOU to the real v3 pool, not the 95%-fee v4 decoy', () => {
    const { pick } = pickBestQuote([IOU_V4_DECOY, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
    });
    expect(pick?.venue).toBe('v3');
    expect(pick?.fee).toBe(10000);
  });

  it('routes correctly with NO market price to compare against', () => {
    // The fresh-launch case, and the reason ranking by quote matters rather
    // than leaning on checkPriceSanity: a 30-second-old token has no indexed
    // DexScreener price, so expectedPriceEth is null and the sanity filter
    // cannot fire at all. The round-trip ranking still has to pick v3 alone.
    const { pick, rejectedBySanity } = pickBestQuote([IOU_V4_DECOY, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
      expectedPriceEth: null,
    });
    expect(pick?.venue).toBe('v3');
    expect(rejectedBySanity).toBe(0);
  });

  it('would pick the DECOY if ranked on buy output — the negative control', () => {
    // Proves the round-trip ranking is what does the work. Nudge the decoy's
    // buy quote just past the real pool's (a decoy priced slightly cheaper);
    // on output alone it now wins, but it must still lose on the round trip.
    const cheaperDecoy: VenueQuote = { ...IOU_V4_DECOY, amountOut: IOU_V3.amountOut + 1n };
    expect(cheaperDecoy.amountOut > IOU_V3.amountOut).toBe(true); // it does win on output

    const { pick } = pickBestQuote([cheaperDecoy, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
    });
    expect(pick?.venue).toBe('v3');
  });

  it('routes HMN to its 1% v3 pool over the 95%-fee v4 pool', () => {
    // Measured: v3 fee 10000 pool 0x3d9e362d…724c, round trip -2.09%.
    const hmnV3: VenueQuote = {
      venue: 'v3',
      fee: 10000,
      amountOut: parseUnits('412880', DEC),
      ethBack: parseEther('0.004797590'),
    };
    const hmnV4Decoy: VenueQuote = {
      venue: 'v4',
      fee: 950120,
      amountOut: parseUnits('380110', DEC),
      ethBack: parseEther('0.0000119'),
    };
    const { pick } = pickBestQuote([hmnV4Decoy, hmnV3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
    });
    expect(pick?.venue).toBe('v3');
  });

  it('still picks v4 when v4 is genuinely the better venue', () => {
    // Guards against "fix" that just always prefers v3.
    const v4Good: VenueQuote = {
      venue: 'v4',
      fee: 3000,
      amountOut: parseUnits('300000', DEC),
      ethBack: parseEther('0.00485'),
    };
    const v3Worse: VenueQuote = {
      venue: 'v3',
      fee: 10000,
      amountOut: parseUnits('280000', DEC),
      ethBack: parseEther('0.00470'),
    };
    const { pick } = pickBestQuote([v4Good, v3Worse], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
    });
    expect(pick?.venue).toBe('v4');
    expect(pick?.fee).toBe(3000);
  });

  it('ranks a sell on ETH out, since a sell has no round trip', () => {
    const a: VenueQuote = { venue: 'v4', fee: 10000, amountOut: parseEther('0.004') };
    const b: VenueQuote = { venue: 'v3', fee: 10000, amountOut: parseEther('0.0047') };
    const { pick } = pickBestQuote([a, b], {
      amountIn: parseUnits('285226', DEC),
      decimals: DEC,
      direction: 'sell',
    });
    expect(pick?.venue).toBe('v3');
  });

  it('catches the decoy that checkPriceSanity structurally CANNOT see', () => {
    // The most important case here. A high-fee trap is close to invisible on
    // entry: the 95% fee hands back fewer tokens, but the decoy's spot price is
    // also far below market, and the two effects very nearly cancel. Measured,
    // the decoy quoted 2.1245e-8 ETH/token against a real market of 1.7179e-8
    // — just 1.24x off, well inside PRICE_SANITY_MULTIPLE's 3x band. So the
    // sanity guard passes it, and every entry-side check must, because the
    // damage is entirely on the exit. Nothing that looks only at the buy can
    // see a fee trap; pricing the round trip is the only thing that can.
    const expectedPriceEth = Number(SIZE) / Number(IOU_V3.amountOut); // the real market
    const { pick, rejectedBySanity } = pickBestQuote([IOU_V4_DECOY, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
      expectedPriceEth,
    });
    expect(rejectedBySanity).toBe(0); // sanity waved the decoy straight through
    expect(pick?.venue).toBe('v3'); // the round-trip ranking still rejected it
  });

  it('still drops a candidate that IS implausibly priced — the VLADBOT shape', () => {
    // Sanity filtering earns its keep on a pool that is wrong on price rather
    // than on fee: ~25x off market, far outside the 3x band.
    const wayOff: VenueQuote = {
      venue: 'v4',
      fee: 3000,
      amountOut: IOU_V3.amountOut / 25n,
      ethBack: parseEther('0.0048'), // would otherwise rank respectably
    };
    const expectedPriceEth = Number(SIZE) / Number(IOU_V3.amountOut);
    const { pick, rejectedBySanity } = pickBestQuote([wayOff, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
      expectedPriceEth,
    });
    expect(rejectedBySanity).toBe(1);
    expect(pick?.venue).toBe('v3');
  });

  it('falls back to the raw best rather than refusing when sanity rejects all', () => {
    // A stale or wrong market price must not be able to ground the sniper.
    const { pick, rejectedBySanity } = pickBestQuote([IOU_V4_DECOY, IOU_V3], {
      amountIn: SIZE,
      decimals: DEC,
      direction: 'buy',
      expectedPriceEth: 1, // nonsense reference: nothing can pass
    });
    expect(rejectedBySanity).toBe(2);
    expect(pick?.venue).toBe('v3'); // still the best of the two on round trip
  });

  it('degrades to raw output when every exit quote failed', () => {
    // A chain hiccup on the sell leg scores every candidate 0n; the tie-break
    // must fall back to the old behaviour, not to an arbitrary pick.
    const a: VenueQuote = { venue: 'v4', fee: 3000, amountOut: parseUnits('100', DEC), ethBack: 0n };
    const b: VenueQuote = { venue: 'v3', fee: 10000, amountOut: parseUnits('200', DEC), ethBack: 0n };
    const { pick } = pickBestQuote([a, b], { amountIn: SIZE, decimals: DEC, direction: 'buy' });
    expect(pick?.venue).toBe('v3');
  });

  it('returns null when nothing quoted', () => {
    const { pick } = pickBestQuote([], { amountIn: SIZE, decimals: DEC, direction: 'buy' });
    expect(pick).toBeNull();
  });
});

import type {
  ConvictionBreakdown,
  SwapEvent,
  TrackedToken,
  TrackedWallet,
} from '../types.js';

export interface ConvictionInput {
  wallets: TrackedWallet[];
  swaps: SwapEvent[];
  token: TrackedToken;
  windowSeconds: number;
  totalUsd: number;
  /** Null when the market cap is unknown — see the note on UNKNOWN_CAP_FACTORS. */
  marketCap: number | null;
}

/**
 * Weights sum to 1. Wallet quality (tier) and directional purity dominate; the
 * token-side factors (liquidity/market cap here) are intentionally light because
 * the pipeline refines conviction with the *real* market cap, liquidity and
 * momentum once the price data is fetched at alert time — and because they are
 * the two that go unknown on a coin too new to be indexed.
 */
const WEIGHTS: Record<keyof ConvictionBreakdown, number> = {
  walletQuality: 0.3,
  walletCount: 0.18,
  totalCapital: 0.14,
  velocity: 0.12,
  liquidity: 0.04,
  marketCap: 0.06,
  historicalAccuracy: 0.06,
  buySellRatio: 0.1,
};

/** The two factors that are derived from the market cap, and are therefore
 *  unknowable when the cap is. When it is null they score 0 AND their weight is
 *  removed from the denominator, so the remaining factors decide the score on
 *  their own. Zeroing them without renormalising would score an unknown cap as
 *  the worst possible cap — a different fiction from the one this replaced. */
const UNKNOWN_CAP_FACTORS = ['liquidity', 'marketCap'] as const;

const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * Compute a 0–100 conviction score for a candidate swarm from the factors the
 * spec calls out: wallet quality, wallet count, capital, velocity, liquidity,
 * market cap, historical accuracy and buy/sell ratio. Each factor is normalized
 * to 0–100, then weighted.
 */
export function computeConviction(input: ConvictionInput): {
  score: number;
  breakdown: ConvictionBreakdown;
} {
  const { wallets, swaps, token, windowSeconds, totalUsd, marketCap } = input;
  const n = Math.max(wallets.length, 1);

  const avgConfidence =
    wallets.reduce((s, w) => s + w.confidence, 0) / n; // 0..1

  // Cross-coin wallets are stronger signal — reward average coin breadth.
  const avgBreadth =
    wallets.reduce((s, w) => s + Math.min(w.holdsTokens.length, 5), 0) / n; // 1..5

  const walletQuality = clamp100(avgConfidence * 80 + (avgBreadth - 1) * 5);

  // Diminishing returns past ~10 wallets.
  const walletCount = clamp100((Math.log2(n + 1) / Math.log2(11)) * 100);

  // Log scale: $1k ≈ 30, $100k ≈ 70, $1M+ ≈ 100.
  const totalCapital = clamp100((Math.log10(totalUsd + 1) / 6) * 100);

  // Wallets per second across the observed window — tighter = more coordinated.
  const span = Math.max(windowSeconds, 1);
  const velocity = clamp100((n / span) * 60);

  // Both of these are functions of the market cap; unknown cap → 0, and the
  // weights below are renormalised so the zero is not read as a low score.
  const capKnown = marketCap != null && marketCap > 0;

  // Liquidity proxy: swap notional relative to market cap.
  const liquidity = capKnown ? clamp100((totalUsd / marketCap!) * 100_000) : 0;

  // Smaller caps move faster — inverse of log market cap.
  const marketCapScore = capKnown ? clamp100(100 - (Math.log10(marketCap! + 10) / 9) * 100) : 0;

  const historicalAccuracy = clamp100(avgConfidence * 100);

  // Directional purity: all-buys or all-sells scores high.
  const buys = swaps.filter((s) => s.direction === 'BUY').length;
  const sells = swaps.length - buys;
  const purity = swaps.length ? Math.abs(buys - sells) / swaps.length : 0;
  const buySellRatio = clamp100(purity * 100);

  const breakdown: ConvictionBreakdown = {
    walletQuality: Math.round(walletQuality),
    walletCount: Math.round(walletCount),
    totalCapital: Math.round(totalCapital),
    velocity: Math.round(velocity),
    liquidity: Math.round(liquidity),
    marketCap: Math.round(marketCapScore),
    historicalAccuracy: Math.round(historicalAccuracy),
    buySellRatio: Math.round(buySellRatio),
  };

  const scored = (Object.keys(WEIGHTS) as (keyof ConvictionBreakdown)[]).filter(
    (k) => capKnown || !(UNKNOWN_CAP_FACTORS as readonly string[]).includes(k),
  );
  const totalWeight = scored.reduce((sum, k) => sum + WEIGHTS[k], 0);
  const score = clamp100(
    totalWeight > 0
      ? scored.reduce((sum, k) => sum + breakdown[k] * WEIGHTS[k], 0) / totalWeight
      : 0,
  );

  return { score: Math.round(score), breakdown };
}

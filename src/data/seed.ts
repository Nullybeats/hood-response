import type { TrackedToken, TrackedWallet, WalletCategory, WalletTier } from '../types.js';
import { TRACKED_TOKENS_RAW, TRACKED_HOLDERS_RAW } from './holders.generated.js';

/**
 * Source of truth: `holders.generated.ts`, produced by scripts/fetch-holders.mjs
 * from Robinhood Chain's block explorer — the top-N EOA holders of each tracked
 * token (LP pools / contracts / burn addresses excluded). Wallets are derived
 * and tiered (alpha/beta/chroma/delta by best holder rank) deterministically.
 * Re-run the script to refresh or add coins.
 */

export interface RawTokenSeed {
  symbol: string;
  name: string;
  address: string;
  totalSupply: number;
  stable?: boolean;
}

export interface RawHolderSeed {
  address: string;
  pct: number;
}


const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function categorize(maxPct: number, coinCount: number): WalletCategory {
  if (maxPct >= 4) return 'whale';
  if (coinCount >= 3) return 'internal';
  if (coinCount >= 2) return 'vc';
  return 'retail';
}

/** Tier from best holder rank: alpha 1–3, beta 4–6, chroma 7–9, delta 10. */
function tierForRank(rank: number): WalletTier {
  if (rank <= 3) return 'alpha';
  if (rank <= 6) return 'beta';
  if (rank <= 9) return 'chroma';
  return 'delta';
}

/** Baseline confidence per tier (best rank = strongest conviction). */
const TIER_CONFIDENCE: Record<WalletTier, number> = {
  alpha: 0.9,
  beta: 0.72,
  chroma: 0.58,
  delta: 0.45,
};

/** Build the immutable seed catalogs once at module load. */
function build(): { tokens: TrackedToken[]; wallets: TrackedWallet[] } {
  const allTokens: RawTokenSeed[] = TRACKED_TOKENS_RAW;
  const allHolders: Record<string, RawHolderSeed[]> = TRACKED_HOLDERS_RAW;

  const tokens: TrackedToken[] = allTokens.map((t) => ({
    address: t.address.toLowerCase(),
    symbol: t.symbol,
    name: t.name,
    totalSupply: t.totalSupply,
    // Seed supplies were read from the contracts when the catalog was generated.
    supplyVerified: true,
    stable: t.stable ?? false,
  }));

  interface Acc {
    address: string;
    holdsTokens: Set<string>;
    maxPct: number;
    bestRank: number;
  }
  const byWallet = new Map<string, Acc>();

  for (const [symbol, holders] of Object.entries(allHolders)) {
    holders.forEach((h, i) => {
      const rank = i + 1; // holders are listed in rank order (1..N)
      const key = h.address.toLowerCase();
      const acc = byWallet.get(key) ?? {
        address: key,
        holdsTokens: new Set<string>(),
        maxPct: 0,
        bestRank: 99,
      };
      acc.holdsTokens.add(symbol);
      acc.maxPct = Math.max(acc.maxPct, h.pct);
      acc.bestRank = Math.min(acc.bestRank, rank);
      byWallet.set(key, acc);
    });
  }

  const wallets: TrackedWallet[] = [...byWallet.values()].map((acc) => {
    const coins = [...acc.holdsTokens].sort();
    const coinCount = coins.length;
    const category = categorize(acc.maxPct, coinCount);
    const tier = tierForRank(acc.bestRank);
    // Confidence is anchored on the tier (best rank) and nudged up for
    // cross-coin conviction wallets.
    const confidence = clamp01(TIER_CONFIDENCE[tier] + (coinCount - 1) * 0.03);
    const label =
      coinCount > 1
        ? `${tier} · ${coinCount} coins`
        : `${tier} · #${acc.bestRank} ${coins[0]}`;
    return {
      address: acc.address,
      label,
      category,
      tier,
      rank: acc.bestRank,
      confidence: Number(confidence.toFixed(3)),
      holdsTokens: coins,
      notes:
        coinCount > 1
          ? `Cross-coin conviction wallet: ${coins.join(', ')}`
          : undefined,
    };
  });

  // Best tier first (alpha → delta), then cross-coin breadth, for stable order.
  const tierOrder: Record<WalletTier, number> = { alpha: 0, beta: 1, chroma: 2, delta: 3 };
  wallets.sort(
    (a, b) =>
      tierOrder[a.tier] - tierOrder[b.tier] ||
      a.rank - b.rank ||
      b.holdsTokens.length - a.holdsTokens.length,
  );

  return { tokens, wallets };
}

const seeded = build();

export const SEED_TOKENS: readonly TrackedToken[] = seeded.tokens;
export const SEED_WALLETS: readonly TrackedWallet[] = seeded.wallets;

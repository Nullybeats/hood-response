import { config } from './config/env.js';

const DEXSCREENER_BASE = 'https://dexscreener.com';

/**
 * Build a DexScreener link for a token. When `DEXSCREENER_CHAIN` is configured
 * we deep-link to the token page for that chain; otherwise we fall back to
 * DexScreener's universal address search, which resolves on any chain.
 */
export function dexScreenerUrl(tokenAddress: string): string {
  const addr = tokenAddress.toLowerCase();
  return config.DEXSCREENER_CHAIN
    ? `${DEXSCREENER_BASE}/${config.DEXSCREENER_CHAIN}/${addr}`
    : `${DEXSCREENER_BASE}/search?q=${addr}`;
}

/** Block-explorer token page link. */
export function explorerUrl(tokenAddress: string): string {
  const base = config.EXPLORER_BASE.replace(/\/$/, '');
  return `${base}/token/${tokenAddress.toLowerCase()}`;
}

/** Mascot art for an alert, by kind — the cat Telegram renders above the card.
 *  PRIME overrides the kind and gets the sniper portrait. Paths are files in
 *  cipherfi's `web/public/`, served from ASSET_BASE_URL. */
export function mascotUrl(kind: string, prime = false): string {
  const base = config.ASSET_BASE_URL.replace(/\/$/, '');
  if (prime) return `${base}/lore/sniper-cat.webp`;
  const path =
    kind === 'SELL'
      ? '/mascot/kneel.webp'
      : kind === 'ROTATION'
        ? '/mascot/point.webp'
        : kind === 'SOLO'
          ? '/mascot/bipod.webp'
          : kind === 'ENTRY'
            ? '/mascot/prone.webp'
            : '/mascot/advance.webp';
  return `${base}${path}`;
}

/**
 * Mascot art for a v2 match, chosen by its lane.
 *
 * Kept separate from mascotUrl() rather than mapping lanes onto legacy kinds:
 * there is no kind that means "allocation", and inventing one to pick a picture
 * is how a rendering convenience turns into a wire-level lie. Unknown lanes fall
 * through to the neutral advance pose — a lane this build has not heard of still
 * deserves a card.
 */
export function mascotUrlForLane(lane: string | undefined): string {
  const base = config.ASSET_BASE_URL.replace(/\/$/, '');
  const path =
    lane === 'solo-buy'
      ? '/mascot/bipod.webp'
      : lane === 'fresh-entry'
        ? '/mascot/prone.webp'
        : lane === 'allocation'
          ? '/mascot/point.webp'
          : '/mascot/advance.webp';
  return `${base}${path}`;
}

/** One-tap Sigma bot buy link, pre-filled with the token contract. Null when
 *  no referral id is configured (SIGMA_REF). */
export function sigmaBuyUrl(tokenAddress: string): string | null {
  if (!config.SIGMA_REF) return null;
  return `https://t.me/Sigma_buyBot?start=x${config.SIGMA_REF}-${tokenAddress}`;
}

/** One-tap Based bot buy link, pre-filled with the token contract. Null when
 *  no referral id is configured (BASED_REF). */
export function basedBuyUrl(tokenAddress: string): string | null {
  if (!config.BASED_REF) return null;
  return `https://t.me/based_eth_bot?start=r_${config.BASED_REF}_b_${tokenAddress}`;
}

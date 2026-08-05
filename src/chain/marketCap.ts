/**
 * Market-cap resolution across multiple sources.
 *
 * The rule this exists to hold: **unknown stays unknown, but we try much harder
 * before saying it.** Before, a cap came from exactly one place (DexScreener's
 * own figure) with a single fallback (price x supply), and any token that fell
 * through both was suppressed by every cap gate. Those tokens are not random —
 * they are disproportionately the newest pairs, which is the window worth
 * trading. Widening the *resolution* without touching the *thresholds* is the
 * only way to shrink that blind spot without going back to fabricating numbers.
 *
 * What is deliberately NOT here: a synthetic/estimated cap. The fabricated
 * `hash(address) * 1e9` produced ANOA's $13.1M against a real $2,598 and cleared
 * a $25k floor whose only job was to stop it. Every source below is a
 * measurement; when they all fail the answer is null, and null fails closed
 * exactly as it does today.
 */

/** Which source established the cap. Null when nothing could. */
export type CapSource = 'dexscreener' | 'derived-onchain';

export interface CapInputs {
  /** Cap reported by the market-data source itself (DexScreener marketCap/fdv). */
  sourceCap: number | null;
  /** Real USD price from any live source, or null. */
  price: number | null;
  /** Human-unit supply. Meaningless unless `supplyVerified`. */
  totalSupply: number;
  /** True only when the supply was read from the contract. */
  supplyVerified: boolean;
}

export interface CapResult {
  cap: number | null;
  source: CapSource | null;
  /**
   * Why no cap could be established — for the suppression log, so an operator
   * can tell "nobody has indexed this pair yet" apart from "we never managed to
   * read its supply". They have different fixes.
   */
  reason: 'ok' | 'no-price' | 'unverified-supply' | 'no-source';
}

/** A cap has to be a positive, finite number of dollars to mean anything. */
const usable = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Resolve a market cap from the first source that actually has one.
 *
 * Order is by directness of measurement, not convenience:
 *
 *   1. `dexscreener`      — the indexer's own figure. It knows the circulating
 *                           supply, so it is the only source that can be more
 *                           right than price x total supply.
 *   2. `derived-onchain`  — a real price times a supply read from the contract.
 *                           Fully diluted, so it can read high against an
 *                           indexer's circulating figure; that is why it ranks
 *                           second rather than first.
 *
 * Pure and synchronous by design: every input is already resolved by the time
 * this is called, which makes it exhaustively testable and keeps the hot
 * detection path off the network.
 */
export function resolveMarketCap(input: CapInputs): CapResult {
  if (usable(input.sourceCap)) {
    return { cap: input.sourceCap, source: 'dexscreener', reason: 'ok' };
  }

  if (!usable(input.price)) {
    return { cap: null, source: null, reason: 'no-price' };
  }

  // A price alone is not a cap. Multiplying it by ensureToken's 1e9 placeholder
  // is how the fabrication used to happen, so the supply must be the
  // contract's own.
  if (!input.supplyVerified || !usable(input.totalSupply)) {
    return { cap: null, source: null, reason: 'unverified-supply' };
  }

  const cap = input.price * input.totalSupply;
  if (!usable(cap)) return { cap: null, source: null, reason: 'no-source' };
  return { cap, source: 'derived-onchain', reason: 'ok' };
}

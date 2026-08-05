/**
 * The gas/fee override decision, kept pure and separate from the executor.
 *
 * `router.execute(...)` looks like a single call but ethers issues `eth_estimateGas`, a fee lookup
 * and `eth_getTransactionCount` before it signs — ~350ms of RPC at the latency measured on the box,
 * sitting in front of every broadcast, on the one stretch of the entry path where milliseconds move
 * the fill price. Supplying the values ourselves removes those round trips.
 *
 * It lives here rather than inside `executor.ts` because that module constructs a JsonRpcProvider and
 * a Wallet on import-adjacent paths, which a unit test cannot load — and a rule that decides what gas
 * price a funded wallet broadcasts at should be the easiest thing in the repo to test, not the
 * hardest. Same reasoning as `walletShare.ts`.
 *
 * Both levers are OFF by default. Zeroed config reproduces the previous behaviour exactly.
 */

/** A gas fee quote and when it was taken. */
export interface FeeQuote {
  at: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * How many refresh intervals a cached fee quote may age before it is discarded.
 *
 * Load-bearing: an underpriced transaction sits unmined while the entry it was racing for evaporates,
 * which costs incomparably more than the one round trip the cache saved. When in doubt we pay for a
 * fresh lookup — falling back is always safe, because it is exactly what the code did before.
 */
export const STALE_FEE_FACTOR = 3;

export interface OverrideInputs {
  /** `SNIPER_BUY_GAS_LIMIT`; 0 = let ethers estimate. */
  gasLimit: number;
  /** `SNIPER_FEE_CACHE_MS`; 0 = let ethers look fees up inline. */
  feeCacheMs: number;
  /** The most recent background fee refresh, or null if none has landed. */
  fees: FeeQuote | null;
  now: number;
}

/**
 * The transaction overrides to merge into a swap call. An empty object means "decide nothing" —
 * ethers then behaves exactly as it did before this existed, which is the safe default and the
 * fallback for every uncertain case.
 */
export function buildTxOverrides({ gasLimit, feeCacheMs, fees, now }: OverrideInputs): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  if (gasLimit > 0) out.gasLimit = BigInt(gasLimit);
  if (feeCacheMs > 0 && fees && !isFeeStale(fees, feeCacheMs, now)) {
    out.maxFeePerGas = fees.maxFeePerGas;
    out.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  }
  return out;
}

/** True when a quote has aged past the point we are willing to broadcast at. */
export function isFeeStale(fees: FeeQuote, feeCacheMs: number, now: number): boolean {
  return now - fees.at > feeCacheMs * STALE_FEE_FACTOR;
}

/**
 * Pons launchpad — entry-gate math.
 *
 * This is the load-bearing piece of the whole strategy, and it is not what the launchpad's own
 * documentation implies. `PonsLauncherToken._update` reverts EVERY pool→user buy while
 * `block.number == launchBlock` (custom error `LaunchBlockBuyBlocked`), and on this Arbitrum Nitro
 * chain `block.number` is the **L1 clock (~12s)**, NOT the 0.1s L2 clock.
 *
 * [verified on-chain 2026-08-05] L2 head 28,268,978 vs EVM `block.number` 25,686,923 — a 2.58M gap
 * advancing ~1 per 12s. A live launch was simulated at three points: it REVERTED at the launch
 * block, REVERTED one block before the gate, and FILLED at the gate block.
 *
 * Consequences that shape the executor:
 *   • Every launch has a hard 0–12s dead window nobody can beat, so detection latency is slack —
 *     there is no point paying for a metered WSS feed to shave milliseconds here.
 *   • The contest is being first into the FIRST L2 block after the L1 clock ticks past the launch.
 *     [measured] the field takes a median 8.7s, and 34/39 launches saw exactly one buy in that
 *     first unblocked block.
 *
 * Pure and dependency-free so it can be unit-tested without a chain — the same convention
 * `txOverrides.ts` and `walletShare.ts` follow.
 */

export interface PonsGate {
  /** First L1 block at which a pool buy is permitted. */
  opensAtL1: number;
  /** Last L1 block on which maxWallet/maxTx caps still apply. */
  restrictionEndsL1: number;
}

/**
 * The gate for a launch, in L1 block numbers.
 *
 * `restrictionBlocks` must come from the live launch config rather than be assumed — it is
 * owner-mutable on the factory, and a wrong anchor fires us into the dead window on every launch.
 */
export function gateFor(launchBlockL1: number, restrictionBlocks: number): PonsGate {
  return { opensAtL1: launchBlockL1 + 1, restrictionEndsL1: launchBlockL1 + restrictionBlocks };
}

/**
 * The launch's own L1 block, recovered from the event.
 *
 * `TokenLaunched.restrictionsEndBlock` is already in L1 units and is set in the token's constructor
 * as `block.number + restrictionBlocks`, so the launch block is that minus the config's window.
 * [verified] for a real launch this reproduced the `l1BlockNumber` of the launch's own L2 block
 * exactly.
 */
export function launchBlockL1From(restrictionsEndBlock: number, restrictionBlocks: number): number {
  return restrictionsEndBlock - restrictionBlocks;
}

/**
 * Has the gate opened at this observed L1 block?
 *
 * `>=`, never `==`. The L1 clock SKIPS values: [verified 2026-08-05] a live launch computed a gate
 * of L1 25,687,079 and no L2 block ever carried that number — the chain stepped 25,687,078 →
 * 25,687,080. An equality test would leave that launch armed forever. The token's own
 * `block.number` skips identically, so the restriction really does lift at the first value past the
 * gate (that launch's buy filled at 25,687,080).
 */
export function gateOpen(observedL1: number, gate: PonsGate): boolean {
  return observedL1 >= gate.opensAtL1;
}

/**
 * Are the maxWallet/maxTx caps still in force?
 *
 * Only relevant for sizing: during the window a buy is capped at `maxWalletBps` of supply. At the
 * trade sizes this engine uses (≤0.005 Ξ against a full 1e9 supply) it is never binding, but the
 * check is here so a future size increase cannot silently start reverting.
 */
export function inRestrictionWindow(observedL1: number, gate: PonsGate): boolean {
  return observedL1 <= gate.restrictionEndsL1;
}

/** Largest token amount the restriction window permits a single fresh buyer to hold. */
export function restrictedBuyCap(supply: bigint, maxWalletBps: number, maxTxBps: number): bigint {
  const wallet = (supply * BigInt(maxWalletBps)) / 10_000n;
  const tx = (supply * BigInt(maxTxBps)) / 10_000n;
  return wallet < tx ? wallet : tx;
}

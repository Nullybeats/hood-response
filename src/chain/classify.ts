import { id } from 'ethers';
import { TRANSFER_TOPIC } from './decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from './receipt.js';

/**
 * What a tracked-wallet Transfer actually WAS, judged from the other logs in the
 * same transaction.
 *
 * This exists because "a tracked wallet received tokens" is not a buy signal, and
 * the difference is the whole question. The old engine had no gate at all — every
 * tracked-wallet Transfer counted as a swap — so its higher swap/swarm counts are
 * not better coverage, they are a looser definition. [verified 2026-08-05: one
 * sampled tracked-wallet transfer, tx 0xeab0a2c9…, was a Uniswap V3
 * NonfungiblePositionManager liquidity action with no Swap event anywhere in it.]
 *
 * Note carefully what the swap bucket is and is not. A V3/V4 `Swap` event in the
 * same transaction means a swap HAPPENED in that transaction — not that this
 * particular transfer was the trader's purchase. A multi-call transaction (a
 * router settling several legs, an aggregator batching users, a contract that
 * swaps and then pays someone else) can contain both without the tracked wallet
 * having bought anything. So the bucket is named for what it measures:
 * `swap-cooccurrence`, not `confirmed-swap`.
 */
export type CandidateClass =
  /** A V3/V4 Swap event occurs in the same tx. Evidence, not proof — see above. */
  | 'swap-cooccurrence'
  /** Liquidity added or removed: position-manager / pool Mint / Burn events. */
  | 'liquidity'
  /** No counter-transfer from the wallet and no swap: tokens arrived for free. */
  | 'airdrop'
  /** Plain movement of tokens with no DEX event anywhere in the transaction. */
  | 'plain-transfer';

// ── Liquidity signatures ────────────────────────────────────────────────────
// Uniswap V3 NonfungiblePositionManager and the pool contracts themselves.
const INCREASE_LIQUIDITY = id('IncreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const DECREASE_LIQUIDITY = id('DecreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const V3_MINT = id('Mint(address,address,int24,int24,uint128,uint256,uint256)').toLowerCase();
const V3_BURN = id('Burn(address,int24,int24,uint128,uint256,uint256)').toLowerCase();
// Uniswap V4 PoolManager liquidity change.
const V4_MODIFY_LIQUIDITY = id(
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
).toLowerCase();

const LIQUIDITY_TOPICS = new Set([
  INCREASE_LIQUIDITY,
  DECREASE_LIQUIDITY,
  V3_MINT,
  V3_BURN,
  V4_MODIFY_LIQUIDITY,
]);

const SWAP_TOPICS = new Set([V3_SWAP_TOPIC, V4_SWAP_TOPIC]);

/** The minimum shape the classifier needs from any log in the transaction. */
export interface TxLog {
  topic0?: string | null;
  /** Transfer `from`, as a 32-byte topic. */
  topic1?: string | null;
  /** Transfer `to`, as a 32-byte topic. */
  topic2?: string | null;
}

export interface ClassifyInput {
  /** Every log in the transaction containing the tracked-wallet transfer. */
  txLogs: TxLog[];
  /** The tracked wallet, as a 32-byte topic (lower-case). */
  walletTopic: string;
  /** Whether the tracked transfer moved tokens TO the wallet (a receive). */
  incoming: boolean;
}

const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();

/**
 * Classify one tracked-wallet transfer from its transaction's logs.
 *
 * Order matters: liquidity is checked BEFORE swap co-occurrence, because adding
 * liquidity to a pool routinely emits a Swap in the same transaction (a
 * zap/single-sided add swaps half the input first). Classifying that as a swap
 * would count the exact false positive this is here to find.
 */
export function classifyCandidate(input: ClassifyInput): CandidateClass {
  const topics = input.txLogs.map((l) => lower(l.topic0));

  if (topics.some((t) => LIQUIDITY_TOPICS.has(t))) return 'liquidity';
  if (topics.some((t) => SWAP_TOPICS.has(t))) return 'swap-cooccurrence';

  // No DEX event at all. If the wallet only RECEIVED and never sent anything in
  // this transaction, nothing was given in exchange — an airdrop or a gift.
  if (input.incoming) {
    const w = lower(input.walletTopic);
    const walletSentSomething = input.txLogs.some(
      (l) => lower(l.topic0) === TRANSFER_TOPIC && lower(l.topic1) === w,
    );
    if (!walletSentSomething) return 'airdrop';
  }
  return 'plain-transfer';
}

/** Empty tally, so callers do not have to spell the buckets out. */
export function emptyTally(): Record<CandidateClass, number> {
  return {
    'swap-cooccurrence': 0,
    liquidity: 0,
    airdrop: 0,
    'plain-transfer': 0,
  };
}

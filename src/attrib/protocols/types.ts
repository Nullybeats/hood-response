/**
 * Protocol adapter contract.
 *
 * THE STRUCTURAL RULE: an adapter returns EVIDENCE, never a verdict. It reports
 * "a V3 Swap fired here, from this pool, moving these amounts" — it cannot say
 * "the wallet bought". Only `classifier.ts` decides outcomes, and only after
 * checking that the assets actually moved to or from the watched wallet.
 *
 * That separation is what makes "a router destination is not a trade" a property
 * of the type system rather than a comment someone can forget. The universal
 * router adapter is registered precisely so its interactions are *recognised*
 * and *not* counted as trades.
 */

export type ProtocolStatus = 'supported' | 'observed-but-unsupported' | 'deprecated';

/** One log, reduced to what an adapter needs. */
export interface TxLogView {
  address: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string | null;
  logIndex: number;
}

export interface TxContext {
  txHash: string;
  /** Every log in the transaction, in order. */
  logs: TxLogView[];
  /** The watched wallet as a 32-byte topic, lower-cased. */
  walletTopic: string;
  /** The watched wallet as a 20-byte address, lower-cased. */
  wallet: string;
  txTo: string | null;
  /**
   * Who SENT the transaction, lower-cased. Required to attribute `nativeValueWei`: the top-level
   * value is paid by `tx.from`, so crediting it to the watched wallet without this would let a
   * third party's ETH prove OUR wallet bought something — a receipt that merely contains the
   * wallet's token transfer is not evidence the wallet paid for it.
   */
  txFrom: string | null;
  selector: string | null;
  /** Top-level native value in wei. Does NOT include internal transfers. */
  nativeValueWei: string | null;
  receiptStatus: string | null;
  /**
   * Contracts whose protocol identity has been ESTABLISHED for this
   * transaction — e.g. a pool confirmed against its factory, or a known
   * canonical address. Populated by the ingester.
   *
   * A topic hash is not an identity: anyone can deploy a contract that emits
   * `Swap(...)` or `Paid(...)`. Findings from emitters absent here are marked
   * unverified and can never support a `confirmed_trade`.
   */
  verifiedContracts?: Set<string>;
  /**
   * Contracts whose verification has NOT COMPLETED — throttled, timed out, or
   * still queued. Deliberately a separate set from `verifiedContracts` rather
   * than an absence from it.
   *
   * Absence from `verifiedContracts` alone cannot distinguish "the trusted
   * factory disowned this pool" from "we got a 429 on the way to asking". The
   * first is a settled answer; the second is a backlog. Merging them would let
   * a rate limit permanently mark a legitimate pool unsupported.
   */
  pendingContracts?: Set<string>;
}

export type FindingKind =
  | 'swap'
  | 'liquidity_add'
  | 'liquidity_remove'
  /** A V4 PoolManager Donate action. Not liquidity and never a trade. */
  | 'donation'
  | 'fee'
  | 'no-op-mirror'
  | 'launch'
  | 'routing'
  | 'approval'
  | 'wrap'
  | 'unwrap';

/**
 * A single piece of evidence. Deliberately NOT an outcome.
 *
 * `beneficiary` is the address the protocol says received the benefit, when the
 * event carries one. The classifier compares it against the watched wallet;
 * an adapter that cannot determine it leaves it null rather than guessing.
 */
export interface ProtocolFinding {
  kind: FindingKind;
  protocolId: string;
  adapterVersion: number;
  contract: string;
  eventSig: string;
  logIndex: number;
  beneficiary?: string | null;
  /** True only when the emitter's protocol identity was established, not merely
   *  when its topic matched. Unverified findings are evidence of *something*,
   *  but never sufficient for a confirmed trade. */
  verified: boolean;
  tokenIn?: string | null;
  tokenOut?: string | null;
  /** Uniswap v4 PoolId, when the event carries one.  It is not an address. */
  poolId?: string | null;
  note?: string;
}

export interface ProtocolAdapter {
  id: string;
  name: string;
  version: string;
  adapterVersion: number;
  status: ProtocolStatus;
  /** role -> address, lower-cased. Empty when the protocol is identified purely
   *  by event signature (pools are per-token and cannot be enumerated here). */
  contracts: Record<string, string>;
  /** name -> topic0, lower-cased. */
  events: Record<string, string>;
  /** Return [] for "nothing of mine in this transaction". */
  interpret(ctx: TxContext): ProtocolFinding[];
}

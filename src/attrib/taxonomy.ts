/**
 * Attribution taxonomy — types and reason codes only, no logic.
 *
 * Kept dependency-free so tests, the dashboard and the ledger can import it
 * without pulling in the chain layer.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE: every watched-wallet candidate
 * resolves to exactly one {@link Outcome}. There is no fifth state and no
 * "skip". A transaction we cannot explain is `unknown_unsupported`, which is a
 * RESULT — recorded, counted, and visible — not an absence.
 *
 * That distinction is the whole point. The old engine labelled every
 * tracked-wallet ERC-20 Transfer a BUY or SELL, so "wallet received tokens"
 * became "wallet bought tokens": measured on the live shadow, 453 non-trade
 * movements (139 liquidity, 286 airdrop, 28 plain transfer) against 7
 * transactions that actually carried a Uniswap Swap. An honest `unknown` is
 * strictly better than a confident wrong label, because a wrong label reaches
 * the sniper and a wrong label is what buys the wrong coin.
 */

/**
 * THE CANONICAL UNIT IS `(txHash, watchedWallet)` — NOT `(txHash, logIndex)`.
 *
 * A transaction can carry many Transfer logs, more than one swap, and more than
 * one watched wallet. A log index identifies an EMISSION; it does not identify
 * the economic action. Keying the verdict on it would let one transaction hold
 * several contradictory answers for the same wallet, and would make "did this
 * wallet trade here?" unanswerable without re-joining. So:
 *
 *   observation  (txHash, logIndex, wallet)  — the raw triggering log, provenance
 *   attribution  (txHash, wallet, version)   — the one canonical outcome
 *
 * The accounted-for invariant runs over observed `(txHash, wallet)` PAIRS.
 */

/** Bump on ANY change to classifier rules. Written on every attribution row. */
export const CLASSIFIER_VERSION = 3;

/**
 * Unknown categories that are NOT a settled answer about the transaction — they
 * record that we have not finished looking. They must be re-attempted and must
 * never be reported alongside terminal unknowns, or an infrastructure backlog
 * reads as a conclusion about the chain.
 */
export const RETRIABLE_UNKNOWN: ReadonlySet<Category> = new Set<Category>([
  'verification_pending',
  'no_receipt_available',
]);

/** Bump when an adapter's interpretation changes. Written alongside the above. */
export const ADAPTER_REGISTRY_VERSION = 2;

/** The four mutually exclusive, collectively exhaustive outcomes. */
export type Outcome =
  | 'confirmed_trade'
  | 'confirmed_non_trade'
  | 'unknown_unsupported'
  | 'ingestion_or_decoding_failure';

/** A demonstrated economic exchange attributable to the watched wallet. */
export type TradeCategory =
  | 'swap_v3_router'
  | 'swap_v4_poolmanager'
  | 'swap_v4_hooked'
  /** A V3 swap in a tx that also carries Pons' TokenLaunched. Pons has NO bonding
   *  curve — it mints straight into a V3 pool at fee 10000 — so this is a tag on
   *  the V3 path, not a venue of its own. */
  | 'pons_launch_buy';

/** Proven to have happened, and proven NOT to be a trade. */
export type NonTradeCategory =
  | 'liquidity_add'
  | 'liquidity_remove'
  /** V4 PoolManager Donate. A transfer into a pool is not a token purchase. */
  | 'pool_donation'
  /** Collect (pool + position manager), FeesClaimed, Paid. The largest
   *  previously-unhandled class: 415+ events in a 30k-block sample. */
  | 'fee_collection'
  | 'airdrop_receive'
  | 'plain_transfer'
  | 'self_transfer'
  | 'wrap_or_unwrap'
  | 'approval_or_permit_only'
  /** TransferWithScaledUI — a UI-scaled mirror of a Transfer emitted by the
   *  Robinhood tokenized equities. 4,781 occurrences in a 30k-block sample; a
   *  duplicate VIEW of a movement, never a movement of its own. */
  | 'ui_scaled_mirror'
  | 'bridge_in_or_out'
  | 'nft_or_lp_position_action'
  /** Receipt status !== 0x1. A reverted transaction moved nothing. */
  | 'failed_tx'
  | 'unrelated_or_no_net_trade';

/**
 * Something happened that we cannot explain. Never a trade, never a non-trade.
 * Each of these is a work item: the reason code says what would resolve it.
 */
export type UnknownCategory =
  /** An event signature no adapter claims. Drives the unknown-topic leaderboard. */
  | 'unknown_topic'
  /**
   * Verification COMPLETED and did not establish trusted provenance. A real,
   * deterministic answer: the emitter claimed the wrong factory, or the trusted
   * factory disowned it. Safe to cache; will not change on retry.
   */
  | 'unsupported_protocol'
  /**
   * Verification HAS NOT COMPLETED — a 429, a timeout, or the pool is still
   * sitting in the verification queue.
   *
   * THIS IS NOT `unsupported_protocol`, and collapsing the two would rebuild the
   * exact defect this subsystem exists to remove, only harder to see. The old
   * engine turned an absence of evidence into a positive label (BUY); turning
   * "we have not looked yet" into "verification says no" is the same error with
   * the sign flipped — an infrastructure hiccup laundered into a permanent
   * verdict about a contract's identity. A throttle would silently and durably
   * disqualify a legitimate pool.
   *
   * So this category is explicitly RETRIABLE: it holds its cursor, it is
   * re-attempted, and it is reported separately from every terminal verdict.
   */
  | 'verification_pending'
  /**
   * The transaction legitimately contains BOTH a liquidity/fee action and a
   * swap, and the wallet's net flow does not resolve which the wallet was
   * doing — a zap, a rebalance, a multi-action batch.
   *
   * This is why there is no blanket "liquidity present ⇒ not a trade" rule: a
   * rebalance really does swap. Calling it a non-trade hides a real trade;
   * calling it a trade resurrects the receipt.ts defect. It is genuinely
   * unresolved, so it is recorded as unresolved and SUPPRESSED for live alerts
   * until an adapter can decompose it.
   */
  | 'mixed_or_ambiguous_activity'
  /** A Swap exists but the asset deltas do not reconcile to THIS wallet — a
   *  router settling for a third party, an aggregator batching users. This is
   *  what stops "destination is a router" from being read as "wallet traded". */
  | 'ambiguous_multiparty'
  /** The determination depends on native value moving through internal calls,
   *  which receipts cannot show. `tx.value` covers only the top-level leg.
   *  Never guess past this — the size of this bucket is what tells us whether
   *  chasing trace support is worth it. */
  | 'insufficient_trace_data'
  | 'ambiguous_asset_flow'
  | 'no_receipt_available'
  | 'unpriced_metadata_missing';

/** We failed to observe, not the chain failing to be observable. */
/**
 * Whether a failure can be retried.
 *
 * This distinction exists because the accounted-for invariant must never create
 * pressure to write a TERMINAL verdict for a transaction we simply failed to
 * fetch. A 429 on a receipt is not "unknown_unsupported" — it is "we have not
 * looked yet". Terminalising it to zero the drift count would launder an
 * infrastructure problem into a permanent classification, which is precisely
 * the absence-as-data failure this subsystem exists to remove.
 */
export type FailureDisposition = 'retriable' | 'terminal';

export const FAILURE_DISPOSITION: Record<FailureCategory, FailureDisposition> = {
  rpc_http_error: 'retriable',
  rpc_jsonrpc_error: 'retriable',
  rpc_transport_error: 'retriable',
  pagination_truncated: 'retriable',
  receipt_missing: 'retriable',
  ledger_write_error: 'retriable',
  // A payload we fetched successfully and could not parse will not parse next
  // time either; retrying is a loop, not a fix.
  decode_error: 'terminal',
};

export type FailureCategory =
  | 'rpc_http_error'
  | 'rpc_jsonrpc_error'
  | 'rpc_transport_error'
  /** A paginated query did not cover its requested range. Recorded rather than
   *  treated as "no logs here" — the failure mode that made a swap-log query
   *  silently stop at 261 of 1000 requested blocks. */
  | 'pagination_truncated'
  | 'receipt_missing'
  | 'decode_error'
  | 'ledger_write_error';

export type Category = TradeCategory | NonTradeCategory | UnknownCategory | FailureCategory;

/** Which outcome a category belongs to. Single source of truth for the mapping. */
export const OUTCOME_OF: Record<Category, Outcome> = {
  swap_v3_router: 'confirmed_trade',
  swap_v4_poolmanager: 'confirmed_trade',
  swap_v4_hooked: 'confirmed_trade',
  pons_launch_buy: 'confirmed_trade',

  liquidity_add: 'confirmed_non_trade',
  liquidity_remove: 'confirmed_non_trade',
  pool_donation: 'confirmed_non_trade',
  fee_collection: 'confirmed_non_trade',
  airdrop_receive: 'confirmed_non_trade',
  plain_transfer: 'confirmed_non_trade',
  self_transfer: 'confirmed_non_trade',
  wrap_or_unwrap: 'confirmed_non_trade',
  approval_or_permit_only: 'confirmed_non_trade',
  ui_scaled_mirror: 'confirmed_non_trade',
  bridge_in_or_out: 'confirmed_non_trade',
  nft_or_lp_position_action: 'confirmed_non_trade',
  failed_tx: 'confirmed_non_trade',
  unrelated_or_no_net_trade: 'confirmed_non_trade',

  unknown_topic: 'unknown_unsupported',
  mixed_or_ambiguous_activity: 'unknown_unsupported',
  unsupported_protocol: 'unknown_unsupported',
  verification_pending: 'unknown_unsupported',
  ambiguous_multiparty: 'unknown_unsupported',
  insufficient_trace_data: 'unknown_unsupported',
  ambiguous_asset_flow: 'unknown_unsupported',
  no_receipt_available: 'unknown_unsupported',
  unpriced_metadata_missing: 'unknown_unsupported',

  rpc_http_error: 'ingestion_or_decoding_failure',
  rpc_jsonrpc_error: 'ingestion_or_decoding_failure',
  rpc_transport_error: 'ingestion_or_decoding_failure',
  pagination_truncated: 'ingestion_or_decoding_failure',
  receipt_missing: 'ingestion_or_decoding_failure',
  decode_error: 'ingestion_or_decoding_failure',
  ledger_write_error: 'ingestion_or_decoding_failure',
};

/** A watched wallet's net movement of one asset within one transaction. */
export interface WalletDelta {
  token: string;
  /** Signed, in raw contract units. Stringified: these exceed Number precision. */
  rawDelta: string;
  decimals: number | null;
  /**
   * How the delta was established. These are NOT interchangeable:
   *
   *   erc20_logs             a Transfer log named this wallet
   *   weth_wrap_logs         a canonical WETH Deposit/Withdrawal credited it
   *   trace_native           an execution trace showed native value moving
   *                          to/from this wallet — POSITIVE proof
   *   insufficient_trace_data
   *                          a leg is known to exist but could not be read —
   *                          the ABSENCE of proof, never evidence of a movement
   *
   * The last two are opposites and must never be conflated. Treating an
   * unreadable leg as a proven one would confirm trades on missing data, which
   * is the failure mode this whole subsystem exists to prevent.
   */
  source: 'erc20_logs' | 'weth_wrap_logs' | 'trace_native' | 'insufficient_trace_data';
}

/** Why the classifier decided what it decided. Never free text alone. */
export interface Evidence {
  /** Event signatures matched, as topic0 hashes. */
  topics: string[];
  /** Contracts whose events were used, lowercased. */
  contracts: string[];
  /** Receipt log indices that carried the decisive evidence. */
  logIndices: number[];
  /** The transaction's 4-byte selector, when it had input data. */
  selector: string | null;
  /** Adapters that contributed findings. */
  protocols: string[];
  /** Net asset movement for the watched wallet. */
  deltas: WalletDelta[];
  /** Human-readable one-liner. Supplementary to the structured fields above. */
  note?: string;
  /**
   * Set only on `insufficient_trace_data`, to make the trace-provider decision
   * quantifiable rather than a judgement call.
   *
   *   oneSidedDelta   exactly one token leg moved for this wallet
   *   hadTopLevelValue tx.value was non-zero (so the native leg MIGHT be visible)
   *   hadVerifiedSwap a verified pool emitted a Swap in this transaction
   *
   * A case with a one-sided delta, no top-level value, and a verified swap is a
   * PLAUSIBLE trade that traces would resolve. One without a swap is probably
   * unrelated and traces would not help. Counting them separately is what says
   * whether a trace provider is worth its complexity.
   */
  traceGap?: {
    oneSidedDelta: boolean;
    hadTopLevelValue: boolean;
    hadVerifiedSwap: boolean;
  };
}

export interface AttributionResult {
  outcome: Outcome;
  category: Category;
  evidence: Evidence;
  classifierVersion: number;
  adapterRegistryVersion: number;
}

/** Build a result with the outcome derived from the category, never passed in
 *  separately — the two cannot drift out of sync. */
export function result(category: Category, evidence: Evidence): AttributionResult {
  return {
    outcome: OUTCOME_OF[category],
    category,
    evidence,
    classifierVersion: CLASSIFIER_VERSION,
    adapterRegistryVersion: ADAPTER_REGISTRY_VERSION,
  };
}

/** Empty evidence, so callers never hand-build a partial object. */
export function emptyEvidence(): Evidence {
  return { topics: [], contracts: [], logIndices: [], selector: null, protocols: [], deltas: [] };
}

/** Zeroed tally across all four outcomes, for metrics. */
export function emptyOutcomeTally(): Record<Outcome, number> {
  return {
    confirmed_trade: 0,
    confirmed_non_trade: 0,
    unknown_unsupported: 0,
    ingestion_or_decoding_failure: 0,
  };
}

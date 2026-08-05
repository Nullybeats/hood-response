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

/** Bump on ANY change to classifier rules. Written on every result row. */
export const CLASSIFIER_VERSION = 1;

/** Bump when an adapter's interpretation changes. Written alongside the above. */
export const ADAPTER_REGISTRY_VERSION = 1;

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
  | 'unsupported_protocol'
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
  unsupported_protocol: 'unknown_unsupported',
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
  /** How the delta was established. `insufficient_trace_data` means a leg is
   *  known to exist but is invisible in receipt logs. */
  source: 'erc20_logs' | 'weth_wrap_logs' | 'insufficient_trace_data';
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

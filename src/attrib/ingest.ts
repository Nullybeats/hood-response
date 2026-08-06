import { logger } from '../logger.js';
import { classifyTransaction } from './classifier.js';
import type { AttributionLedger, ObservationKey, TxRecord } from './ledger.js';
import type { PoolVerifier } from './poolVerify.js';
import type { TxContext } from './protocols/types.js';
import {
  CLASSIFIER_VERSION,
  type AttributionResult,
  type FailureCategory,
  type WalletDelta,
} from './taxonomy.js';

/**
 * The ingester: turning observations into verdicts, one pair at a time.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. ONE LEDGER TRANSACTION PER PAIR. Observation, transaction context,
 *    enrichment state, and either an attribution or a retriable pending row all
 *    commit together or not at all. A pair must never be observable in the
 *    ledger without an outcome or a pending marker beside it, because a pair in
 *    that state is invisible to both the coverage query and the retry queue —
 *    it is silently dropped, which is the exact failure this subsystem exists
 *    to remove. Note that the write happens BEFORE any exception can propagate.
 *
 * 2. ADVANCE THE CURSOR ONLY AFTER THE COMMIT. A cursor is a claim that
 *    everything below it is accounted for. Advancing first — or advancing past
 *    a pair that is still pending — converts a transient failure into permanent
 *    invisibility, since nothing will ever look at that range again. So the
 *    cursor is held back by the oldest unresolved pair, not by the newest
 *    successful one.
 *
 * IDEMPOTENCY IS A RESTART PROPERTY, NOT A NICETY. A replay over the same range
 * must produce no duplicate attribution, must not re-request a verification
 * already in flight, and must not leap the cursor past unresolved work. All
 * three are enforced against the ledger rather than in-process state, because
 * in-process state is precisely what a restart loses.
 */

export interface EnrichedTx {
  tx: TxRecord;
  ctx: Omit<TxContext, 'verifiedContracts' | 'pendingContracts'>;
  /** Pools whose identity this transaction's verdict depends on. */
  candidatePools: string[];
  extraDeltas?: WalletDelta[];
  decimals?: Record<string, number>;
}

/** Fetch a transaction's receipt and reduce it to a classifier context. */
export type Enricher = (
  txHash: string,
  wallet: string,
) => Promise<
  { ok: true; value: EnrichedTx } | { ok: false; kind: FailureCategory; detail: string }
>;

export interface PairObservation {
  txHash: string;
  wallet: string;
  blockNumber: number;
  logIndex: number;
  triggerSource: 'transfer_log' | 'tx_sender' | 'tx_recipient' | 'trace';
  token?: string | null;
}

export interface IngestOptions {
  ledger: AttributionLedger;
  verifier: PoolVerifier;
  enrich: Enricher;
  sourceHost: string;
  classifierVersion?: number;
}

export interface PairResult {
  key: ObservationKey;
  blockNumber: number;
  /** Exactly one of these is set. There is no third state. */
  attribution: AttributionResult | null;
  pending: PendingReason | null;
  /** True when the pair was already settled and no work was done. */
  skipped: boolean;
}

/** Work that remains retriable without pretending it is a chain verdict. */
type PendingReason = FailureCategory | 'verification_pending';

export interface IngestSummary {
  processed: number;
  attributed: number;
  pending: number;
  skippedAlreadyAttributed: number;
  /** Verification requests suppressed because one was already outstanding. */
  verificationClaimsSuppressed: number;
  /** Highest block safe to advance a cursor to, or null if none is. */
  safeThroughBlock: number | null;
  /** Lowest block still holding work. The cursor may never pass it. */
  heldAtBlock: number | null;
}

export class Ingester {
  private readonly cv: number;
  private verificationClaimsSuppressed = 0;
  /** At most one retry per pending pool in one batch.  A 429 resolves quickly,
   * so PoolVerifier's in-flight map alone cannot prevent the next pair in a
   * sequential batch from immediately issuing the same five calls again. */
  private readonly attemptedPendingPools = new Set<string>();

  constructor(private readonly o: IngestOptions) {
    this.cv = o.classifierVersion ?? CLASSIFIER_VERSION;
  }

  /**
   * Resolve the pools a transaction's verdict depends on.
   *
   * The ledger claim is what makes single-flight survive a restart: the
   * in-process coalescing map inside PoolVerifier dies with the process, so
   * without a durable claim every pair referencing a mid-flight pool would
   * re-request it on boot.
   *
   * A pool we do not hold the claim for is NOT verified here and NOT concluded
   * against — it lands in `pendingContracts`, which the classifier reads as
   * `verification_pending` rather than `unsupported_protocol`.
   */
  private async resolvePools(pools: string[]): Promise<{ verified: Set<string>; pending: Set<string> }> {
    const { ledger, verifier } = this.o;
    for (const raw of new Set(pools.map((p) => p.toLowerCase()))) {
      const pool = raw.toLowerCase();
      const state = ledger.poolVerificationState(pool);
      if (state === 'verified' || state === 'unverified') continue; // settled, immutable

      if (state === 'pending' && this.attemptedPendingPools.has(pool)) {
        // A prior pair already retried this pending pool in this batch.  Do not
        // turn one transient failure into five calls per later candidate.
        this.verificationClaimsSuppressed += 1;
        continue;
      }
      if (state === 'pending') {
        this.attemptedPendingPools.add(pool);
      } else if (!ledger.claimPoolVerification(pool)) {
        // Another worker claimed it between our read and insert.  It remains
        // pending for this pair; a later batch may retry after the owner settles.
        this.verificationClaimsSuppressed += 1;
        continue;
      }
      // This includes a newly claimed pool.  If its verification returns a
      // transient failure, later pairs in the same batch must not immediately
      // retry it before the host-wide scheduler has had a chance to recover.
      this.attemptedPendingPools.add(pool);
      const v = await verifier.verifyV3(pool);
      ledger.resolvePoolVerification(pool, v.status, v.protocol, v.reason, v.evidence);
    }
    return { verified: ledger.verifiedPools(), pending: ledger.pendingPools() };
  }

  /**
   * Settle one pair: fetch, classify, and write — atomically.
   *
   * Every exit path from this method writes a row. The `catch` is not defensive
   * padding: an unexpected throw between observation and verdict is exactly how
   * a pair becomes invisible, so it is converted into a pending row rather than
   * allowed to escape.
   */
  async settlePair(obs: PairObservation): Promise<PairResult> {
    const { ledger } = this.o;
    const key: ObservationKey = { txHash: obs.txHash.toLowerCase(), wallet: obs.wallet.toLowerCase() };
    const base = { key, blockNumber: obs.blockNumber };

    // IDEMPOTENCE. A settled pair is not re-fetched: doing so would spend the
    // rate limit we are trying to protect, to recompute an answer we have.
    if (ledger.isAttributed(key, this.cv)) {
      return { ...base, attribution: null, pending: null, skipped: true };
    }

    let enriched: Awaited<ReturnType<Enricher>>;
    try {
      enriched = await this.o.enrich(key.txHash, key.wallet);
    } catch (err) {
      return this.commitPending(base, obs, 'rpc_transport_error', String(err));
    }

    if (!enriched.ok) {
      return this.commitPending(base, obs, enriched.kind, enriched.detail);
    }
    const val = enriched.value;

    let pools: { verified: Set<string>; pending: Set<string> };
    try {
      pools = await this.resolvePools(val.candidatePools);
    } catch (err) {
      return this.commitPending(base, obs, 'rpc_transport_error', String(err));
    }

    const ctx: TxContext = {
      ...val.ctx,
      verifiedContracts: pools.verified,
      pendingContracts: pools.pending,
    };

    let res: AttributionResult;
    try {
      res = classifyTransaction({ ctx, decimals: val.decimals, extraDeltas: val.extraDeltas });
    } catch (err) {
      // A classifier throw is a DECODE failure, not an unknown verdict. Writing
      // `unknown_unsupported` here would claim we looked and could not explain
      // it, when in fact we crashed.
      return this.commitPending(base, obs, 'decode_error', String(err));
    }

    const unresolved = val.candidatePools.filter((p) => pools.pending.has(p.toLowerCase())).length;

    // `verification_pending` is deliberately NOT an attribution.  It means
    // the receipt was fetched but a required pool proof has not completed;
    // storing it as a verdict would make `isAttributed()` skip this pair on
    // every later replay and permanently freeze a transient 429 into place.
    // Keep it in the durable retry queue instead, so a later pass can reuse
    // the receipt context and produce the real classification once provenance
    // is available.
    if (res.category === 'verification_pending') {
      return this.commitVerificationPending(base, obs, val, res, unresolved);
    }

    try {
      ledger.transaction(() => {
        ledger.recordTx(val.tx);
        ledger.recordObservation(
          key.txHash,
          obs.logIndex,
          key.wallet,
          obs.blockNumber,
          obs.triggerSource,
          obs.token ?? null,
        );
        ledger.recordEnrichment(key, {
          receiptFetched: true,
          poolsSeen: val.candidatePools.length,
          poolsUnresolved: unresolved,
          classifierVersion: this.cv,
        });
        ledger.recordDeltas(key.txHash, key.wallet, res.evidence.deltas);
        ledger.recordAttribution(key, res);
      });
    } catch (err) {
      // The ledger write itself failed. The pair must still end up somewhere
      // retriable, or it is dropped.
      return this.commitPending(base, obs, 'ledger_write_error', String(err));
    }

    return { ...base, attribution: res, pending: null, skipped: false };
  }

  /** Write the pair as retriable, atomically, and record why. */
  private commitPending(
    base: { key: ObservationKey; blockNumber: number },
    obs: PairObservation,
    kind: PendingReason,
    detail: string,
  ): PairResult {
    const { ledger } = this.o;
    try {
      ledger.transaction(() => {
        ledger.recordObservation(
          base.key.txHash,
          obs.logIndex,
          base.key.wallet,
          obs.blockNumber,
          obs.triggerSource,
          obs.token ?? null,
        );
        ledger.recordEnrichment(base.key, {
          receiptFetched: false,
          poolsSeen: 0,
          poolsUnresolved: 0,
        });
        ledger.markPending(base.key, kind);
        // Verification-pending is retryable enrichment state, not an RPC
        // failure by itself.  Actual RPC failures are recorded by the verifier
        // with their real reason; manufacturing one here would corrupt metrics.
        if (kind !== 'verification_pending') {
          ledger.recordFailure({
            operation: 'ingest',
            fromBlock: obs.blockNumber,
            toBlock: obs.blockNumber,
            sourceUrl: this.o.sourceHost,
            kind,
            detail: detail.slice(0, 200),
            txHash: base.key.txHash,
            wallet: base.key.wallet,
          });
        }
      });
    } catch (err) {
      logger.error({ err: String(err), tx: base.key.txHash }, 'attrib: pending write failed');
    }
    return { ...base, attribution: null, pending: kind, skipped: false };
  }

  /** Persist a fetched receipt whose required provenance check is still queued. */
  private commitVerificationPending(
    base: { key: ObservationKey; blockNumber: number },
    obs: PairObservation,
    val: EnrichedTx,
    res: AttributionResult,
    unresolved: number,
  ): PairResult {
    const { ledger } = this.o;
    try {
      ledger.transaction(() => {
        ledger.recordTx(val.tx);
        ledger.recordObservation(
          base.key.txHash,
          obs.logIndex,
          base.key.wallet,
          obs.blockNumber,
          obs.triggerSource,
          obs.token ?? null,
        );
        ledger.recordEnrichment(base.key, {
          receiptFetched: true,
          poolsSeen: val.candidatePools.length,
          poolsUnresolved: unresolved,
          classifierVersion: this.cv,
        });
        ledger.recordDeltas(base.key.txHash, base.key.wallet, res.evidence.deltas);
        ledger.markPending(base.key, 'verification_pending');
      });
    } catch (err) {
      return this.commitPending(base, obs, 'ledger_write_error', String(err));
    }
    return { ...base, attribution: null, pending: 'verification_pending', skipped: false };
  }

  /**
   * Ingest a batch, then report how far a cursor may safely advance.
   *
   * THE CURSOR IS HELD BY THE OLDEST UNRESOLVED PAIR, not pushed by the newest
   * resolved one. If block 100 is pending and block 200 succeeded, the safe
   * cursor is 99 — advancing to 200 would mean nothing ever revisits block 100,
   * turning a retriable 429 into permanent invisibility.
   *
   * The caller advances the cursor. This method deliberately does not, so that
   * the min-across-streams rule stays in one place.
   */
  async ingestBatch(observations: PairObservation[], coveredThrough: number): Promise<IngestSummary> {
    this.verificationClaimsSuppressed = 0;
    this.attemptedPendingPools.clear();
    let attributed = 0;
    let pending = 0;
    let skipped = 0;
    let heldAt: number | null = null;

    for (const obs of observations) {
      const r = await this.settlePair(obs);
      if (r.skipped) skipped += 1;
      else if (r.attribution) attributed += 1;
      if (r.pending != null) {
        pending += 1;
        if (heldAt == null || r.blockNumber < heldAt) heldAt = r.blockNumber;
      }
    }

    // Pairs parked by EARLIER runs hold the cursor too. A restart that only
    // considered this batch would happily advance past work it never retried.
    for (const w of this.o.ledger.pendingWork(1000)) {
      const b = this.o.ledger.pendingBlock(w.tx_hash, w.watched_wallet);
      if (b != null && (heldAt == null || b < heldAt)) heldAt = b;
    }

    const safeThroughBlock = heldAt == null ? coveredThrough : Math.min(coveredThrough, heldAt - 1);

    return {
      processed: observations.length,
      attributed,
      pending,
      skippedAlreadyAttributed: skipped,
      verificationClaimsSuppressed: this.verificationClaimsSuppressed,
      safeThroughBlock: safeThroughBlock >= 0 ? safeThroughBlock : null,
      heldAtBlock: heldAt,
    };
  }
}

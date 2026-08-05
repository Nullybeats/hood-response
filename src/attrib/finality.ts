import { config } from '../config/env.js';
import type { RollbackGuard } from '../chain/hypersync.js';
import type { AttributionLedger } from './ledger.js';

/**
 * Finality, continuity, and what may honestly be called "covered".
 *
 * Two claims are routinely conflated and must not be:
 *
 *   SCANNED  we read the block
 *   FINAL    the block is still on the canonical chain and will stay there
 *
 * A durable cursor only ever establishes the first. Reporting scanned blocks as
 * settled means a reorg silently invalidates accounting that has already been
 * published — the numbers stay confident while the chain underneath them moves.
 *
 * So the accounting window is explicitly PROVISIONAL above the safe head, and
 * every report says which part of itself is provisional.
 */

/** Blocks below the observed head that are treated as settled. */
export const finalityDepth = (): number => config.ATTRIB_FINALITY_DEPTH;

export interface FinalityStatus {
  /** Chain tip as reported by the source. */
  observedHead: number | null;
  /** observedHead - finalityDepth. Accounting at or below this is settled. */
  safeHead: number | null;
  /** How far the ingester has genuinely covered — never beyond a sweep's `covered`. */
  cursorBlock: number | null;
  /** Hash checkpointed at the cursor, when one is known. */
  cursorHash: string | null;
  finalityDepth: number;
  /** True when the cursor is above the safe head: results in this window may
   *  still be invalidated by a reorg and must be labelled provisional. */
  provisional: boolean;
  /** How many blocks of the current window are provisional. */
  provisionalBlocks: number;
  reorgRollbacks: number;
}

export function finalityStatus(
  ledger: AttributionLedger,
  observedHead: number | null,
  streamId = 'wallet-transfers',
): FinalityStatus {
  const depth = finalityDepth();
  const safeHead = observedHead == null ? null : Math.max(0, observedHead - depth);
  const cursorBlock = ledger.safeCursor();
  const cp = ledger.latestCheckpoint(streamId);
  const provisional =
    cursorBlock != null && safeHead != null ? cursorBlock > safeHead : cursorBlock != null;
  return {
    observedHead,
    safeHead,
    cursorBlock,
    cursorHash: cp?.block_hash ?? null,
    finalityDepth: depth,
    provisional,
    provisionalBlocks:
      cursorBlock != null && safeHead != null ? Math.max(0, cursorBlock - safeHead) : 0,
    reorgRollbacks: ledger.reorgCount(),
  };
}

export interface ContinuityCheck {
  ok: boolean;
  /** Set when a reorg was detected: the block whose parent no longer matches. */
  brokenAt?: number;
  expectedHash?: string | null;
  actualParentHash?: string | null;
}

/**
 * Does this sweep join onto the chain we last checkpointed?
 *
 * HyperSync's `rollback_guard.first_parent_hash` is the parent of the first
 * block in the response. If we hold a checkpoint for that parent's height and
 * the hashes disagree, the chain moved under us. Verified present on this chain
 * 2026-08-05.
 *
 * Absence of a guard is NOT continuity — it is absence of evidence, and is
 * reported as such so a source that stops supplying guards cannot quietly look
 * like a source that never reorgs.
 */
export function checkContinuity(
  ledger: AttributionLedger,
  streamId: string,
  firstGuard: RollbackGuard | null,
): ContinuityCheck {
  if (!firstGuard?.first_block_number || !firstGuard.first_parent_hash) {
    return { ok: true };
  }
  const parentHeight = firstGuard.first_block_number - 1;
  const known = ledger.checkpointAt(streamId, parentHeight);
  if (!known) return { ok: true }; // nothing to contradict
  if (known.toLowerCase() === firstGuard.first_parent_hash.toLowerCase()) return { ok: true };
  return {
    ok: false,
    brokenAt: firstGuard.first_block_number,
    expectedHash: known,
    actualParentHash: firstGuard.first_parent_hash,
  };
}

/**
 * How much of the window is genuinely accounted for.
 *
 * The denominator INCLUDES failed and pending fetches. Excluding them would let
 * a source that is failing report high coverage simply by observing less — the
 * arithmetic would improve as the data got worse.
 */
export interface CoverageWindow {
  fromBlock: number;
  /** Never beyond the smallest `covered` any required sweep achieved. */
  toBlock: number;
  observedPairs: number;
  attributed: number;
  pending: number;
  drift: number;
  /** attributed / (attributed + pending + drift). Pending is in the denominator. */
  accountedRatio: number;
  provisional: boolean;
}

export function coverageWindow(
  ledger: AttributionLedger,
  classifierVersion: number,
  fromBlock: number,
  toBlock: number,
  provisional: boolean,
): CoverageWindow {
  const a = ledger.accountedFor(classifierVersion);
  const denom = a.attributed + a.pending + a.drift;
  return {
    fromBlock,
    toBlock,
    observedPairs: a.pairs,
    attributed: a.attributed,
    pending: a.pending,
    drift: a.drift,
    accountedRatio: denom > 0 ? a.attributed / denom : 0,
    provisional,
  };
}

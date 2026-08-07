/**
 * Wallet outcomes, derived from the tracked-call record.
 *
 * This is what turns a grade from an assumption into a measurement. Without it
 * every wallet is `U` and the `who` dial — 40% of the score — stays dark.
 *
 * The join is `walletId`: a salted digest of the address, already recorded on
 * every TrackedCall as `walletIds`, index-aligned with the display labels. That
 * indirection matters. Labels were the obvious key and were the wrong one: they
 * mutate and they collide, so grouping by label merged two wallets that happened
 * to share a name and split one wallet's record the moment it bought a second
 * coin. The performance module learned that already; this reuses its answer
 * rather than re-deriving it.
 *
 * Two honest limits, both visible in the output rather than papered over:
 *
 *  - A multi-wallet call credits EVERY participating wallet with the same
 *    outcome. We cannot know which of them drove it, and refusing to attribute
 *    at all would discard most of the record. Wallets that only ever ride along
 *    in crowds therefore inherit the crowd's results, which is a real weakness
 *    of grading on this data — it is why grades need a sample floor and why the
 *    crowd GPA is computed separately rather than folded into a wallet's own
 *    grade.
 *  - Calls persisted before `walletIds` existed carry none and are skipped.
 *    They are not silently counted against anyone.
 *
 * Outcomes are keyed by peak, not final price, to match the strategy: a call
 * that ran 3x and gave it back was a good call badly exited, and grading it as a
 * loss would blame the wallet for our own exit logic.
 */

import type { PerformanceTracker, TrackedCall } from '../../engine/performance.js';
import { walletId } from '../../walletId.js';
import type { Outcome } from './grade.js';

/**
 * Build an address → outcomes lookup from the tracked-call record.
 *
 * Rebuilt periodically rather than per-trade: the record changes on the
 * performance tracker's own cadence, and the v2 pipeline asks for outcomes on
 * every evaluated trade — scanning every call each time would be wasted work on
 * the listener's path.
 */
export class WalletOutcomes {
  private byWalletId = new Map<string, Outcome[]>();
  private builtAt = 0;
  private calls = 0;

  constructor(
    private readonly performance: PerformanceTracker,
    /** How stale the index may get before a rebuild. */
    private readonly ttlMs = 60_000,
  ) {}

  /**
   * Outcomes for an address, freshest first. Empty when the wallet has no
   * resolved calls — which grades `U`, not `F`. An absent record is a gap in
   * evidence, never a bad result.
   */
  for(address: string): readonly Outcome[] {
    this.maybeRebuild();
    return this.byWalletId.get(walletId(address)) ?? [];
  }

  /** For the status endpoint: how much of the record is actually usable. */
  stats(): { wallets: number; calls: number; builtAt: number } {
    this.maybeRebuild();
    return { wallets: this.byWalletId.size, calls: this.calls, builtAt: this.builtAt };
  }

  private maybeRebuild(): void {
    const now = Date.now();
    if (now - this.builtAt < this.ttlMs) return;
    this.builtAt = now;

    const next = new Map<string, Outcome[]>();
    let counted = 0;
    for (const call of this.performance.list()) {
      const outcome = toOutcome(call);
      if (!outcome) continue;
      const ids = call.walletIds ?? [];
      if (ids.length === 0) continue; // pre-walletIds call: unattributable, so uncounted
      counted++;
      for (const id of ids) {
        const list = next.get(id) ?? [];
        list.push(outcome);
        next.set(id, list);
      }
    }
    for (const list of next.values()) list.sort((a, b) => b.at - a.at);
    this.byWalletId = next;
    this.calls = counted;
  }
}

/**
 * One call → one outcome, or null when the call cannot yet be judged.
 *
 * A call still inside its tracking window is deliberately excluded: counting a
 * ten-minute-old call as a completed result would let a wallet's grade swing on
 * a token that has not finished moving.
 */
export function toOutcome(call: TrackedCall): Outcome | null {
  if (!call.closed) return null;
  if (!Number.isFinite(call.maxGainPct)) return null;
  return {
    at: call.entryAt,
    // maxGainPct is a percentage above entry; the grader wants a multiple.
    peakMultiple: 1 + call.maxGainPct / 100,
    // A call that ended down ~99% is the signature of a rug, and following rugs
    // is the failure that actually costs the account — so it is graded as one.
    ruggedAfter: call.lastGainPct <= -90,
  };
}

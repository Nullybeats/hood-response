/**
 * Wallet outcomes, derived from v2's OWN outcome ledger.
 *
 * This is what turns a grade from an assumption into a measurement. Without it
 * every wallet is `U` and the `who` dial — 40% of the score — stays dark.
 *
 * WHY NOT THE LEGACY TRACKER. This read `PerformanceTracker` until it was
 * measured against reality: that tracker only follows LEGACY alerts, and the
 * feed fires almost none. Live at the time of the change: 12 calls across 7
 * wallets, against a `MIN_SAMPLE` of 5 per wallet — every wallet `U`, with no
 * path to a first grade. The ledger, by contrast, records every v2 decision,
 * has no daily reset, and is the only record of what v2 itself has seen.
 *
 * WHAT A GRADE MEANS HERE. Allocations, not purchases. The engine sees ~zero
 * verified buys from watched wallets and a steady stream of distributions, so a
 * buy-based grade would never populate. The question this answers is therefore
 * "when this wallet is ALLOCATED a token, does it pump?" — which is the 47e1
 * signal, and a genuinely different claim from "this wallet trades well". The
 * grade reasons say so out loud; a measurement that silently changes meaning is
 * how "🛡️ Safe" over an unchecked token happened.
 *
 * The join is the lowercased address. The old `walletId()` digest indirection is
 * gone with the tracker that required it — `TrackedCall` carried only digests,
 * while a `LedgerRecord` carries the address itself.
 *
 * Two honest limits, visible in the output rather than papered over:
 *
 *  - A wave credits EVERY wallet in the cohort with the same outcome. We cannot
 *    know which of them mattered, and refusing to attribute at all would discard
 *    most of the record. Wallets that only ride along in waves inherit the
 *    wave's results — a real weakness, and why grades need a sample floor and
 *    why crowd GPA is computed separately rather than folded into a wallet's own
 *    grade.
 *  - A record that never became quotable is skipped entirely, not counted as a
 *    loss. See `toOutcome`.
 *
 * Outcomes are keyed by peak, not final price, to match the strategy: a call
 * that ran 3x and gave it back was a good call badly exited, and grading it as a
 * loss would blame the wallet for our own exit logic.
 */

import { walletId } from '../../walletId.js';
import type { LedgerRecord, OutcomeLedger } from '../ledger.js';
import { gradeWallet, type Outcome } from './grade.js';
import type { Grade } from './types.js';

/** What this index measures. Distributions are the only populated basis today. */
export type GradeBasis = 'distribution' | 'verified-buy';

/**
 * Build an address → outcomes lookup from the outcome ledger.
 *
 * Rebuilt periodically rather than per-trade: the ledger changes on its own
 * sampling cadence, and the v2 pipeline asks for outcomes on every evaluated
 * trade — scanning every record each time would be wasted work on the listener's
 * path.
 */
export class WalletOutcomes {
  private byWallet = new Map<string, Outcome[]>();
  private builtAt = 0;
  private records = 0;

  constructor(
    /**
     * Undefined when the ledger is switched off — then there is no outcome
     * record at all and every wallet grades `U`, which is the honest answer
     * rather than a fabricated one.
     */
    private readonly ledger: OutcomeLedger | undefined,
    /** Which event type grades are earned from. */
    private readonly basis: GradeBasis = 'distribution',
    /** How stale the index may get before a rebuild. */
    private readonly ttlMs = 60_000,
  ) {}

  /**
   * Outcomes for an address, freshest first. Empty when the wallet has no
   * resolved records — which grades `U`, not `F`. An absent record is a gap in
   * evidence, never a bad result.
   */
  for(address: string): readonly Outcome[] {
    this.maybeRebuild();
    return this.byWallet.get(address.toLowerCase()) ?? [];
  }

  /** For the status endpoint: how much of the record is actually usable. */
  stats(): { wallets: number; calls: number; builtAt: number; basis: GradeBasis } {
    this.maybeRebuild();
    return { wallets: this.byWallet.size, calls: this.records, builtAt: this.builtAt, basis: this.basis };
  }

  /**
   * Every wallet with any record, graded, best first.
   *
   * A grade nobody can read the justification for is not verifiable — and while
   * every wallet still reads `U`, this is the surface that shows WHY (how many
   * outcomes it has, and how many it needs) instead of leaving an empty column
   * that looks like a broken pipeline.
   *
   * Addresses are NOT returned: `walletId` is the opaque handle every other
   * aggregate endpoint here exposes, and the rule holds.
   */
  reportCard(now: number, limit = 100): {
    walletId: string;
    grade: Grade;
    index: number | null;
    sample: number;
    reason: string;
  }[] {
    this.maybeRebuild();
    const noun = this.basis === 'distribution' ? 'allocations' : 'buys';
    return [...this.byWallet.entries()]
      .map(([address, outcomes]) => {
        const g = gradeWallet(outcomes, now, noun);
        return { walletId: walletId(address), grade: g.grade, index: g.index, sample: g.sample, reason: g.reason };
      })
      .sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || b.sample - a.sample)
      .slice(0, limit);
  }

  private maybeRebuild(): void {
    const now = Date.now();
    if (now - this.builtAt < this.ttlMs) return;
    this.builtAt = now;

    const next = new Map<string, Outcome[]>();
    let counted = 0;
    // The ledger is bounded (maxRecords) so this is a full scan of a small set.
    for (const record of this.ledger?.list(Number.MAX_SAFE_INTEGER) ?? []) {
      if (record.eventType !== this.basis) continue;
      const outcome = toOutcome(record);
      if (!outcome) continue;
      counted++;
      // Credit the whole cohort. `cohortWallets` always contains the trigger
      // wallet; records written before the field existed fall back to it.
      const wallets = record.cohortWallets?.length ? record.cohortWallets : [record.wallet];
      for (const w of wallets) {
        const key = w.toLowerCase();
        const list = next.get(key) ?? [];
        list.push(outcome);
        next.set(key, list);
      }
    }
    for (const list of next.values()) list.sort((a, b) => b.at - a.at);
    this.byWallet = next;
    this.records = counted;
  }
}

/**
 * One ledger record → one outcome, or null when it cannot yet be judged.
 *
 * Two exclusions, both deliberate:
 *
 *  - An OPEN record is excluded. `maxGainPct` is a running maximum, so grading
 *    on it would let a wallet's grade swing on a token that has not finished
 *    moving. This imposes a real latency floor: one outcome per record, no
 *    sooner than the ledger's tracking window.
 *  - An UNPRICED record is excluded rather than counted as a flat result. A
 *    record that closed `no-price` carries `maxGainPct: 0`, which reads as a
 *    1.0x peak and falls below the hit threshold — so counting it would grade a
 *    wallet DOWN for our own inability to quote its token. Same discipline the
 *    scorer applies to an unknown dial: dropped, never zeroed.
 */
export function toOutcome(record: LedgerRecord): Outcome | null {
  if (!record.closed) return null;
  if (record.entryPrice == null) return null;
  if (!Number.isFinite(record.maxGainPct)) return null;
  return {
    at: record.firedAt,
    // maxGainPct is a percentage above entry; the grader wants a multiple.
    peakMultiple: 1 + record.maxGainPct / 100,
    // A token that ended down ~99% is the signature of a rug, and following rugs
    // is the failure that actually costs the account — so it is graded as one.
    ruggedAfter: record.lastGainPct <= -90,
  };
}

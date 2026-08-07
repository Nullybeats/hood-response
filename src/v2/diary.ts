/**
 * The decision diary: what the brain decided, and why — including the skips.
 *
 * This is the feature the audit kept arriving at. Every leak found in the legacy
 * engine was invisible for the same structural reason: decisions were silent.
 * SOLO swallowed ENTRY for months and the only trace was an absence — no alert,
 * no log line, nothing to notice. PRIME-only bought nothing for a day and looked
 * identical to a quiet market. The reasons existed as strings inside the engine
 * (`'not a PRIME alert'`, `'kind X not in buy list'`) and were thrown away.
 *
 * So the diary records a verdict for EVERY trade the pipeline sees, in all four
 * outcomes — matched, skipped, waiting, blocked — with the reason attached.
 *
 * Near-misses are the point. "skipped — score 76, needed 80" repeated across a
 * week is an argument about one number, backed by evidence. The same week with
 * silent skips is a shrug.
 *
 * In memory and bounded: this is a live operational view, while the durable
 * record is the journal, which the same pipeline writes for replay. Losing the
 * diary on restart costs nothing the journal does not already hold.
 */

import type { FactSheet } from './facts/sheet.js';
import type { GateVerdict } from './gate.js';
import type { LaneVerdict } from './lanes.js';
import type { ScoreResult } from './score.js';

export type DiaryOutcome =
  /** At least one lane matched. */
  | 'matched'
  /** Facts settled, but no lane wanted it. The near-miss case. */
  | 'skipped'
  /** Facts unresolved; the gate asked for a retry. */
  | 'waiting'
  /** The gate blocked it — a proven negative, or unresolved past the budget. */
  | 'blocked';

export interface DiaryEntry {
  at: number;
  token: string;
  tokenSymbol: string;
  wallet: string;
  txHash: string;
  outcome: DiaryOutcome;
  /** One line, human-first. This is what the dashboard shows. */
  reason: string;
  score: number | null;
  /** Lanes that matched, by id. */
  matchedLanes: string[];
  /**
   * Closest lane that did not match, and by how much — the tuning signal.
   * Null when a lane matched or nothing was close.
   */
  nearMiss: { laneId: string; reason: string } | null;
  /** The full per-lane detail, kept for the drill-down view. */
  lanes: LaneVerdict[];
  /** Config in force when this was decided, so an old verdict stays interpretable. */
  configSnapshot: Record<string, unknown>;
}

export interface DiaryOptions {
  /** Bounded so a busy day cannot grow without limit. */
  maxEntries: number;
}

export const DEFAULT_DIARY_OPTIONS: DiaryOptions = { maxEntries: 2_000 };

/**
 * Build the entry for one evaluated trade.
 *
 * Pure, so the same inputs always produce the same entry and a replay of the
 * journal reconstructs the diary exactly.
 */
export function buildEntry(
  sheet: FactSheet,
  gateVerdict: GateVerdict,
  score: ScoreResult,
  lanes: readonly LaneVerdict[],
  configSnapshot: Record<string, unknown> = {},
): DiaryEntry {
  const matched = lanes.filter((l) => l.matched).map((l) => l.laneId);

  let outcome: DiaryOutcome;
  let reason: string;
  if (gateVerdict.decision === 'retry') {
    outcome = 'waiting';
    reason = gateVerdict.reason;
  } else if (gateVerdict.decision === 'block') {
    outcome = 'blocked';
    reason = gateVerdict.reason;
  } else if (matched.length > 0) {
    outcome = 'matched';
    reason = `${matched.join(', ')} — ${lanes.find((l) => l.matched)!.reason}`;
  } else {
    outcome = 'skipped';
    reason = closest(lanes)?.reason ?? 'no lane matched';
  }

  return {
    at: sheet.at,
    token: sheet.token,
    tokenSymbol: sheet.tokenSymbol,
    wallet: sheet.wallet,
    txHash: sheet.txHash,
    outcome,
    reason,
    score: score.score,
    matchedLanes: matched,
    nearMiss:
      outcome === 'skipped' && closest(lanes)
        ? { laneId: closest(lanes)!.laneId, reason: closest(lanes)!.reason }
        : null,
    lanes: [...lanes],
    configSnapshot,
  };
}

/**
 * The lane that came closest.
 *
 * Ranked by how many conditions were met, with a lane held up only by an unknown
 * treated as further away than one that simply failed a threshold: the first is a
 * missing-evidence problem, the second is a real "not good enough", and conflating
 * them is how a data outage reads as a quiet market.
 */
function closest(lanes: readonly LaneVerdict[]): LaneVerdict | null {
  const candidates = lanes.filter((l) => !l.matched);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const met = (l: LaneVerdict) => l.results.filter((r) => r.outcome === 'met').length;
    if (met(b) !== met(a)) return met(b) - met(a);
    return Number(a.blockedByUnknown) - Number(b.blockedByUnknown);
  })[0]!;
}

/** Bounded, newest-first store of recent decisions. */
export class Diary {
  private entries: DiaryEntry[] = [];

  constructor(private readonly opts: DiaryOptions = DEFAULT_DIARY_OPTIONS) {}

  record(entry: DiaryEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.opts.maxEntries) this.entries.length = this.opts.maxEntries;
  }

  /** Newest first, optionally filtered by outcome. */
  recent(limit = 100, outcome?: DiaryOutcome): DiaryEntry[] {
    const src = outcome ? this.entries.filter((e) => e.outcome === outcome) : this.entries;
    return src.slice(0, limit);
  }

  /**
   * Counts by outcome, plus the near-miss leaderboard.
   *
   * The leaderboard answers the question the legacy engine could never be asked:
   * "which rule is turning away the most trades, and by how much?"
   */
  summary(): {
    counts: Record<DiaryOutcome, number>;
    nearMissesByLane: { laneId: string; n: number; examples: string[] }[];
  } {
    const counts: Record<DiaryOutcome, number> = { matched: 0, skipped: 0, waiting: 0, blocked: 0 };
    const byLane = new Map<string, { n: number; examples: string[] }>();

    for (const e of this.entries) {
      counts[e.outcome]++;
      if (e.nearMiss) {
        const cur = byLane.get(e.nearMiss.laneId) ?? { n: 0, examples: [] };
        cur.n++;
        if (cur.examples.length < 3) cur.examples.push(`${e.tokenSymbol}: ${e.nearMiss.reason}`);
        byLane.set(e.nearMiss.laneId, cur);
      }
    }

    return {
      counts,
      nearMissesByLane: [...byLane.entries()]
        .map(([laneId, v]) => ({ laneId, ...v }))
        .sort((a, b) => b.n - a.n),
    };
  }

  get size(): number {
    return this.entries.length;
  }
}

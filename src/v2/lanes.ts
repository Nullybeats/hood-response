/**
 * Lanes: filters written as sentences over facts.
 *
 * The legacy filter was a comma-separated string of kind names — `"ENTRY,SOLO"` —
 * accepted unvalidated at every layer. `"ENTREE"` was stored happily and matched
 * nothing forever; `"SELL"` would have made the sniper buy into dumps. Worse, the
 * kinds it selected were themselves competing classifications, so choosing two of
 * them meant choosing two things that could suppress each other.
 *
 * A lane instead states its requirements over the fact sheet:
 *
 *   Earliest-entry:  A/B wallet, first-ever buy, pair under 48h, score >= 80
 *   Proven-wallets:  A wallet, any cap
 *   Crowd-confirm:   2+ watched wallets, crowd GPA >= 3.0 (B average)
 *
 * Because a sheet is a single object rather than a race between candidates, any
 * number of lanes may match the same trade. Nothing competes.
 *
 * Conditions are DATA, not predicates, for three reasons: they serialise into the
 * diary so a verdict records the exact rule that produced it; they render as
 * English on the dashboard without a second implementation drifting from the
 * first; and an unknown fact yields a distinct `unknown` outcome rather than
 * silently reading as false — the same discipline as the gate.
 */

import type { CapBand, FactSheet } from './facts/sheet.js';
import { isKnown, type Grade } from './facts/types.js';
import type { ScoreResult } from './score.js';

export type Condition =
  | { kind: 'walletGrade'; in: readonly Grade[] }
  | { kind: 'firstBuy'; is: boolean }
  | { kind: 'pairAgeHoursBelow'; hours: number }
  | { kind: 'capBand'; in: readonly CapBand[] }
  | { kind: 'crowdSizeAtLeast'; n: number }
  | { kind: 'crowdGpaAtLeast'; gpa: number }
  | { kind: 'scoreAtLeast'; score: number };

export interface Lane {
  id: string;
  emoji: string;
  name: string;
  /** Plain-English rendering, kept beside the conditions it describes. */
  sentence: string;
  conditions: readonly Condition[];
}

/** Outcome of one condition against one sheet. */
type CheckOutcome = 'met' | 'unmet' | 'unknown';

export interface ConditionResult {
  condition: Condition;
  outcome: CheckOutcome;
  /** e.g. "score 76, needed 80" — the near-miss detail that makes tuning possible. */
  detail: string;
}

export interface LaneVerdict {
  laneId: string;
  matched: boolean;
  /** True when the only thing standing in the way is an unknown fact, not a failed test. */
  blockedByUnknown: boolean;
  results: ConditionResult[];
  /** One line for the diary: why it matched, or the first reason it did not. */
  reason: string;
}

/**
 * [config] Starting lanes. Each replaces a legacy kind, but as a statement about
 * evidence rather than a label. Tunable from the journal — these thresholds are a
 * starting point, not a proven optimum.
 */
export const DEFAULT_LANES: readonly Lane[] = [
  {
    id: 'earliest-entry',
    emoji: '🌱',
    name: 'Earliest entry',
    sentence: "an A or B wallet's first-ever buy of a pair under 48h old, scoring 80+",
    conditions: [
      { kind: 'walletGrade', in: ['A', 'B'] },
      { kind: 'firstBuy', is: true },
      { kind: 'pairAgeHoursBelow', hours: 48 },
      { kind: 'scoreAtLeast', score: 80 },
    ],
  },
  {
    id: 'proven-wallets',
    emoji: '🎯',
    name: 'Proven wallets',
    sentence: 'any buy by an A-grade wallet, scoring 70+',
    conditions: [
      { kind: 'walletGrade', in: ['A'] },
      { kind: 'scoreAtLeast', score: 70 },
    ],
  },
  {
    id: 'crowd-confirm',
    emoji: '👥',
    name: 'Crowd confirm',
    sentence: 'two or more watched wallets buying, averaging a B grade or better',
    conditions: [
      { kind: 'crowdSizeAtLeast', n: 2 },
      { kind: 'crowdGpaAtLeast', gpa: 3.0 },
    ],
  },
] as const;

/** Evaluate one lane. Pure — everything time-dependent already lives on the sheet. */
export function evaluateLane(lane: Lane, sheet: FactSheet, score: ScoreResult): LaneVerdict {
  const results = lane.conditions.map((c) => check(c, sheet, score));
  const failed = results.find((r) => r.outcome === 'unmet');
  const unknown = results.find((r) => r.outcome === 'unknown');
  const matched = !failed && !unknown;

  return {
    laneId: lane.id,
    matched,
    // Distinguishing these two is the point: "we could not tell" is a gap in
    // evidence to go and close, while "it did not qualify" is a working filter.
    blockedByUnknown: !failed && unknown != null,
    results,
    reason: matched
      ? `matched: ${results.map((r) => r.detail).join(', ')}`
      : (failed ?? unknown)!.detail,
  };
}

export function evaluateLanes(
  sheet: FactSheet,
  score: ScoreResult,
  lanes: readonly Lane[] = DEFAULT_LANES,
): LaneVerdict[] {
  return lanes.map((l) => evaluateLane(l, sheet, score));
}

function check(condition: Condition, sheet: FactSheet, score: ScoreResult): ConditionResult {
  const r = (outcome: CheckOutcome, detail: string): ConditionResult => ({ condition, outcome, detail });

  switch (condition.kind) {
    case 'walletGrade': {
      if (!isKnown(sheet.walletGrade)) return r('unknown', `wallet ungraded (${sheet.walletGradeReason})`);
      const g = sheet.walletGrade.value;
      return condition.in.includes(g)
        ? r('met', `${g} wallet`)
        : r('unmet', `wallet is ${g}, needed ${condition.in.join('/')}`);
    }
    case 'firstBuy': {
      const v = sheet.firstBuy.value === true;
      return v === condition.is
        ? r('met', condition.is ? 'first buy' : 'not a first buy')
        : r('unmet', condition.is ? 'wallet has bought this token before' : 'is a first buy');
    }
    case 'pairAgeHoursBelow': {
      if (!isKnown(sheet.pairAgeHours)) return r('unknown', 'pair age unknown');
      const h = sheet.pairAgeHours.value;
      return h < condition.hours
        ? r('met', `pair ${Math.round(h)}h old`)
        : r('unmet', `pair ${Math.round(h)}h old, needed under ${condition.hours}h`);
    }
    case 'capBand': {
      if (!isKnown(sheet.capBand)) return r('unknown', 'market cap unknown');
      const b = sheet.capBand.value;
      return condition.in.includes(b)
        ? r('met', `${b} cap`)
        : r('unmet', `${b} cap, needed ${condition.in.join('/')}`);
    }
    case 'crowdSizeAtLeast': {
      const n = sheet.crowdSize.value ?? 0;
      return n >= condition.n
        ? r('met', `${n} wallets`)
        : r('unmet', `${n} wallet(s), needed ${condition.n}`);
    }
    case 'crowdGpaAtLeast': {
      if (!isKnown(sheet.crowdGpa)) return r('unknown', 'no graded wallets in the crowd');
      const g = sheet.crowdGpa.value;
      return g >= condition.gpa
        ? r('met', `crowd GPA ${g.toFixed(1)}`)
        : r('unmet', `crowd GPA ${g.toFixed(1)}, needed ${condition.gpa.toFixed(1)}`);
    }
    case 'scoreAtLeast': {
      if (score.score == null) return r('unknown', 'score could not be computed');
      // The near-miss line. "score 76, needed 80" is what turns a week of skips
      // into a decision about one number, instead of a mystery.
      return score.score >= condition.score
        ? r('met', `score ${score.score}`)
        : r('unmet', `score ${score.score}, needed ${condition.score}`);
    }
  }
}

/** English rendering of a condition, for the dashboard. One implementation, no drift. */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'walletGrade':
      return `wallet graded ${c.in.join(' or ')}`;
    case 'firstBuy':
      return c.is ? 'first-ever buy of this token' : 'not a first buy';
    case 'pairAgeHoursBelow':
      return `pair under ${c.hours}h old`;
    case 'capBand':
      return `${c.in.join(' or ')} market cap`;
    case 'crowdSizeAtLeast':
      return `at least ${c.n} watched wallets`;
    case 'crowdGpaAtLeast':
      return `crowd averaging ${c.gpa.toFixed(1)} GPA`;
    case 'scoreAtLeast':
      return `score at least ${c.score}`;
  }
}

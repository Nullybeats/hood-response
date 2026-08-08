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

import type { WalletTier } from '../types.js';
import type { CapBand, FactSheet, SheetEventType } from './facts/sheet.js';
import { isKnown, type Grade } from './facts/types.js';
import type { ScoreResult } from './score.js';

export type Condition =
  | { kind: 'eventType'; is: SheetEventType }
  | { kind: 'seedTierIn'; in: readonly WalletTier[] }
  | { kind: 'walletGrade'; in: readonly Grade[] }
  | { kind: 'firstBuy'; is: boolean }
  | { kind: 'pairAgeHoursBelow'; hours: number }
  | { kind: 'capBand'; in: readonly CapBand[] }
  /**
   * A FLOOR on entry market cap, in USD.
   *
   * `capBand` alone is a ceiling wearing a band's clothes: `micro` is defined as everything up to
   * $125,000, so `capBand: [micro, small]` accepts $0 through $1M and a token at its launch seed
   * price passes as easily as an established one. The legacy engine had an explicit
   * `ALERT_MIN_MARKETCAP` of $25,000 and a `SOLO_MIN/MAX` window of $25k–$125k; the v2 rebuild kept
   * the ceiling and dropped the floor.
   *
   * [verified 2026-08-08, 275 archived calls] Below $25k: 20 calls, **zero** wins, +1.4% average
   * peak. At or above: 255 calls, 96 wins, ~+82% average peak. The boundary was derived from our
   * own archive and independently matches the number the legacy engine already used.
   */
  | { kind: 'capAtLeast'; usd: number }
  | { kind: 'crowdSizeAtLeast'; n: number }
  | { kind: 'crowdGpaAtLeast'; gpa: number }
  /**
   * A ceiling on how many watched wallets touched the token in the window.
   *
   * The mirror of `crowdSizeAtLeast`, and it exists because 47e1's record says
   * the two are opposite signals: solo allocations won 90% of the time averaging
   * +234%, while multi-wallet ones won 0%. One leaderboard wallet being seeded is
   * a launch team's deliberate act; forty wallets receiving the same token in the
   * same minute is a marketing airdrop. Without this the lane cannot tell them
   * apart, and the airdrops are the bulk of the volume.
   */
  | { kind: 'cohortAtMost'; n: number }
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
      { kind: 'eventType', is: 'verified-buy' },
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
      { kind: 'eventType', is: 'verified-buy' },
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
      { kind: 'eventType', is: 'verified-buy' },
      { kind: 'crowdSizeAtLeast', n: 2 },
      { kind: 'crowdGpaAtLeast', gpa: 3.0 },
    ],
  },
  {
    // The 47e1 signal, made explicit. Its winners (222 +435%, CHILL +359%,
    // UFROG +187%) were all alpha-seed wallets RECEIVING a young low-cap token
    // — allocations, not buys (verified on-chain). This lane paper-tracks that
    // exact pattern so it can be measured against 47e1's own call record.
    // Seed tier, not grade, is deliberate: grades are mostly U while the
    // outcome record accrues, and the lane would starve for weeks. [config]
    //
    // SOLO is load-bearing, not a threshold to nudge. In 47e1's record a single
    // seeded wallet won 90% of the time (+234% average) and two or more won 0%.
    // Those are different events wearing the same shape: a deliberate seeding
    // versus a marketing airdrop. Without `cohortAtMost` the lane matched both,
    // which is most of why it fired ~17 times an hour against 47e1's ~1.9.
    //
    // The score floor is the other half. A matched allocation could carry a null
    // score, which downstream renders as "—" and silently suppresses the alert
    // tier entirely — a signal that fires and is never seen.
    //
    // THE CAP FLOOR IS LOAD-BEARING. Without it this lane spent its first day calling tokens at
    // their ~$2,600 launch seed price: 13 of 15 calls entered between $2,601 and $2,662 across 12
    // distinct tokens, and almost every one peaked at exactly +0.0% — nobody ever bought them. The
    // two that did trade went −76.6% and −23.5%. A token at its launch cap has no market to be
    // right about, and this lane's premise is that a seeded wallet knows something the market does
    // not yet — which requires there to BE a market.
    id: 'allocation',
    emoji: '🎁',
    name: 'Allocation',
    sentence:
      'ONE alpha/beta-seed wallet RECEIVES a token over $25k and under 48h old, at micro/small cap, scoring 60+',
    conditions: [
      { kind: 'eventType', is: 'distribution' },
      { kind: 'seedTierIn', in: ['alpha', 'beta'] },
      { kind: 'cohortAtMost', n: 1 },
      { kind: 'pairAgeHoursBelow', hours: 48 },
      { kind: 'capAtLeast', usd: 25_000 },
      { kind: 'capBand', in: ['micro', 'small'] },
      { kind: 'scoreAtLeast', score: 60 },
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
    case 'eventType': {
      // Always known — how an event entered is never a mystery. This is the
      // guard that keeps buy lanes off distributions and vice versa.
      return sheet.eventType === condition.is
        ? r('met', sheet.eventType)
        : r('unmet', `${sheet.eventType}, lane wants ${condition.is}`);
    }
    case 'seedTierIn': {
      if (!isKnown(sheet.walletSeedTier)) return r('unknown', 'wallet not in the seed holder catalog');
      const t = sheet.walletSeedTier.value;
      return condition.in.includes(t)
        ? r('met', `${t}-seed wallet`)
        : r('unmet', `${t}-seed wallet, needed ${condition.in.join('/')}`);
    }
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
    case 'capAtLeast': {
      // Fails closed on an unknown cap, exactly as the gate does. "We could not price it" is not
      // evidence that it clears the floor — and an unpriced token is precisely the brand-new coin
      // this floor exists to keep out.
      if (!isKnown(sheet.marketCap)) return r('unknown', 'market cap unknown');
      const c = sheet.marketCap.value;
      return c >= condition.usd
        ? r('met', `$${Math.round(c).toLocaleString('en-US')} cap`)
        : r('unmet', `$${Math.round(c).toLocaleString('en-US')} cap, needed at least $${condition.usd.toLocaleString('en-US')}`);
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
    case 'cohortAtMost': {
      // cohortSize, NOT crowdSize: crowdSize counts wallets that chose to buy
      // and is always 1 for an allocation, which would make this condition a
      // silent no-op on the exact event type it exists to filter.
      const n = sheet.cohortSize.value ?? 1;
      return n <= condition.n
        ? r('met', n === 1 ? 'solo' : `${n} wallets`)
        : r('unmet', `${n} wallets in the window, needed at most ${condition.n}`);
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
    case 'eventType':
      return c.is === 'distribution' ? 'wallet RECEIVES the token (allocation)' : c.is.replace('-', ' ');
    case 'seedTierIn':
      return `${c.in.join('/')}-seed wallet (holder rank, not a grade)`;
    case 'walletGrade':
      return `wallet graded ${c.in.join(' or ')}`;
    case 'firstBuy':
      return c.is ? 'first-ever buy of this token' : 'not a first buy';
    case 'pairAgeHoursBelow':
      return `pair under ${c.hours}h old`;
    case 'capAtLeast':
      return `market cap at least $${c.usd.toLocaleString('en-US')}`;
    case 'capBand':
      return `${c.in.join(' or ')} market cap`;
    case 'crowdSizeAtLeast':
      return `at least ${c.n} watched wallets`;
    case 'cohortAtMost':
      return c.n === 1 ? 'no other watched wallet in the window (solo)' : `at most ${c.n} watched wallets`;
    case 'crowdGpaAtLeast':
      return `crowd averaging ${c.gpa.toFixed(1)} GPA`;
    case 'scoreAtLeast':
      return `score at least ${c.score}`;
  }
}

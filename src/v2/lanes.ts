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
 *   Solo buy:       one watched wallet buys, $25k-$125k cap
 *   Fresh entry:    an alpha/beta wallet's first-ever buy of a pair under 48h
 *   Crowd confirm:  2+ watched wallets buying
 *   Allocation:     one alpha/beta wallet RECEIVES a token (v2's own addition)
 *
 * Because a sheet is a single object rather than a race between candidates, any
 * number of lanes may match the same trade. Nothing competes.
 *
 * ## Lanes describe SHAPE. They do not judge quality.
 *
 * The first three mirror the legacy engine's three rules deliberately, because that engine's record
 * is the only evidence either of us has. The v2 rebuild re-derived them from scratch instead and
 * invented three gates the original never had — a wallet GRADE requirement, a SCORE floor, and a
 * pair-freshness rule applied to everything. Each one looked prudent and each one was wrong:
 *
 *  - **Grade was circular.** A grade needs five recorded outcomes; outcomes come from the ledger;
 *    the ledger follows decisions; two lanes needed a grade to decide. A wallet nobody had graded
 *    was invisible forever, so the system could never bootstrap. [verified 2026-08-08] Replaying a
 *    real +357% call: `skipped, score 82 — wallet ungraded`. Same trade, grade supplied, nothing
 *    else changed: matched.
 *  - **Score floors were invented.** The legacy engine ran `ALERT_MIN_CONVICTION: 0` — its score was
 *    a LABEL that rode along on the alert, never a gate. v2 turned it into 80/70/60. [verified] a
 *    real +18.5% call died on `score 79, needed 80`, one point under a number nobody calibrated.
 *  - **Grade was then counted twice more.** It is the `who` dial at weight 0.40 (renormalised as
 *    high as 0.62 when other dials drop out) AND the sniper's `allowedWalletGrades` filter. A lane
 *    that gated on grade and then applied a score floor was testing the same fact twice and calling
 *    the second test independent.
 *
 * So quality lives in the SCORE, which travels on the match and drops dials it cannot measure rather
 * than zeroing them; and appetite lives in the OPERATOR's settings (`enabledLanes`, `minScore`,
 * `allowedWalletGrades`), where a person chooses. A grade is a win-rate label, not a permission.
 *
 * The one deliberate exception is the `$25k` market-cap FLOOR, which is kept on every lane. It is
 * the single threshold here with direct evidence behind it, it came from the legacy engine, and it
 * is what actually stops the launchpad-seed spam — see `capAtLeast` below.
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
  /**
   * DELIBERATELY UNUSED BY `DEFAULT_LANES`. Read the header before adding it back.
   *
   * A grade is earned from five recorded outcomes, outcomes are recorded from decisions, and a
   * decision gated on a grade cannot happen — so this condition makes a lane unable to start. It is
   * kept as vocabulary because an operator lane built later, on a wallet set that is ALREADY
   * graded, is a legitimate use. It is not legitimate on a lane that has to bootstrap.
   *
   * To select on grade, use the sniper's `allowedWalletGrades` instead: same effect, but a person
   * chose it and can see it, and the lane keeps firing so the record still accrues.
   */
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
  /**
   * A FLOOR on pair age — the legacy `PAIR_MIN_AGE_MINUTES: 30` anti-snipe guard, which the v2
   * rebuild dropped entirely. v2 had only a maximum age, so it would happily call a pair thirty
   * seconds old: the window where a launch has no price history, no liquidity depth worth the name,
   * and nothing to distinguish a real launch from a rug being loaded.
   *
   * PASSES ON UNKNOWN, exactly as the legacy gate does (`swarm.pairAgeHours != null` guards it).
   * That is deliberate and it is the opposite of `capAtLeast`: a floor whose whole purpose is to
   * exclude the youngest pairs must not also exclude every pair whose age we have not established,
   * or a slow `pairCreatedAt` lookup silently becomes a second market-cap outage.
   */
  | { kind: 'pairAgeMinutesAtLeast'; minutes: number }
  /**
   * A FLOOR on the buy's USD size — the legacy `IGNORE_DUST_USD: 25` dust filter.
   *
   * Also PASSES ON UNKNOWN, and for the same reason the legacy check does (`usdValue != null`): on
   * exactly the brand-new pairs this system hunts, `usdValue` is null at detection time, so failing
   * closed here would reject the freshest coins — the ones the whole strategy is about.
   */
  | { kind: 'buyUsdAtLeast'; usd: number }
  | { kind: 'crowdSizeAtLeast'; n: number }
  /** DELIBERATELY UNUSED BY `DEFAULT_LANES`, and circular for the same reason as `walletGrade`:
   *  a crowd average needs graded wallets before it can be computed at all. */
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
    // The legacy engine's `solo-lowcap` rule, restated over facts. It is the workhorse: 60 of its
    // last 100 alerts and, in the all-time archive, 158 calls at a 43% win rate and +83% average
    // peak. 83% of its buy alerts are a single wallet, and under the previous v2 lanes a solo buy
    // from an ungraded wallet matched NOTHING — the best-evidenced shape in the system had no home.
    //
    // The band IS the legacy `SOLO_MIN/MAX_MARKETCAP` window of $25k-$125k, expressed with the two
    // conditions that already exist: `micro` is defined as everything up to $125,000, so the band
    // plus the floor is exactly that window. No new condition kind is needed.
    //
    // NOTE what is absent, and that it is absent on purpose: no grade, no score floor, no
    // freshness. This lane depends only on `eventType`, `cohortSize` and `marketCap` — the first
    // two are always `measured` and the third is a gate requirement, so it is the one lane that
    // CANNOT be killed by an unknown fact. That property is deliberate; keep it when tuning.
    id: 'solo-buy',
    emoji: '🎯',
    name: 'Solo buy',
    sentence: 'ONE watched wallet BUYS a coin between $25k and $125k market cap, pair 30m+ old',
    conditions: [
      { kind: 'eventType', is: 'verified-buy' },
      { kind: 'cohortAtMost', n: 1 },
      { kind: 'capAtLeast', usd: 25_000 },
      { kind: 'capBand', in: ['micro'] },
      { kind: 'pairAgeMinutesAtLeast', minutes: 30 },
      { kind: 'buyUsdAtLeast', usd: 25 },
    ],
  },
  {
    // The legacy `fresh-pair-entry` rule: 46 archived calls at a 48% win rate and +113% average
    // peak — the best RATE of the three shapes, on a third of solo's volume.
    //
    // Freshness belongs HERE and nowhere else. The v2 rebuild applied a 48h pair limit to every buy
    // lane, which is not what the original did and does not match its record: its solo winners had
    // a median pair age of ~98 hours. Seed tier rather than grade, matching the original's
    // `FRESH_ENTRY_TIERS: alpha,beta` — a holder-rank from the catalog, not an earned judgement,
    // so it cannot go circular.
    id: 'fresh-entry',
    emoji: '🌱',
    name: 'Fresh entry',
    sentence: "an alpha/beta wallet's first-ever buy of a pair under 48h old, over $25k",
    conditions: [
      { kind: 'eventType', is: 'verified-buy' },
      { kind: 'firstBuy', is: true },
      { kind: 'seedTierIn', in: ['alpha', 'beta'] },
      { kind: 'pairAgeHoursBelow', hours: 48 },
      { kind: 'pairAgeMinutesAtLeast', minutes: 30 },
      { kind: 'capAtLeast', usd: 25_000 },
      { kind: 'buyUsdAtLeast', usd: 25 },
    ],
  },
  {
    // The legacy `swarm` rule. Kept for completeness and labelled honestly: it is the WEAKEST of
    // the three shapes in the archive — 12 calls, 17% win rate, against solo's 43% and entry's 48%.
    // A small sample, so it is measured rather than dropped, but nobody should read a crowd as
    // stronger evidence than a solo buy here.
    //
    // The crowd-GPA requirement is gone with the other grade gates: it needed graded wallets to
    // compute an average, so it was circular in exactly the same way and would starve for as long.
    id: 'crowd-confirm',
    emoji: '👥',
    name: 'Crowd confirm',
    sentence: 'two or more watched wallets BUYING the same coin over $25k',
    conditions: [
      { kind: 'eventType', is: 'verified-buy' },
      { kind: 'crowdSizeAtLeast', n: 2 },
      { kind: 'capAtLeast', usd: 25_000 },
      { kind: 'pairAgeMinutesAtLeast', minutes: 30 },
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
    case 'pairAgeMinutesAtLeast': {
      // Unknown PASSES — see the type. A floor that also excluded unpriced age would re-create the
      // market-cap outage in a second fact.
      if (!isKnown(sheet.pairAgeHours)) return r('met', 'pair age unknown — floor not applied');
      const mins = sheet.pairAgeHours.value * 60;
      return mins >= condition.minutes
        ? r('met', `pair ${Math.round(mins)}m old`)
        : r('unmet', `pair ${Math.round(mins)}m old, needed at least ${condition.minutes}m`);
    }
    case 'buyUsdAtLeast': {
      // Unknown PASSES — a new pair has no price at detection time, which is not evidence of dust.
      if (!isKnown(sheet.buyUsd)) return r('met', 'buy size unknown — dust floor not applied');
      const usd = sheet.buyUsd.value;
      return usd >= condition.usd
        ? r('met', `$${Math.round(usd).toLocaleString('en-US')} buy`)
        : r('unmet', `$${Math.round(usd).toLocaleString('en-US')} buy, needed at least $${condition.usd}`);
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
    case 'pairAgeMinutesAtLeast':
      return `pair at least ${c.minutes} minutes old`;
    case 'buyUsdAtLeast':
      return `buy worth at least $${c.usd}`;
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

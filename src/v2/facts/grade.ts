/**
 * Wallet grades, earned from measured outcomes.
 *
 * What this replaces: the legacy tier came from `holders.generated.ts`, a static
 * snapshot of top-10 holder rank, and turned into a fixed `confidence` constant
 * (alpha .9, beta .72, chroma .58, delta .45). That constant then fed BOTH
 * `walletQuality` and a factor named `historicalAccuracy` — a name promising
 * outcome data, delivering the same frozen number twice. Live production proved
 * it: across every alert, `historicalAccuracy` only ever emitted 58, 72, 90 or
 * 96. It never once described how a wallet's calls actually performed.
 *
 * A grade here means one thing: this wallet's recent EVENTS OF ONE KIND, and what
 * happened to the price afterwards. Nothing about how large a bag they hold.
 *
 * Three properties the legacy tier could not express:
 *
 *  - `U` (ungraded) is a real answer. Below `MIN_SAMPLE` outcomes there is no
 *    grade, and `U` is treated as unknown everywhere downstream — never as
 *    average, never as good. A new wallet has not earned trust and must not
 *    borrow it from a holder rank.
 *  - Grades decay. A wallet cold for `STALE_DAYS` drifts back to `U`, because a
 *    track record from two months ago is not evidence about today.
 *  - `F` is muting. A wallet that consistently loses money scores zero points and
 *    can never raise a crowd's GPA.
 */

import { GRADE_POINTS, type Grade } from './types.js';

/** One resolved buy: what the wallet bought, and how far it ran afterwards. */
export interface Outcome {
  /** ms epoch of the buy. Recency-weighted, and the basis for staleness. */
  at: number;
  /**
   * Peak return after entry, as a multiple of entry (1.0 = flat, 1.5 = +50%).
   *
   * Peak rather than final: the strategy is fat-tail — a call that ran 3x and
   * gave it back was a good call badly exited, and grading it as a loss would
   * punish the wallet for our exit logic.
   */
  peakMultiple: number;
  /** True when the token later proved to be a rug. Weighted heavily: following rugs is the costly failure. */
  ruggedAfter?: boolean;
}

/** Below this many outcomes a wallet is `U` — ungraded, not average. */
export const MIN_SAMPLE = 5;
/** Outcomes older than this are ignored entirely. */
export const WINDOW_DAYS = 45;
/** With no outcome newer than this, a wallet drifts back to `U`. */
export const STALE_DAYS = 30;
/** Most recent N outcomes considered. */
export const MAX_OUTCOMES = 20;

const DAY_MS = 86_400_000;

/** A buy that peaked at least this far above entry counts as a hit. */
const HIT_THRESHOLD = 1.3;

/**
 * Grade thresholds, expressed on a 0–100 quality index.
 *
 * [config] — a starting point to be tuned against the journal, not a proven
 * optimum. They are stated here as data so tuning is a visible edit rather than
 * a scattering of magic numbers through the scorer.
 */
export const GRADE_CUTOFFS: readonly { min: number; grade: Exclude<Grade, 'U'> }[] = [
  { min: 75, grade: 'A' },
  { min: 55, grade: 'B' },
  { min: 35, grade: 'C' },
  { min: 15, grade: 'D' },
  { min: 0, grade: 'F' },
] as const;

export interface GradeResult {
  grade: Grade;
  /** 0–100 quality index behind the grade. Null when ungraded. */
  index: number | null;
  /** How many outcomes the grade rests on — shown to humans so a thin grade reads as thin. */
  sample: number;
  /** Why, in one line, for the wallet report card. */
  reason: string;
}

/**
 * Grade a wallet from its outcome history.
 *
 * `now` is injected rather than read from the clock so a replay produces the same
 * grade it produced live — the determinism contract the whole harness rests on.
 */
export function gradeWallet(
  outcomes: readonly Outcome[],
  now: number,
  /**
   * What the outcomes are, for the human-readable reason only — never for the
   * maths. Grades are earned from ALLOCATIONS today (the engine sees ~zero
   * verified buys), and "62% hit rate over 8 buys" would be a false description
   * of a record made entirely of airdrops. A measurement that quietly changes
   * meaning is exactly the failure this rebuild exists to stop.
   */
  noun: string = 'allocations',
): GradeResult {
  const fresh = outcomes
    .filter((o) => now - o.at <= WINDOW_DAYS * DAY_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_OUTCOMES);

  if (fresh.length < MIN_SAMPLE) {
    return {
      grade: 'U',
      index: null,
      sample: fresh.length,
      reason: `only ${fresh.length} verified outcome(s); ${MIN_SAMPLE} needed to grade`,
    };
  }

  const newest = fresh[0]!.at;
  if (now - newest > STALE_DAYS * DAY_MS) {
    const days = Math.floor((now - newest) / DAY_MS);
    return {
      grade: 'U',
      index: null,
      sample: fresh.length,
      reason: `no ${noun.replace(/s$/, '')} in ${days} days — track record is stale`,
    };
  }

  // Recency weight: linear from 1.0 (today) down to 0.25 at the window edge, so a
  // wallet that was good in March cannot coast on it through May.
  const weightOf = (o: Outcome): number => {
    const ageDays = (now - o.at) / DAY_MS;
    return Math.max(0.25, 1 - (ageDays / WINDOW_DAYS) * 0.75);
  };

  let weight = 0;
  let hitWeight = 0;
  let peakSum = 0;
  let rugWeight = 0;
  for (const o of fresh) {
    const w = weightOf(o);
    weight += w;
    if (o.peakMultiple >= HIT_THRESHOLD) hitWeight += w;
    // Cap a single monster call: one 50x should not launder a wallet's other
    // nineteen losses into an A. The strategy wants fat tails; the GRADE wants
    // repeatability.
    peakSum += Math.min(o.peakMultiple, 5) * w;
    if (o.ruggedAfter) rugWeight += w;
  }

  const hitRate = hitWeight / weight; // 0..1
  const avgPeak = peakSum / weight; // 1.0 = flat
  const rugRate = rugWeight / weight; // 0..1

  // Hit rate is the backbone (how often they are right); average peak adds how
  // big they are when right; rug-following is a direct, heavy penalty because it
  // is the failure that actually costs the account.
  const index = clamp0to100(hitRate * 60 + Math.min(Math.max(avgPeak - 1, 0), 2) * 20 - rugRate * 40);

  const grade = GRADE_CUTOFFS.find((c) => index >= c.min)!.grade;
  return {
    grade,
    index: Math.round(index),
    sample: fresh.length,
    reason:
      `${Math.round(hitRate * 100)}% hit rate over ${fresh.length} ${noun}, ` +
      `avg peak ${avgPeak.toFixed(2)}x` +
      (rugRate > 0 ? `, ${Math.round(rugRate * 100)}% rugged` : ''),
  };
}

/**
 * Crowd quality as a grade-point average.
 *
 * The legacy engine counted wallets. Three unknown wallets and three proven ones
 * produced the same "3 wallets accumulating" headline, which is how a swarm of
 * nobodies read as conviction. Here an ungraded wallet contributes nothing
 * rather than an implied average, so a crowd of `U`s returns null — "we cannot
 * say", not "average crowd".
 */
export function crowdGpa(grades: readonly Grade[]): { gpa: number | null; graded: number; ungraded: number } {
  const scored = grades.filter((g): g is Exclude<Grade, 'U'> => g !== 'U');
  const ungraded = grades.length - scored.length;
  if (scored.length === 0) return { gpa: null, graded: 0, ungraded };
  const total = scored.reduce((n, g) => n + GRADE_POINTS[g], 0);
  return { gpa: total / scored.length, graded: scored.length, ungraded };
}

function clamp0to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

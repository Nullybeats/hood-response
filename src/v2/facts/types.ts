/**
 * A fact and how we know it.
 *
 * The legacy engine's most expensive bug class was not a wrong number — it was a
 * confident one. `safety.ok` returned true when GoPlus had no data at all, so a
 * token nobody had checked rendered as "🛡️ Safe"; `totalCapital` scored an
 * unpriced five-figure buy as $0; `historicalAccuracy` reported a static per-tier
 * constant as if it were measured outcomes. In each case the shape of the value
 * carried no trace of its own provenance, so downstream code could not tell
 * "measured" from "absent" and defaulted to the flattering reading.
 *
 * So in v2 a fact is never a bare value. It is a value plus the provenance that
 * earned it, and the type makes the dangerous state unrepresentable: a `value`
 * exists if and only if the provenance is `measured`. Unknown is a first-class
 * answer, distinct from failure, and neither can masquerade as good news.
 */

/** How a fact came to be known. */
export type Provenance =
  /** Established from real data. `value` is present. */
  | 'measured'
  /** Not established yet — no data, a timeout, a queue. Never "fine", never "bad". */
  | 'unknown'
  /** Established, and the answer is bad (a failed honeypot check, a disowned pool). */
  | 'failed';

/**
 * `value` is non-null exactly when `provenance === 'measured'`. Build these with
 * the constructors below rather than by hand, so the invariant holds by
 * construction instead of by convention.
 */
export interface Fact<T> {
  readonly value: T | null;
  readonly provenance: Provenance;
  /** How we know — e.g. 'attrib', 'onchain-initialize', 'dexscreener'. Names the evidence. */
  readonly source: string | null;
  /** Why we do not know, or why it failed. Present for unknown/failed, and shown to humans. */
  readonly reason: string | null;
}

/** A fact established from real data. */
export function measured<T>(value: T, source: string): Fact<T> {
  return { value, provenance: 'measured', source, reason: null };
}

/**
 * Not established. The check has not run, has not finished, or returned nothing.
 *
 * Unknown must never be collapsed into a default. A coin can never grade well on
 * an unknown, and it can never be condemned for one either.
 */
export function unknown<T>(reason: string, source: string | null = null): Fact<T> {
  return { value: null, provenance: 'unknown', source, reason };
}

/** Established, and the answer disqualifies the token — a real negative result. */
export function failed<T>(reason: string, source: string): Fact<T> {
  return { value: null, provenance: 'failed', source, reason };
}

/** True only for `measured`. The one predicate callers should branch on. */
export function isKnown<T>(f: Fact<T>): f is Fact<T> & { value: T } {
  return f.provenance === 'measured' && f.value !== null;
}

/**
 * The value, or a caller-supplied fallback.
 *
 * Deliberately explicit at every call site: there is no ambient default, because
 * an ambient default is how an unpriced buy became "$0 of capital" and quietly
 * zeroed 15% of a score.
 */
export function valueOr<T>(f: Fact<T>, fallback: T): T {
  return isKnown(f) ? f.value : fallback;
}

/** Display glyph for the dashboard and Telegram cards. */
export function glyph<T>(f: Fact<T>): '✅' | '⏳' | '❌' {
  return f.provenance === 'measured' ? '✅' : f.provenance === 'unknown' ? '⏳' : '❌';
}

/**
 * Wallet report-card grade, earned from measured outcomes.
 *
 * Replaces the alpha/beta/chroma/delta tiers wholesale. Those were a snapshot of
 * top-10 holder rank taken once by a script and frozen — they described who held
 * a bag on one particular day, then fed a "confidence" constant that the score
 * double-counted as if it were a track record.
 */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F' | 'U';

/** Ordered best-first. `U` is deliberately absent: it is not a rank, it is a gap. */
export const GRADE_ORDER: readonly Exclude<Grade, 'U'>[] = ['A', 'B', 'C', 'D', 'F'] as const;

/**
 * Grade points for crowd GPA. `F` is 0 so a toxic wallet can never lift a crowd,
 * and `U` contributes nothing at all — an ungraded wallet is not evidence.
 */
export const GRADE_POINTS: Record<Exclude<Grade, 'U'>, number> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  F: 0,
};

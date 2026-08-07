/**
 * The facts layer exists to make the legacy engine's failure mode
 * unrepresentable: a confident value with no evidence behind it. These tests pin
 * the properties that guarantee it, including the specific production bugs that
 * motivated each one.
 */
import { describe, expect, it } from 'vitest';

import { crowdGpa, gradeWallet, MIN_SAMPLE, STALE_DAYS, type Outcome } from '../../v2/facts/grade.js';
import { failed, glyph, isKnown, measured, unknown, valueOr, type Fact } from '../../v2/facts/types.js';

const DAY = 86_400_000;
const NOW = 1_786_000_000_000;

/** n outcomes, all recent, each peaking at `peak`. */
function outcomes(n: number, peak: number, opts: { ageDays?: number; rugged?: boolean } = {}): Outcome[] {
  const age = (opts.ageDays ?? 1) * DAY;
  return Array.from({ length: n }, (_, i) => ({
    at: NOW - age - i * DAY,
    peakMultiple: peak,
    ruggedAfter: opts.rugged ?? false,
  }));
}

describe('Fact provenance', () => {
  it('carries a value only when measured', () => {
    const m = measured(42, 'attrib');
    expect(isKnown(m)).toBe(true);
    expect(m.value).toBe(42);

    const u = unknown<number>('goplus returned no data');
    expect(isKnown(u)).toBe(false);
    expect(u.value).toBeNull();

    const f = failed<number>('honeypot: cannot sell', 'goplus');
    expect(isKnown(f)).toBe(false);
    expect(f.value).toBeNull();
  });

  /**
   * The "🛡️ Safe" bug: an unrun check and a passed check must never render the
   * same. Unknown is not failure, and it is emphatically not success.
   */
  it('distinguishes "not checked" from "checked and bad" from "checked and good"', () => {
    const notChecked = unknown<boolean>('safety data unavailable');
    const bad = failed<boolean>('cannot sell', 'goplus');
    const good = measured(true, 'goplus');

    expect([notChecked, bad, good].map(glyph)).toEqual(['⏳', '❌', '✅']);
    // No two of them collapse to the same downstream branch.
    expect(new Set([notChecked, bad, good].map((f) => f.provenance)).size).toBe(3);
    expect(isKnown(notChecked)).toBe(false);
    expect(isKnown(bad)).toBe(false);
  });

  /**
   * The `totalCapital` bug: an unpriced five-figure buy scored as $0 because the
   * fallback was ambient. Here every fallback is written at the call site.
   */
  it('requires an explicit fallback rather than defaulting silently', () => {
    const unpriced = unknown<number>('no price for a brand-new pair');
    expect(valueOr(unpriced, 0)).toBe(0);
    expect(valueOr(unpriced, -1)).toBe(-1);
    expect(valueOr(measured(1234, 'pool'), 0)).toBe(1234);
  });

  it('keeps the invariant that a non-null value implies measured', () => {
    const all: Fact<unknown>[] = [
      measured('x', 's'),
      unknown('why'),
      failed('why', 's'),
    ];
    for (const f of all) {
      expect(f.value !== null).toBe(f.provenance === 'measured');
    }
  });
});

describe('gradeWallet', () => {
  it('returns U — not a middling grade — below the minimum sample', () => {
    const r = gradeWallet(outcomes(MIN_SAMPLE - 1, 2.0), NOW);
    expect(r.grade).toBe('U');
    expect(r.index).toBeNull();
    expect(r.reason).toMatch(/needed to grade/);
  });

  it('grades a consistently profitable wallet highly', () => {
    const r = gradeWallet(outcomes(10, 2.5), NOW);
    expect(r.grade).toBe('A');
    expect(r.index).toBeGreaterThanOrEqual(75);
    expect(r.sample).toBe(10);
  });

  it('grades a consistently unprofitable wallet F', () => {
    const r = gradeWallet(outcomes(10, 0.6), NOW);
    expect(r.grade).toBe('F');
  });

  /** Following rugs is the failure that actually costs money, so it must dominate. */
  it('penalises rug-following hard enough to sink an otherwise strong record', () => {
    const clean = gradeWallet(outcomes(10, 2.5), NOW);
    const ruggy = gradeWallet(outcomes(10, 2.5, { rugged: true }), NOW);
    expect(ruggy.index!).toBeLessThan(clean.index!);
    expect(ruggy.reason).toMatch(/rugged/);
  });

  it('drifts back to U when the wallet has gone cold', () => {
    const r = gradeWallet(outcomes(10, 2.5, { ageDays: STALE_DAYS + 5 }), NOW);
    expect(r.grade).toBe('U');
    expect(r.reason).toMatch(/stale/);
  });

  /** One monster call should not launder an otherwise poor record into an A. */
  it('caps a single outlier so repeatability, not luck, drives the grade', () => {
    const oneMoonshot: Outcome[] = [
      { at: NOW - DAY, peakMultiple: 50 },
      ...outcomes(9, 0.7).map((o, i) => ({ ...o, at: NOW - (i + 2) * DAY })),
    ];
    const r = gradeWallet(oneMoonshot, NOW);
    expect(r.grade).not.toBe('A');
  });

  it('weights recent outcomes above old ones', () => {
    const recentGood: Outcome[] = [
      ...outcomes(5, 3.0, { ageDays: 1 }),
      ...outcomes(5, 0.7, { ageDays: 40 }),
    ];
    const recentBad: Outcome[] = [
      ...outcomes(5, 0.7, { ageDays: 1 }),
      ...outcomes(5, 3.0, { ageDays: 40 }),
    ];
    expect(gradeWallet(recentGood, NOW).index!).toBeGreaterThan(gradeWallet(recentBad, NOW).index!);
  });

  /** Determinism: the clock is injected, so replay reproduces the live grade. */
  it('is a pure function of its inputs', () => {
    const o = outcomes(8, 2.0);
    expect(gradeWallet(o, NOW)).toEqual(gradeWallet(o, NOW));
  });
});

describe('crowdGpa', () => {
  it('reports no opinion for a crowd of ungraded wallets', () => {
    const r = crowdGpa(['U', 'U', 'U']);
    expect(r.gpa).toBeNull();
    expect(r.graded).toBe(0);
    expect(r.ungraded).toBe(3);
  });

  /** The "3 wallets accumulating" bug: quality, not headcount. */
  it('separates a strong crowd from a weak one of the same size', () => {
    const strong = crowdGpa(['A', 'A', 'B']);
    const weak = crowdGpa(['D', 'D', 'F']);
    expect(strong.gpa!).toBeGreaterThan(weak.gpa!);
  });

  it('never lets an F raise the average', () => {
    const withoutF = crowdGpa(['A', 'B']);
    const withF = crowdGpa(['A', 'B', 'F']);
    expect(withF.gpa!).toBeLessThan(withoutF.gpa!);
  });

  it('lets ungraded wallets contribute nothing rather than an implied average', () => {
    expect(crowdGpa(['A', 'B']).gpa).toBe(crowdGpa(['A', 'B', 'U', 'U']).gpa);
    expect(crowdGpa(['A', 'B', 'U']).ungraded).toBe(1);
  });
});

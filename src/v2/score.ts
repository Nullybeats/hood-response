/**
 * The score: four dials, each measured, each shown.
 *
 * The legacy conviction score was 100 points of which a large fraction could not
 * move. Measured on live production alerts:
 *
 *  - `buySellRatio` (10%) returned exactly 100 on every alert ever emitted. Its
 *    inputs were bucketed by direction upstream, so purity was 1.0 by
 *    construction — a tenth of the score was a constant wearing a variable's name.
 *  - `velocity` (12%) pinned to 100 for every single-wallet alert, because the
 *    window of a one-event swarm is 0.001s by definition.
 *  - `historicalAccuracy` (6%) emitted only 58, 72, 90 or 96 — the four static
 *    per-tier confidence constants, restated. It never consulted an outcome.
 *  - `walletQuality` (30%) read the same constant table those four came from.
 *
 * So the headline number moved mostly with market cap, while presenting itself as
 * a composite judgement about wallets and momentum.
 *
 * Two rules follow, and both are enforced by tests rather than by intention:
 *
 *  1. NO DIAL MAY BE STRUCTURALLY CONSTANT. If a dial cannot vary across real
 *     traffic it is not evidence, and it is removed rather than carried.
 *     Note what is deliberately absent: sellability. Post-gate it is always true
 *     (the gate blocks anything else), so scoring it would recreate the
 *     `buySellRatio` bug precisely. It is a gate, not a dial.
 *  2. AN UNKNOWN DIAL IS DROPPED, NOT ZEROED. Its weight is redistributed across
 *     the dials that could be computed, and the sheet records which ones those
 *     were. Zeroing is what made a genuine five-figure buy on an unpriced pair
 *     contribute nothing while presenting as a confident low score.
 *
 * When no dial can be computed the score is null — "we cannot say" — never 0.
 */

import type { FactSheet } from './facts/sheet.js';
import { GRADE_POINTS, isKnown, type Grade } from './facts/types.js';

export type DialName = 'who' | 'what' | 'when' | 'howMuch';

/** [config] Weights. Tunable against the journal; they must sum to 1. */
export const DIAL_WEIGHTS: Record<DialName, number> = {
  /** Whose money it is: the wallet's earned grade, and the crowd's. */
  who: 0.4,
  /** What is being bought: how much room the cap leaves to run. */
  what: 0.25,
  /** When we are seeing it: pair age and novelty. */
  when: 0.2,
  /** How much conviction the buy itself carries, in dollars. */
  howMuch: 0.15,
};

export interface DialResult {
  name: DialName;
  /** 0–100, or null when the underlying facts were not measured. */
  value: number | null;
  /** Weight actually applied after redistribution. 0 for a dropped dial. */
  appliedWeight: number;
  /** One line explaining the number, shown on the card. */
  detail: string;
}

export interface ScoreResult {
  /** 0–100, or null when nothing could be measured. Never a default. */
  score: number | null;
  dials: DialResult[];
  /** Names of dials that could not be computed, so the gap is visible. */
  dropped: DialName[];
  /** Human summary, e.g. "A wallet, micro cap, 3h-old pair, $5k buy". */
  summary: string;
}

/** Grade → 0–100. `U` is not a grade and never reaches here. */
const GRADE_SCORE: Record<Exclude<Grade, 'U'>, number> = { A: 100, B: 78, C: 52, D: 26, F: 0 };

export function scoreSheet(sheet: FactSheet): ScoreResult {
  const raw: { name: DialName; value: number | null; detail: string }[] = [
    who(sheet),
    what(sheet),
    when(sheet),
    howMuch(sheet),
  ];

  const usable = raw.filter((d) => d.value != null);
  const totalWeight = usable.reduce((n, d) => n + DIAL_WEIGHTS[d.name], 0);

  const dials: DialResult[] = raw.map((d) => ({
    name: d.name,
    value: d.value,
    // Redistribution: each surviving dial keeps its share RELATIVE to the others,
    // so dropping one never silently penalises the alert.
    appliedWeight: d.value == null || totalWeight === 0 ? 0 : DIAL_WEIGHTS[d.name] / totalWeight,
    detail: d.detail,
  }));

  const score =
    totalWeight === 0
      ? null
      : Math.round(dials.reduce((n, d) => n + (d.value ?? 0) * d.appliedWeight, 0));

  return {
    score,
    dials,
    dropped: dials.filter((d) => d.value == null).map((d) => d.name),
    summary: dials
      .filter((d) => d.value != null)
      .map((d) => d.detail)
      .join(' · '),
  };
}

/**
 * Whose money it is.
 *
 * The wallet's own grade dominates; the crowd adjusts it. An ungraded wallet with
 * an ungraded crowd yields null — genuinely no opinion — rather than the implied
 * "average" the legacy tier table always supplied.
 */
function who(sheet: FactSheet): { name: DialName; value: number | null; detail: string } {
  const hasWallet = isKnown(sheet.walletGrade);
  const hasCrowd = isKnown(sheet.crowdGpa);
  if (!hasWallet && !hasCrowd) {
    return { name: 'who', value: null, detail: '' };
  }

  const walletPart = hasWallet ? GRADE_SCORE[sheet.walletGrade.value as Exclude<Grade, 'U'>] : null;
  // GPA is 0–4 over GRADE_POINTS; rescale to 0–100 on the same axis as a grade.
  const crowdPart = hasCrowd ? (sheet.crowdGpa.value! / GRADE_POINTS.A) * 100 : null;

  let value: number;
  let detail: string;
  if (walletPart != null && crowdPart != null) {
    value = walletPart * 0.7 + crowdPart * 0.3;
    detail = `${sheet.walletGrade.value} wallet, crowd ${sheet.crowdGpa.value!.toFixed(1)} GPA`;
  } else if (walletPart != null) {
    value = walletPart;
    detail = `${sheet.walletGrade.value} wallet`;
  } else {
    value = crowdPart!;
    detail = `crowd ${sheet.crowdGpa.value!.toFixed(1)} GPA`;
  }
  return { name: 'who', value: clamp(value), detail };
}

/**
 * What is being bought: room to run.
 *
 * A smaller cap leaves more of it. Log-scaled because the difference between
 * $30k and $300k matters far more than between $30M and $300M, and linear
 * scaling would compress every microcap into the same value — the failure that
 * makes a dial look varying while being effectively constant where it counts.
 */
function what(sheet: FactSheet): { name: DialName; value: number | null; detail: string } {
  if (!isKnown(sheet.marketCap)) return { name: 'what', value: null, detail: '' };
  const cap = sheet.marketCap.value;
  // $10k → ~100, $100k → ~67, $1M → ~33, $10M+ → 0.
  const value = clamp(((7 - Math.log10(Math.max(cap, 1))) / 3) * 100);
  return {
    name: 'what',
    value,
    detail: `${sheet.capBand.value ?? 'unbanded'} cap $${Math.round(cap).toLocaleString()}`,
  };
}

/**
 * When we are seeing it.
 *
 * Pair age carries the dial; a first-ever buy from this wallet adds to it. Note
 * that `firstBuy` alone cannot drive this dial — it is a boolean, and a boolean
 * that is usually true would be a near-constant. It modulates a continuous value
 * instead.
 */
function when(sheet: FactSheet): { name: DialName; value: number | null; detail: string } {
  if (!isKnown(sheet.pairAgeHours)) return { name: 'when', value: null, detail: '' };
  const hours = sheet.pairAgeHours.value;
  // 0h → 100, 24h → ~50, 48h → ~25, older decays toward 0.
  const ageScore = clamp(100 / (1 + hours / 24));
  const first = sheet.firstBuy.value === true;
  const value = clamp(first ? ageScore * 0.8 + 20 : ageScore * 0.8);
  return {
    name: 'when',
    value,
    detail: `${formatHours(hours)} pair${first ? ', first buy' : ''}`,
  };
}

/**
 * How much conviction the buy carries.
 *
 * Null when unpriced — the single most important null in this file. The legacy
 * scorer summed `usdValue ?? 0`, so an unpriced buy on a brand-new pair scored
 * zero capital, which is precisely backwards: those are the trades the whole
 * system exists to catch.
 */
function howMuch(sheet: FactSheet): { name: DialName; value: number | null; detail: string } {
  if (!isKnown(sheet.buyUsd)) return { name: 'howMuch', value: null, detail: '' };
  const usd = sheet.buyUsd.value;
  // $100 → ~0, $1k → 33, $10k → 67, $100k+ → 100.
  const value = clamp(((Math.log10(Math.max(usd, 1)) - 2) / 3) * 100);
  return { name: 'howMuch', value, detail: `$${Math.round(usd).toLocaleString()} buy` };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m-old`;
  if (h < 48) return `${Math.round(h)}h-old`;
  return `${Math.round(h / 24)}d-old`;
}

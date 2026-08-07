/**
 * Phase 2 pins the two rules the legacy engine broke silently: unknown never
 * passes, and no dial may be a constant wearing a variable's name.
 *
 * The property test at the bottom is the important one — it is the check that
 * would have caught `buySellRatio` (always exactly 100), `velocity` (always 100
 * for single-wallet alerts) and `historicalAccuracy` (only ever 58/72/90/96)
 * before any of them shipped.
 */
import { describe, expect, it } from 'vitest';

import { buildFactSheet, type SheetInputs, type VerifiedTrade } from '../../v2/facts/sheet.js';
import type { Outcome } from '../../v2/facts/grade.js';
import { DEFAULT_GATE_OPTIONS, gate } from '../../v2/gate.js';
import { DIAL_WEIGHTS, scoreSheet, type DialName } from '../../v2/score.js';

const NOW = 1_786_000_000_000;
const DAY = 86_400_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';

const trade: VerifiedTrade = {
  txHash: '0xtx',
  wallet: WALLET,
  token: '0xtoken0000000000000000000000000000000001',
  tokenSymbol: 'WOOF',
  blockNumber: 1000,
  at: NOW,
  venue: 'swap_v4_poolmanager',
  usdValue: 5000,
};

function outcomesFor(peak: number, n = 10): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({ at: NOW - (i + 1) * DAY, peakMultiple: peak }));
}

function inputs(over: Partial<SheetInputs> = {}): SheetInputs {
  return {
    marketCap: 80_000,
    pairAgeHours: 3,
    pairAgeSource: 'onchain-initialize',
    canSell: true,
    outcomesByWallet: new Map([[WALLET, outcomesFor(2.5)]]),
    crowdWallets: [],
    firstBuy: true,
    rotatedFrom: null,
    ...over,
  };
}

const sheetWith = (over: Partial<SheetInputs> = {}, t: VerifiedTrade = trade) =>
  buildFactSheet(t, inputs(over), NOW);

describe('gate — the unknown-law', () => {
  it('passes when the house-rule facts are settled', () => {
    const v = gate(sheetWith(), 0, 0);
    expect(v.decision).toBe('pass');
  });

  /** The "🛡️ Safe" bug, now structurally impossible: unknown cannot become pass. */
  it('retries — never passes — when sellability was not checked', () => {
    const v = gate(sheetWith({ canSell: null }), 0, 0);
    expect(v.decision).toBe('retry');
    expect(v.fact).toBe('canSell');
  });

  it('blocks a token that was checked and cannot be sold', () => {
    const v = gate(sheetWith({ canSell: false }), 0, 0);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/cannot be sold/);
  });

  it('retries on an unresolved market cap', () => {
    expect(gate(sheetWith({ marketCap: null }), 0, 0).decision).toBe('retry');
  });

  /**
   * "Unknown never passes" has to stay true at the end of the retry budget too,
   * or it silently becomes "unknown passes eventually".
   */
  it('drops an alert whose facts never resolve, rather than passing it', () => {
    const stuck = sheetWith({ canSell: null });
    const v = gate(stuck, DEFAULT_GATE_OPTIONS.maxAttempts - 1, 0);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/never assumed/);
  });

  it('drops on the time bound as well as the attempt bound', () => {
    const v = gate(sheetWith({ marketCap: null }), 0, DEFAULT_GATE_OPTIONS.maxPendingMs);
    expect(v.decision).toBe('block');
    expect(v.reason).toMatch(/unresolved after \d+s/);
  });

  it('never returns pass for any sheet with an unknown house-rule fact', () => {
    for (const over of [{ canSell: null }, { marketCap: null }, { canSell: null, marketCap: null }]) {
      for (const attempt of [0, 1, 5, 99]) {
        for (const pending of [0, 1000, 999_999]) {
          expect(gate(sheetWith(over as Partial<SheetInputs>), attempt, pending).decision).not.toBe('pass');
        }
      }
    }
  });

  /** Lane-specific facts must not block the pipeline for everyone. */
  it('does not gate on facts only some lanes need', () => {
    expect(gate(sheetWith({ pairAgeHours: null }), 0, 0).decision).toBe('pass');
    expect(gate(sheetWith({ crowdWallets: [] }), 0, 0).decision).toBe('pass');
  });
});

describe('scoreSheet', () => {
  it('produces a score with a visible per-dial breakdown', () => {
    const r = scoreSheet(sheetWith());
    expect(r.score).not.toBeNull();
    expect(r.dials).toHaveLength(4);
    expect(r.summary).toContain('wallet');
    // The number is explainable, not a mystery.
    expect(r.summary.length).toBeGreaterThan(10);
  });

  /** An unpriced buy must cost the alert nothing — it is unknown, not zero. */
  it('drops an unmeasurable dial and redistributes its weight', () => {
    const priced = scoreSheet(sheetWith());
    const unpriced = scoreSheet(sheetWith({}, { ...trade, usdValue: null }));

    expect(unpriced.dropped).toContain('howMuch');
    const applied = unpriced.dials.reduce((n, d) => n + d.appliedWeight, 0);
    expect(applied).toBeCloseTo(1, 6);
    // The surviving dials still carry their full relative share.
    const who = unpriced.dials.find((d) => d.name === 'who')!;
    expect(who.appliedWeight).toBeGreaterThan(DIAL_WEIGHTS.who);
    expect(priced.score).not.toBeNull();
  });

  it('scores null — not zero — when nothing can be measured', () => {
    const blind = scoreSheet(
      buildFactSheet(
        { ...trade, usdValue: null },
        inputs({ marketCap: null, pairAgeHours: null, outcomesByWallet: new Map(), crowdWallets: [] }),
        NOW,
      ),
    );
    expect(blind.score).toBeNull();
    expect(blind.dropped).toHaveLength(4);
  });

  it('rates a graded wallet above an ungraded one', () => {
    const graded = scoreSheet(sheetWith());
    const ungraded = scoreSheet(sheetWith({ outcomesByWallet: new Map() }));
    // The ungraded sheet drops `who` entirely rather than scoring it average.
    expect(ungraded.dropped).toContain('who');
    expect(graded.dials.find((d) => d.name === 'who')!.value).not.toBeNull();
  });

  it('rewards a smaller cap and a younger pair', () => {
    const micro = scoreSheet(sheetWith({ marketCap: 30_000 }));
    const large = scoreSheet(sheetWith({ marketCap: 20_000_000 }));
    expect(micro.score!).toBeGreaterThan(large.score!);

    const fresh = scoreSheet(sheetWith({ pairAgeHours: 1 }));
    const old = scoreSheet(sheetWith({ pairAgeHours: 400 }));
    expect(fresh.score!).toBeGreaterThan(old.score!);
  });

  it('is pure', () => {
    expect(scoreSheet(sheetWith())).toEqual(scoreSheet(sheetWith()));
  });

  /**
   * THE PROPERTY THAT MATTERS. Across a spread of realistic sheets every dial
   * must actually move. A dial with one distinct value over varied input is not
   * evidence — it is the `buySellRatio` bug, which shipped and sat in production
   * contributing a constant 10% of every conviction number.
   */
  it('has no structurally constant dial across varied traffic', () => {
    const corpus = [
      sheetWith({ marketCap: 20_000, pairAgeHours: 0.5, outcomesByWallet: new Map([[WALLET, outcomesFor(3)]]) }),
      sheetWith({ marketCap: 90_000, pairAgeHours: 6, outcomesByWallet: new Map([[WALLET, outcomesFor(2)]]) }),
      sheetWith({ marketCap: 400_000, pairAgeHours: 30, outcomesByWallet: new Map([[WALLET, outcomesFor(1.1)]]) }),
      sheetWith({ marketCap: 3_000_000, pairAgeHours: 200, outcomesByWallet: new Map([[WALLET, outcomesFor(0.6)]]) }),
      sheetWith({ marketCap: 150_000, pairAgeHours: 12, firstBuy: false }),
      scoreInputVariant(1_500),
      scoreInputVariant(45_000),
      scoreInputVariant(250_000),
    ];

    for (const name of Object.keys(DIAL_WEIGHTS) as DialName[]) {
      const values = new Set(
        corpus
          .map((s) => scoreSheet(s).dials.find((d) => d.name === name)!.value)
          .filter((v): v is number => v != null)
          .map((v) => Math.round(v)),
      );
      expect(values.size, `dial "${name}" produced only ${[...values]} across varied input`).toBeGreaterThan(1);
    }
  });

  it('keeps every dial inside 0..100', () => {
    for (const cap of [1, 1_000, 1e9]) {
      for (const usd of [1, 100, 1e9]) {
        const r = scoreSheet(sheetWith({ marketCap: cap }, { ...trade, usdValue: usd }));
        for (const d of r.dials) {
          if (d.value != null) {
            expect(d.value).toBeGreaterThanOrEqual(0);
            expect(d.value).toBeLessThanOrEqual(100);
          }
        }
        expect(r.score!).toBeGreaterThanOrEqual(0);
        expect(r.score!).toBeLessThanOrEqual(100);
      }
    }
  });
});

function scoreInputVariant(usd: number) {
  return buildFactSheet({ ...trade, usdValue: usd }, inputs(), NOW);
}

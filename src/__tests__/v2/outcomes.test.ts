/**
 * Grades are only as good as this join.
 *
 * It reads v2's OWN outcome ledger rather than the legacy performance tracker:
 * that tracker follows legacy alerts, of which this feed fires almost none —
 * measured at 12 calls across 7 wallets against a 5-outcome floor, so no wallet
 * could ever reach a first grade.
 *
 * The subtle failure these tests exist to prevent is a grade that looks earned
 * but is really an artifact of what we could not measure: a token we never
 * managed to quote must not be counted as a flat result against the wallet.
 */
import { describe, expect, it } from 'vitest';

import { gradeWallet } from '../../v2/facts/grade.js';
import { toOutcome, WalletOutcomes } from '../../v2/facts/outcomes.js';
import type { LedgerRecord, OutcomeLedger } from '../../v2/ledger.js';

const NOW = Date.now();
const DAY = 86_400_000;
const ALICE = '0xaaaa000000000000000000000000000000000001';
const BOB = '0xbbbb000000000000000000000000000000000002';

function rec(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    id: '0x' + Math.random().toString(36).slice(2),
    token: '0xtok',
    tokenSymbol: 'WOOF',
    lanes: ['allocation'],
    matched: true,
    eventType: 'distribution',
    wallet: ALICE,
    cohortWallets: [ALICE],
    walletGradeAtFire: 'U',
    score: 68,
    seedTier: 'alpha',
    capBand: 'micro',
    entryMarketCap: 50_000,
    pairAgeHours: 3,
    firedAt: NOW - DAY,
    entryPrice: 1,
    entryDelayMs: 0,
    lastPrice: 2,
    lastGainPct: 100,
    maxPrice: 3,
    maxGainPct: 200,
    maxGainAt: NOW - DAY / 2,
    gain1hPct: null,
    gain6hPct: null,
    gain24hPct: null,
    cohortSize: 1,
    updatedAt: NOW,
    nextSampleAt: NOW,
    closed: true,
    closedReason: 'tracked-out',
    ...over,
  };
}

function ledger(records: LedgerRecord[]): OutcomeLedger {
  return { list: () => records } as unknown as OutcomeLedger;
}

describe('toOutcome', () => {
  it('converts a closed record to a peak multiple', () => {
    const o = toOutcome(rec({ maxGainPct: 150 }))!;
    expect(o.peakMultiple).toBeCloseTo(2.5, 5);
    expect(o.at).toBe(NOW - DAY);
  });

  /** A record still moving is not yet a result. */
  it('ignores a record that has not closed', () => {
    expect(toOutcome(rec({ closed: false }))).toBeNull();
  });

  /**
   * The exclusion that keeps grades honest. A record that closed 'no-price'
   * carries maxGainPct: 0 — a 1.0x peak, below the hit threshold — so counting
   * it would grade the wallet DOWN for our own inability to quote its token.
   */
  it('ignores a record that never became quotable', () => {
    const unpriced = rec({ entryPrice: null, maxGainPct: 0, lastGainPct: 0, closedReason: 'no-price' });
    expect(toOutcome(unpriced)).toBeNull();
  });

  /**
   * NEGATIVE CONTROL for the rule above: if the exclusion were removed, that
   * same record WOULD count as a miss and drag a perfect wallet's grade down.
   * This proves the exclusion is what is doing the work.
   */
  it('a never-quotable record would count as a MISS if it were not excluded', () => {
    const wins = Array.from({ length: 5 }, (_, i) =>
      toOutcome(rec({ firedAt: NOW - (i + 1) * DAY, maxGainPct: 220 }))!,
    );
    const withExclusion = gradeWallet(wins, NOW);

    // Simulate the un-excluded behaviour: peakMultiple 1.0 from a 0% record.
    const asIfCounted = [...wins, { at: NOW - DAY, peakMultiple: 1, ruggedAfter: false }];
    const withoutExclusion = gradeWallet(asIfCounted, NOW);

    expect(withoutExclusion.index!).toBeLessThan(withExclusion.index!);
  });

  it('flags a record that ended near zero as a rug follow', () => {
    expect(toOutcome(rec({ lastGainPct: -97 }))!.ruggedAfter).toBe(true);
    expect(toOutcome(rec({ lastGainPct: -20 }))!.ruggedAfter).toBe(false);
  });

  /** Peak, not final: a runner we exited badly is still a good call. */
  it('grades on the peak, not on where it ended', () => {
    const ranThenGaveItBack = toOutcome(rec({ maxGainPct: 400, lastGainPct: -10 }))!;
    expect(ranThenGaveItBack.peakMultiple).toBeCloseTo(5, 5);
  });
});

describe('WalletOutcomes', () => {
  it('resolves an address to its own outcomes', () => {
    const wo = new WalletOutcomes(ledger([rec(), rec({ maxGainPct: 50 })]));
    expect(wo.for(ALICE)).toHaveLength(2);
    expect(wo.for(BOB)).toHaveLength(0);
  });

  it('matches an address regardless of case', () => {
    const wo = new WalletOutcomes(ledger([rec({ wallet: ALICE.toUpperCase(), cohortWallets: [] })]));
    expect(wo.for(ALICE)).toHaveLength(1);
  });

  /** Grades are earned from allocations today; a buy record must not be counted. */
  it('counts only records of the configured basis', () => {
    const wo = new WalletOutcomes(ledger([rec(), rec({ eventType: 'verified-buy' })]), 'distribution');
    expect(wo.for(ALICE)).toHaveLength(1);
    expect(wo.stats().basis).toBe('distribution');
  });

  it('credits every wallet in the cohort, not just the trigger', () => {
    const wo = new WalletOutcomes(ledger([rec({ wallet: ALICE, cohortWallets: [ALICE, BOB], cohortSize: 2 })]));
    expect(wo.for(ALICE)).toHaveLength(1);
    expect(wo.for(BOB)).toHaveLength(1);
  });

  /**
   * The control group must grade too. A decision no lane matched still tells us
   * what happened to that wallet's allocation — and if only matches counted, a
   * wallet outside the seed catalog could never earn a first grade.
   */
  it('grades unmatched records as well as matched ones', () => {
    const wo = new WalletOutcomes(ledger([rec({ matched: false, lanes: [] })]));
    expect(wo.for(ALICE)).toHaveLength(1);
  });

  it('returns nothing for an unknown wallet — which grades U, not F', () => {
    const wo = new WalletOutcomes(ledger([]));
    expect(wo.for(BOB)).toHaveLength(0);
    expect(gradeWallet(wo.for(BOB), NOW).grade).toBe('U');
  });

  /** With the ledger disabled there is no record at all — U, never a guess. */
  it('is inert when no ledger exists', () => {
    const wo = new WalletOutcomes(undefined);
    expect(wo.for(ALICE)).toHaveLength(0);
    expect(wo.stats().wallets).toBe(0);
  });

  /** End to end: a real record now produces a real grade. */
  it('produces a measured grade from a real record', () => {
    const winners = Array.from({ length: 8 }, (_, i) =>
      rec({ firedAt: NOW - (i + 1) * DAY, maxGainPct: 220, lastGainPct: 40 }),
    );
    const graded = gradeWallet(new WalletOutcomes(ledger(winners)).for(ALICE), NOW);
    expect(graded.grade).not.toBe('U');
    expect(graded.sample).toBe(8);
    expect(['A', 'B']).toContain(graded.grade);
  });

  /** The grade must describe what it measured — these are airdrops, not purchases. */
  it('says the grade rests on allocations, not buys', () => {
    const winners = Array.from({ length: 6 }, (_, i) =>
      rec({ firedAt: NOW - (i + 1) * DAY, maxGainPct: 220, lastGainPct: 40 }),
    );
    const graded = gradeWallet(new WalletOutcomes(ledger(winners)).for(ALICE), NOW);
    expect(graded.reason).toContain('allocations');
    expect(graded.reason).not.toContain('buys');
  });

  it('sorts a wallet’s outcomes newest-first', () => {
    const wo = new WalletOutcomes(
      ledger([rec({ firedAt: NOW - 5 * DAY }), rec({ firedAt: NOW - DAY }), rec({ firedAt: NOW - 3 * DAY })]),
    );
    const ats = wo.for(ALICE).map((o) => o.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it('reports how much of the record is usable', () => {
    const wo = new WalletOutcomes(ledger([rec(), rec({ closed: false })]));
    const s = wo.stats();
    expect(s.calls).toBe(1); // the open one is not a result yet
    expect(s.wallets).toBe(1);
  });
});

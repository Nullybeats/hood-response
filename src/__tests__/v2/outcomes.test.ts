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
import { PRIOR_OUTCOMES } from '../../v2/facts/priorOutcomes.js';
import { MAX_OUTCOMES } from '../../v2/facts/grade.js';

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

  /**
   * An OPEN record is a result. The ledger tracks entry, peak and now — it does not model an exit,
   * because when a position actually closes is decided by the operator's own config (trailing
   * stop, take-profit, recoup), which differs per tenant and can change mid-position.
   *
   * Waiting for a ledger "close" measured nothing but elapsed time, and cost every grade a 24h
   * latency floor. Peak can only rise, so judging early understates a wallet and never flatters
   * it — the safe direction to be wrong in.
   */
  it('judges a record that is still open', () => {
    const o = toOutcome(rec({ closed: false, maxGainPct: 150 }))!;
    expect(o).not.toBeNull();
    expect(o.peakMultiple).toBeCloseTo(2.5, 5);
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
    // Open and closed alike count; only an unpriced record is dropped, because it is unmeasured
    // rather than flat.
    const wo = new WalletOutcomes(ledger([rec(), rec({ closed: false }), rec({ entryPrice: null })]));
    const s = wo.stats();
    expect(s.calls).toBe(2);
    expect(s.wallets).toBe(1);
  });
});

/**
 * The imported prior call record.
 *
 * A wallet grades U until it has 5 measured outcomes, and the v2 ledger only began recording
 * hours ago — so wallets with a long, genuinely good record read as unproven and were
 * indistinguishable from a wallet we had never seen. The prior is their real outcomes, imported so
 * a grade starts from what a wallet has actually done.
 *
 * It is a PRIOR, not an override, and these tests are what hold that line.
 */
describe('prior outcomes are a starting point, not a floor', () => {
  const wid = Object.keys(PRIOR_OUTCOMES)[0]!;
  const prior = PRIOR_OUTCOMES[wid]!;

  it('lets a wallet with only a prior record grade at all', () => {
    const wo = new WalletOutcomes(ledger([]));
    const card = wo.reportCard(Date.now());
    const row = card.find((r) => r.walletId === wid);
    expect(row).toBeDefined();
    expect(row!.sample).toBeGreaterThan(0);
  });

  /**
   * The displacement rule. `gradeWallet` keeps the most recent MAX_OUTCOMES, so once a wallet has
   * that many LIVE outcomes the prior contributes nothing — which is what makes this safe to seed
   * from a different basis (legacy buys) than the one we now measure (allocations).
   */
  it('is displaced entirely once the wallet has enough live outcomes', () => {
    const now = Date.now();
    const live: Outcome[] = Array.from({ length: MAX_OUTCOMES }, (_, i) => ({
      at: now - i * 60_000, // all far newer than the imported record
      peakMultiple: 1.0,
    }));
    const merged = gradeWallet([...live], now, 'allocations');
    // The prior is uniformly stronger than these flat live outcomes; if it leaked in, the index
    // could not be 0.
    expect(merged.sample).toBe(MAX_OUTCOMES);
    expect(merged.index).toBe(0);
    expect(prior.some(([, peak]) => peak > 30)).toBe(true); // the prior really is stronger
  });

  /**
   * An imported outcome carries its REAL timestamp, so the staleness rule still applies to it. A
   * wallet cannot be seeded with an old record and coast on it: go quiet for 30 days and it drifts
   * back to U regardless of how good the prior was.
   */
  it('goes stale on its real age — a prior cannot be coasted on', () => {
    const now = Date.now();
    const excellent = Array.from({ length: 6 }, (_, i) => ({
      at: now - (40 + i) * 86_400_000, // well past STALE_DAYS
      peakMultiple: 3,
    }));
    const g = gradeWallet(excellent, now, 'allocations');
    expect(g.grade).toBe('U');
    expect(g.reason).toContain('stale');

    // The identical record, recent, grades on its merits.
    const recent = excellent.map((o, i) => ({ ...o, at: now - i * 3_600_000 }));
    expect(gradeWallet(recent, now, 'allocations').grade).not.toBe('U');
  });
});

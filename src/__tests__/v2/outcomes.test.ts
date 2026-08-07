/**
 * Grades are only as good as this join. It is keyed on the salted walletId
 * rather than the display label, because labels mutate and collide — grouping by
 * label merged two wallets that shared a name and split one wallet's record the
 * moment it bought a second coin.
 */
import { describe, expect, it } from 'vitest';

import type { PerformanceTracker, TrackedCall } from '../../engine/performance.js';
import { gradeWallet } from '../../v2/facts/grade.js';
import { toOutcome, WalletOutcomes } from '../../v2/facts/outcomes.js';
import { walletId } from '../../walletId.js';

const NOW = Date.now();
const DAY = 86_400_000;
const ALICE = '0xaaaa000000000000000000000000000000000001';
const BOB = '0xbbbb000000000000000000000000000000000002';

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'c' + Math.random().toString(36).slice(2),
    token: '0xtok',
    tokenSymbol: 'WOOF',
    kind: 'ENTRY',
    conviction: 80,
    walletCount: 1,
    walletSummary: '1 alpha',
    walletLabels: ['alpha · #1 WOOF'],
    walletIds: [walletId(ALICE)],
    repeatCount: 1,
    repeatWallets: 1,
    newHolder: false,
    entryPrice: 1,
    entryMarketCap: 50_000,
    pairAgeHours: 3,
    entryAt: NOW - DAY,
    lastPrice: 2,
    lastMarketCap: 100_000,
    lastGainPct: 100,
    maxPrice: 3,
    maxGainPct: 200,
    maxGainAt: NOW - DAY / 2,
    lastMilestoneAnnounced: 0,
    gain1hPct: null,
    gain6hPct: null,
    gain24hPct: null,
    updatedAt: NOW,
    closed: true,
    ...over,
  } as TrackedCall;
}

function tracker(calls: TrackedCall[]): PerformanceTracker {
  return { list: () => calls } as unknown as PerformanceTracker;
}

describe('toOutcome', () => {
  it('converts a closed call to a peak multiple', () => {
    const o = toOutcome(call({ maxGainPct: 150 }))!;
    expect(o.peakMultiple).toBeCloseTo(2.5, 5);
    expect(o.at).toBe(NOW - DAY);
  });

  /** A call still moving is not yet a result. */
  it('ignores a call that has not closed', () => {
    expect(toOutcome(call({ closed: false }))).toBeNull();
  });

  it('flags a call that ended near zero as a rug follow', () => {
    expect(toOutcome(call({ lastGainPct: -97 }))!.ruggedAfter).toBe(true);
    expect(toOutcome(call({ lastGainPct: -20 }))!.ruggedAfter).toBe(false);
  });

  /** Peak, not final: a runner we exited badly is still a good call. */
  it('grades on the peak, not on where it ended', () => {
    const ranThenGaveItBack = toOutcome(call({ maxGainPct: 400, lastGainPct: -10 }))!;
    expect(ranThenGaveItBack.peakMultiple).toBeCloseTo(5, 5);
  });
});

describe('WalletOutcomes', () => {
  it('resolves an address to its own outcomes via the salted id', () => {
    const wo = new WalletOutcomes(tracker([call(), call({ maxGainPct: 50 })]));
    expect(wo.for(ALICE)).toHaveLength(2);
    expect(wo.for(BOB)).toHaveLength(0);
  });

  /**
   * The trap this join exists to avoid. Two wallets sharing a display label must
   * not share a record — only the id may decide.
   */
  it('does not merge two wallets that happen to share a label', () => {
    const shared = 'alpha · #1 WOOF';
    const wo = new WalletOutcomes(
      tracker([
        call({ walletIds: [walletId(ALICE)], walletLabels: [shared], maxGainPct: 300 }),
        call({ walletIds: [walletId(BOB)], walletLabels: [shared], maxGainPct: -80, lastGainPct: -80 }),
      ]),
    );
    expect(wo.for(ALICE)).toHaveLength(1);
    expect(wo.for(BOB)).toHaveLength(1);
    expect(wo.for(ALICE)[0]!.peakMultiple).not.toBe(wo.for(BOB)[0]!.peakMultiple);
  });

  it('credits every participant of a multi-wallet call', () => {
    const wo = new WalletOutcomes(
      tracker([call({ walletIds: [walletId(ALICE), walletId(BOB)], walletCount: 2 })]),
    );
    expect(wo.for(ALICE)).toHaveLength(1);
    expect(wo.for(BOB)).toHaveLength(1);
  });

  /** Old calls carry no ids; they must not be counted against anyone. */
  it('skips calls persisted before walletIds existed', () => {
    const wo = new WalletOutcomes(tracker([call({ walletIds: [] as unknown as string[] })]));
    expect(wo.for(ALICE)).toHaveLength(0);
    expect(wo.stats().calls).toBe(0);
  });

  it('returns nothing for an unknown wallet — which grades U, not F', () => {
    const wo = new WalletOutcomes(tracker([]));
    expect(wo.for(BOB)).toHaveLength(0);
    expect(gradeWallet(wo.for(BOB), NOW).grade).toBe('U');
  });

  /** End to end: a real record now produces a real grade. */
  it('produces a measured grade from a real track record', () => {
    const winners = Array.from({ length: 8 }, (_, i) =>
      call({ entryAt: NOW - (i + 1) * DAY, maxGainPct: 220, lastGainPct: 40 }),
    );
    const wo = new WalletOutcomes(tracker(winners));
    const graded = gradeWallet(wo.for(ALICE), NOW);
    expect(graded.grade).not.toBe('U');
    expect(graded.sample).toBe(8);
    expect(['A', 'B']).toContain(graded.grade);
  });

  it('sorts a wallet’s outcomes newest-first', () => {
    const wo = new WalletOutcomes(
      tracker([call({ entryAt: NOW - 5 * DAY }), call({ entryAt: NOW - DAY }), call({ entryAt: NOW - 3 * DAY })]),
    );
    const ats = wo.for(ALICE).map((o) => o.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it('reports how much of the record is usable', () => {
    const wo = new WalletOutcomes(tracker([call(), call({ closed: false })]));
    const s = wo.stats();
    expect(s.calls).toBe(1); // the open one is not a result yet
    expect(s.wallets).toBe(1);
  });
});

/**
 * Phase 3 exists to make silence impossible. The invariant test below —
 * every trade produces exactly one verdict — is the structural guarantee that a
 * suppressed signal can never again look identical to a quiet market.
 */
import { describe, expect, it } from 'vitest';

import { buildFactSheet, type SheetInputs, type VerifiedTrade } from '../../v2/facts/sheet.js';
import type { Outcome } from '../../v2/facts/grade.js';
import { gate } from '../../v2/gate.js';
import { scoreSheet } from '../../v2/score.js';
import { DEFAULT_LANES, describeCondition, evaluateLanes } from '../../v2/lanes.js';
import { buildEntry, Diary } from '../../v2/diary.js';

const NOW = 1_786_000_000_000;
const DAY = 86_400_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';
const PEER = '0xbbbb000000000000000000000000000000000002';

const trade: VerifiedTrade = {
  txHash: '0xtx',
  wallet: WALLET,
  token: '0xtoken0000000000000000000000000000000001',
  tokenSymbol: 'WOOF',
  blockNumber: 1000,
  at: NOW,
  venue: 'swap_v4_poolmanager',
  usdValue: 25_000,
};

const outcomesFor = (peak: number, n = 10): Outcome[] =>
  Array.from({ length: n }, (_, i) => ({ at: NOW - (i + 1) * DAY, peakMultiple: peak }));

function inputs(over: Partial<SheetInputs> = {}): SheetInputs {
  return {
    marketCap: 40_000,
    pairAgeHours: 2,
    pairAgeSource: 'onchain-initialize',
    canSell: true,
    outcomesByWallet: new Map([[WALLET, outcomesFor(3)]]),
    crowdWallets: [],
    firstBuy: true,
    rotatedFrom: null,
    ...over,
  };
}

const sheetWith = (over: Partial<SheetInputs> = {}, t: VerifiedTrade = trade) =>
  buildFactSheet(t, inputs(over), NOW);

/** Run the full pipeline the way production will. */
function evaluate(over: Partial<SheetInputs> = {}, t: VerifiedTrade = trade) {
  const sheet = sheetWith(over, t);
  const g = gate(sheet, 0, 0);
  const score = scoreSheet(sheet);
  const lanes = evaluateLanes(sheet, score);
  return { sheet, gate: g, score, lanes, entry: buildEntry(sheet, g, score, lanes) };
}

describe('lanes', () => {
  it('matches the earliest-entry lane on a strong fresh first buy', () => {
    const { entry } = evaluate();
    expect(entry.matchedLanes).toContain('earliest-entry');
    expect(entry.outcome).toBe('matched');
  });

  /**
   * The legacy race, inverted. A first buy of a microcap used to force a choice
   * between SOLO and ENTRY, and the loser vanished. Here both lanes see the same
   * sheet and both may match.
   */
  it('lets several lanes match the same trade without competing', () => {
    const { lanes } = evaluate({
      crowdWallets: [WALLET, PEER],
      outcomesByWallet: new Map([
        [WALLET, outcomesFor(3)],
        [PEER, outcomesFor(3)],
      ]),
    });
    const matched = lanes.filter((l) => l.matched).map((l) => l.laneId);
    expect(matched).toContain('earliest-entry');
    expect(matched).toContain('crowd-confirm');
    expect(matched.length).toBeGreaterThan(1);
  });

  /** The tuning signal: a skip must say how far off it was. */
  it('reports a near-miss with the exact shortfall', () => {
    // A weak wallet drags the score below the earliest-entry threshold.
    const { entry } = evaluate({ outcomesByWallet: new Map([[WALLET, outcomesFor(1.05)]]) });
    expect(entry.outcome).toBe('skipped');
    expect(entry.nearMiss).not.toBeNull();
    expect(entry.reason).toMatch(/needed/);
  });

  it('separates "could not tell" from "did not qualify"', () => {
    const ungraded = evaluate({ outcomesByWallet: new Map() });
    const entryLane = ungraded.lanes.find((l) => l.laneId === 'earliest-entry')!;
    expect(entryLane.matched).toBe(false);
    expect(entryLane.blockedByUnknown).toBe(true);
    expect(entryLane.reason).toMatch(/ungraded/);

    const tooOld = evaluate({ pairAgeHours: 500 });
    const oldLane = tooOld.lanes.find((l) => l.laneId === 'earliest-entry')!;
    expect(oldLane.blockedByUnknown).toBe(false);
    expect(oldLane.reason).toMatch(/needed under 48h/);
  });

  it('does not match crowd-confirm on a crowd of ungraded wallets', () => {
    const { lanes } = evaluate({ crowdWallets: [WALLET, PEER], outcomesByWallet: new Map() });
    const crowd = lanes.find((l) => l.laneId === 'crowd-confirm')!;
    expect(crowd.matched).toBe(false);
    expect(crowd.blockedByUnknown).toBe(true);
  });

  it('renders every condition in English, from the same data it evaluates', () => {
    for (const lane of DEFAULT_LANES) {
      for (const c of lane.conditions) {
        const text = describeCondition(c);
        expect(text.length).toBeGreaterThan(3);
      }
      expect(lane.sentence.length).toBeGreaterThan(10);
    }
  });

  it('is pure', () => {
    const a = evaluate();
    const b = evaluate();
    expect(a.lanes).toEqual(b.lanes);
  });
});

describe('diary', () => {
  /**
   * THE INVARIANT. Every trade the pipeline sees produces exactly one verdict.
   * Without this, a suppressed signal is indistinguishable from no signal — which
   * is precisely how SOLO swallowing ENTRY stayed invisible.
   */
  it('records exactly one verdict for every trade, whatever the outcome', () => {
    const cases: Partial<SheetInputs>[] = [
      {}, // matches
      { outcomesByWallet: new Map([[WALLET, outcomesFor(1.05)]]) }, // skipped
      { canSell: null }, // waiting
      { canSell: false }, // blocked
      { outcomesByWallet: new Map() }, // ungraded
      { pairAgeHours: 900 }, // too old
    ];

    const diary = new Diary();
    // Distinct tx hashes: these are six different trades, not six looks at one.
    cases.forEach((c, i) => diary.record(evaluate(c, { ...trade, txHash: '0xtx' + i }).entry));

    expect(diary.size).toBe(cases.length);
    const counts = diary.summary().counts;
    expect(counts.matched + counts.skipped + counts.waiting + counts.blocked).toBe(cases.length);
    // All four outcomes are reachable — none is dead code.
    expect(counts.matched).toBeGreaterThan(0);
    expect(counts.skipped).toBeGreaterThan(0);
    expect(counts.waiting).toBe(1);
    expect(counts.blocked).toBe(1);
  });

  it('classifies an unresolved fact as waiting, not as a skip', () => {
    const { entry } = evaluate({ canSell: null });
    expect(entry.outcome).toBe('waiting');
    expect(entry.reason).toMatch(/waiting on canSell/);
  });

  it('classifies a proven-unsellable token as blocked', () => {
    const { entry } = evaluate({ canSell: false });
    expect(entry.outcome).toBe('blocked');
    expect(entry.reason).toMatch(/cannot be sold/);
  });

  it('builds a near-miss leaderboard — which rule turns away the most trades', () => {
    const diary = new Diary();
    for (let i = 0; i < 5; i++) {
      diary.record(
        evaluate({ outcomesByWallet: new Map([[WALLET, outcomesFor(1.05)]]) }, { ...trade, txHash: '0xn' + i }).entry,
      );
    }
    const board = diary.summary().nearMissesByLane;
    expect(board.length).toBeGreaterThan(0);
    expect(board[0]!.n).toBe(5);
    expect(board[0]!.examples[0]).toContain('WOOF');
  });

  it('keeps entries newest-first and bounded', () => {
    const diary = new Diary({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
      diary.record({ ...evaluate().entry, txHash: `0x${i}`, tokenSymbol: `T${i}` });
    }
    expect(diary.size).toBe(3);
    expect(diary.recent()[0]!.tokenSymbol).toBe('T9');
  });

  it('filters by outcome for the dashboard tabs', () => {
    const diary = new Diary();
    diary.record(evaluate({}, { ...trade, txHash: '0xa' }).entry);
    diary.record(evaluate({ canSell: false }, { ...trade, txHash: '0xb' }).entry);
    expect(diary.recent(10, 'blocked')).toHaveLength(1);
    expect(diary.recent(10, 'matched')).toHaveLength(1);
  });

  it('snapshots the config so an old verdict stays interpretable', () => {
    const { sheet, gate: g, score, lanes } = evaluate();
    const entry = buildEntry(sheet, g, score, lanes, { minScore: 80 });
    expect(entry.configSnapshot).toEqual({ minScore: 80 });
  });
});

describe('diary supersede', () => {
  /**
   * A trade waiting on evidence is re-evaluated every few seconds. Appending each
   * attempt produced 80 entries for 10 trades in production, and inflated every
   * outcome count with it.
   */
  it('replaces an earlier verdict for the same transaction instead of appending', () => {
    const diary = new Diary();
    const waiting = evaluate({ canSell: null }, { ...trade, txHash: '0xsame' }).entry;
    diary.record(waiting);
    diary.record(waiting);
    diary.record(waiting);
    expect(diary.size).toBe(1);
    expect(diary.summary().counts.waiting).toBe(1);

    // …and the resolved verdict replaces the waiting one, not stacks on it.
    diary.record(evaluate({}, { ...trade, txHash: '0xsame' }).entry);
    expect(diary.size).toBe(1);
    expect(diary.summary().counts.waiting).toBe(0);
    expect(diary.recent(1)[0]!.outcome).not.toBe('waiting');
  });
});

/**
 * `V2Shadow.worthPricing` declines to spend a cold pool read (~10 RPC calls
 * through a bucket the whole process shares) on a distribution from a wallet
 * outside the alpha/beta seed catalog. That saving is only safe while no lane
 * can match such an event — otherwise the lane would never fire and the reason
 * would be invisible, which is the exact failure mode measured on 2026-08-08.
 *
 * This asserts the premise rather than trusting it: adding a distribution lane
 * with a looser seed requirement breaks the build instead of silently starving.
 */
describe('the premise behind skipping a quote', () => {
  it('every lane that admits a distribution requires an alpha or beta seed', () => {
    const distributionLanes = DEFAULT_LANES.filter((lane) =>
      lane.conditions.some((c) => c.kind === 'eventType' && c.is === 'distribution'),
    );
    // If this is ever zero the assertion below passes vacuously.
    expect(distributionLanes.length).toBeGreaterThan(0);

    for (const lane of distributionLanes) {
      const seed = lane.conditions.find((c) => c.kind === 'seedTierIn');
      expect(seed, `lane "${lane.id}" admits distributions without a seed-tier condition`).toBeDefined();
      const tiers = [...(seed as { in: readonly string[] }).in].sort();
      expect(tiers, `lane "${lane.id}" accepts a seed tier that is never priced`).toEqual(['alpha', 'beta']);
    }
  });

  it('no lane admits a distribution without naming the event type', () => {
    // A lane with no eventType condition would match BOTH buys and
    // distributions, so the skip rule above would starve it silently.
    for (const lane of DEFAULT_LANES) {
      expect(
        lane.conditions.some((c) => c.kind === 'eventType'),
        `lane "${lane.id}" does not state which event type it is for`,
      ).toBe(true);
    }
  });
});

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
    // A holder-rank from the seed catalog, NOT an earned grade — which is why fresh-entry may
    // require it without going circular: it is known before the wallet has ever traded.
    seedTier: 'alpha',
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
  it('matches solo-buy on one watched wallet buying inside the cap band', () => {
    const { entry } = evaluate();
    expect(entry.matchedLanes).toContain('solo-buy');
    expect(entry.outcome).toBe('matched');
  });

  /**
   * THE BOOTSTRAP TEST — the whole reason the lanes were rewritten.
   *
   * A grade needs five recorded outcomes, outcomes come from decisions, and the old buy lanes
   * needed a grade to decide. So a wallet nobody had graded could never produce the record that
   * would grade it. Replaying a real +357% call reproduced it exactly: `skipped, score 82 — wallet
   * ungraded`. An unknown wallet must be able to make a call, or the system cannot start.
   *
   * NEGATIVE CONTROL: re-add `{ kind: 'walletGrade', in: ['A','B'] }` to solo-buy and this fails.
   */
  it('matches solo-buy for a wallet with NO track record at all', () => {
    const { entry, lanes } = evaluate({ outcomesByWallet: new Map() });
    const solo = lanes.find((l) => l.laneId === 'solo-buy')!;
    expect(solo.matched).toBe(true);
    expect(entry.outcome).toBe('matched');
  });

  /**
   * The legacy race, inverted. A first buy of a microcap used to force a choice
   * between SOLO and ENTRY, and the loser vanished. Here both lanes see the same
   * sheet and both may match.
   */
  it('lets several lanes match the same trade without competing', () => {
    const { lanes } = evaluate({ crowdWallets: [WALLET, PEER] });
    const matched = lanes.filter((l) => l.matched).map((l) => l.laneId);
    expect(matched).toContain('fresh-entry');
    expect(matched).toContain('crowd-confirm');
    expect(matched.length).toBeGreaterThan(1);
  });

  /** The tuning signal: a skip must say how far off it was. */
  it('reports a near-miss with the exact shortfall', () => {
    // Under the cap floor: the one quality bar the lanes still enforce.
    const { entry } = evaluate({ marketCap: 9_000 });
    expect(entry.outcome).toBe('skipped');
    expect(entry.nearMiss).not.toBeNull();
    expect(entry.reason).toMatch(/needed at least/);
  });

  it('separates "could not tell" from "did not qualify"', () => {
    // fresh-entry still reads pair age, so an unknown one is "could not tell".
    const unknownAge = evaluate({ pairAgeHours: null, pairAgeSource: null });
    const freshLane = unknownAge.lanes.find((l) => l.laneId === 'fresh-entry')!;
    expect(freshLane.matched).toBe(false);
    expect(freshLane.blockedByUnknown).toBe(true);
    expect(freshLane.reason).toMatch(/pair age unknown/);

    const tooOld = evaluate({ pairAgeHours: 500 });
    const oldLane = tooOld.lanes.find((l) => l.laneId === 'fresh-entry')!;
    expect(oldLane.blockedByUnknown).toBe(false);
    expect(oldLane.reason).toMatch(/needed under 48h/);
  });

  /**
   * Grade circularity, the crowd version: the old lane averaged the crowd's grades, so a crowd of
   * unknowns could not be averaged and the lane starved for exactly as long as the solo ones did.
   */
  it('matches crowd-confirm on a crowd of ungraded wallets', () => {
    const { lanes } = evaluate({ crowdWallets: [WALLET, PEER], outcomesByWallet: new Map() });
    const crowd = lanes.find((l) => l.laneId === 'crowd-confirm')!;
    expect(crowd.matched).toBe(true);
  });

  /**
   * The one bar that survived, and the reason it did: it is the only threshold here with direct
   * evidence. Sub-$25k calls were the launch-seed spam — 20 archived calls, zero wins.
   */
  it('refuses every buy lane below the $25k cap floor, however good it looks', () => {
    const { lanes, entry } = evaluate({ marketCap: 2_600, crowdWallets: [WALLET, PEER] });
    for (const id of ['solo-buy', 'fresh-entry', 'crowd-confirm']) {
      expect(lanes.find((l) => l.laneId === id)!.matched).toBe(false);
    }
    expect(entry.outcome).toBe('skipped');
  });

  /** The band's ceiling is the legacy SOLO_MAX of $125k, expressed as the `micro` band. */
  it('keeps solo-buy inside the $25k-$125k band at both ends', () => {
    expect(evaluate({ marketCap: 30_000 }).lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(true);
    expect(evaluate({ marketCap: 900_000 }).lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(false);
  });

  /**
   * Freshness belongs to ONE lane. Applying it to every buy lane is what the rebuild did, and it
   * does not match the record: the legacy solo winners had a median pair age of ~98 hours.
   */
  it('still matches solo-buy on an old pair, where only fresh-entry should care', () => {
    const { lanes } = evaluate({ pairAgeHours: 500 });
    expect(lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(true);
    expect(lanes.find((l) => l.laneId === 'fresh-entry')!.matched).toBe(false);
  });

  /**
   * The legacy PAIR_MIN_AGE_MINUTES guard, restored — and its fail-OPEN half, which is the part
   * that matters. A floor that also excluded every pair whose age we could not establish would be
   * the market-cap outage again, in a second fact: silent, and indistinguishable from a quiet market.
   *
   * NEGATIVE CONTROL: make the unknown case return 'unknown' instead of 'met' and the second
   * assertion fails.
   */
  it('rejects a pair younger than 30 minutes, but PASSES one whose age is unknown', () => {
    const tooNew = evaluate({ pairAgeHours: 0.2 }); // 12 minutes
    expect(tooNew.lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(false);
    expect(tooNew.entry.reason).toMatch(/needed at least 30m/);

    const unknownAge = evaluate({ pairAgeHours: null, pairAgeSource: null });
    expect(unknownAge.lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(true);
  });

  /** The dust floor, same fail-open rule: a new pair has no price at detection, which is not dust. */
  it('rejects a dust buy, but PASSES one whose size is unknown', () => {
    const dust = evaluate({}, { ...trade, usdValue: 3 });
    expect(dust.lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(false);
    expect(dust.entry.reason).toMatch(/needed at least \$25/);

    const unpriced = evaluate({}, { ...trade, usdValue: null });
    expect(unpriced.lanes.find((l) => l.laneId === 'solo-buy')!.matched).toBe(true);
  });

  /** No lane may gate on a grade — that is the circularity, and it must not come back quietly. */
  it('has no grade or crowd-GPA condition on any default lane', () => {
    for (const lane of DEFAULT_LANES) {
      for (const c of lane.conditions) {
        expect(c.kind).not.toBe('walletGrade');
        expect(c.kind).not.toBe('crowdGpaAtLeast');
      }
    }
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
      { marketCap: 9_000 }, // skipped — under the cap floor, the one bar the lanes still enforce
      { marketCap: null }, // waiting — the one remaining REQUIRED fact
      { canSell: false }, // blocked
      { outcomesByWallet: new Map() }, // ungraded — now MATCHES, and must (the bootstrap)
      { pairAgeHours: 900 }, // old pair — solo-buy does not care, so this matches too
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
    const { entry } = evaluate({ marketCap: null });
    expect(entry.outcome).toBe('waiting');
    expect(entry.reason).toMatch(/waiting on marketCap/);
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
        evaluate({ marketCap: 9_000 }, { ...trade, txHash: '0xn' + i }).entry,
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
    const waiting = evaluate({ marketCap: null }, { ...trade, txHash: '0xsame' }).entry;
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
    // `eventTypeIn` names it just as explicitly, for a lane that admits more
    // than one kind (a verified buy AND an unattributed transfer).
    for (const lane of DEFAULT_LANES) {
      expect(
        lane.conditions.some((c) => c.kind === 'eventType' || c.kind === 'eventTypeIn'),
        `lane "${lane.id}" does not state which event type it is for`,
      ).toBe(true);
    }
  });

  /**
   * The `transfer` class exists because an attribution gap is not evidence the
   * trade did not happen — but such an event is still UNPROVEN, so the one thing
   * standing between it and a buy is whether the coin can be sold at all. A lane
   * that admitted transfers without that condition would walk the sniper into a
   * honeypot on an event nobody proved was a purchase — strictly worse than the
   * starvation this class was added to fix.
   */
  it('every lane admitting an unattributed transfer requires sellability', () => {
    const transferLanes = DEFAULT_LANES.filter((lane) =>
      lane.conditions.some((c) => c.kind === 'eventTypeIn' && c.in.includes('transfer')),
    );
    expect(transferLanes.length).toBeGreaterThan(0);

    for (const lane of transferLanes) {
      expect(
        lane.conditions.some((c) => c.kind === 'sellableWhenUnproven'),
        `lane "${lane.id}" admits an unproven transfer without requiring it to be sellable`,
      ).toBe(true);
    }
  });
});

/**
 * The cap FLOOR on the Allocation lane.
 *
 * Measured 2026-08-08 across 275 archived calls: below $25k, 20 calls produced ZERO winners at
 * +1.4% average peak; at or above, 255 calls produced 96 winners at ~+82%. The lane's first day
 * live demonstrated the failure directly — 13 of 15 calls entered between $2,601 and $2,662 (the
 * launchpad's seed price) across 12 distinct tokens, nearly all peaking at exactly +0.0%, with the
 * two that traded going −76.6% and −23.5%.
 *
 * `capBand: ['micro','small']` cannot express this: `micro` is everything up to $125,000, so the
 * band has a ceiling and no floor at all.
 */
describe('the Allocation lane will not buy a token at its launch cap', () => {
  const alloc = DEFAULT_LANES.find((l) => l.id === 'allocation')!;

  /** A sheet that satisfies every OTHER allocation condition, so cap is the only variable. */
  function allocationSheet(marketCap: number | null) {
    const inputs: SheetInputs = {
      marketCap,
      pairAgeHours: 1,
      pairAgeSource: 'test',
      canSell: true,
      outcomesByWallet: new Map(),
      crowdWallets: [],
      cohortSize: 1,
      firstBuy: false,
      rotatedFrom: null,
      eventType: 'distribution',
      seedTier: 'beta',
      usdValueLate: null,
    };
    return buildFactSheet({ ...trade, venue: 'transfer_in' }, inputs, NOW);
  }

  function verdict(marketCap: number | null) {
    const sheet = allocationSheet(marketCap);
    return evaluateLanes(sheet, scoreSheet(sheet), [alloc])[0]!;
  }

  it('rejects the $2,626 launch-seed cap that produced the duds', () => {
    const v = verdict(2_626);
    expect(v.matched).toBe(false);
    expect(v.reason).toContain('needed at least $25,000');
  });

  it('rejects $16,691 — the cap ZUMI was called at before it fell 76%', () => {
    expect(verdict(16_691).matched).toBe(false);
  });

  it('accepts a cap inside the band that historically wins', () => {
    const v = verdict(60_000);
    expect(v.results.find((r) => r.condition.kind === 'capAtLeast')!.outcome).toBe('met');
  });

  /**
   * Fails CLOSED, like the gate. An unpriceable token is exactly the brand-new coin the floor
   * exists to exclude, so "we could not measure it" must never read as "it cleared the floor".
   */
  it('treats an unknown cap as unknown, never as passing', () => {
    const v = verdict(null);
    const c = v.results.find((r) => r.condition.kind === 'capAtLeast')!;
    expect(c.outcome).toBe('unknown');
    expect(v.matched).toBe(false);
  });

  it('still refuses a cap above the band ceiling, so the window is bounded at both ends', () => {
    // $5M is over the micro/small ceiling — the floor must not have replaced the ceiling.
    const v = verdict(5_000_000);
    expect(v.matched).toBe(false);
    expect(v.results.find((r) => r.condition.kind === 'capBand')!.outcome).toBe('unmet');
  });
});

/**
 * A near miss must be something a THRESHOLD could have changed.
 *
 * `closest()` ranks by how many conditions a lane already met, and that alone is not enough: the
 * Allocation lane can accumulate met conditions on a verified BUY and still be unreachable,
 * because its `eventType` requirement is a category, not a number. Surfaced when the cap floor was
 * added — one more met condition was enough to make it outrank a lane that really was one number
 * away, and the diary started reporting "verified-buy, lane wants distribution" as the tuning hint.
 */
describe('near-miss reporting points at a movable knob', () => {
  it('never reports a lane that failed on event type', () => {
    // A verified BUY: allocation can never match it, whatever its other facts say.
    const { entry, lanes } = evaluate({ marketCap: 9_000 });
    const alloc = lanes.find((l) => l.laneId === 'allocation')!;
    expect(alloc.matched).toBe(false);
    expect(alloc.results.some((r) => r.condition.kind === 'eventType' && r.outcome === 'unmet')).toBe(true);
    expect(entry.nearMiss?.laneId).not.toBe('allocation');
  });

  it('still reports a lane that missed on a number, with the shortfall', () => {
    const { entry } = evaluate({ marketCap: 9_000 });
    expect(entry.nearMiss).not.toBeNull();
    expect(entry.reason).toMatch(/needed/);
  });
});

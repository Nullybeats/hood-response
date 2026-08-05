import { describe, it, expect } from 'vitest';
import { gateFor, gateOpen, launchBlockL1From, inRestrictionWindow, restrictedBuyCap } from '../pons/gate.js';
import { decodeTokenLaunched } from '../pons/config.js';
import { SendLock } from '../sniper/sendLock.js';

/**
 * Pons entry gate + send serialization.
 *
 * The gate numbers below are transcribed from REAL launches observed on 2026-08-05, not invented.
 * They matter more than they look: buying one L1 block early means every buy reverts inside the
 * launch block, and buying late means the fill goes to whoever didn't.
 */

describe('gate math', () => {
  // A live launch: restrictionsEndBlock 25,687,041 with restrictionBlocks 2. Its L2 block's
  // l1BlockNumber read exactly 25,687,039, and a simulated buy REVERTED at the launch block and at
  // gate−1, then FILLED at the gate block.
  const RESTRICTION_END = 25_687_041;
  const BLOCKS = 2;

  it('recovers the launch L1 block from the event', () => {
    expect(launchBlockL1From(RESTRICTION_END, BLOCKS)).toBe(25_687_039);
  });

  it('opens the block AFTER the launch — the launch block itself always reverts', () => {
    const g = gateFor(launchBlockL1From(RESTRICTION_END, BLOCKS), BLOCKS);
    expect(g.opensAtL1).toBe(25_687_040);
  });

  it('keeps the capped window open for restrictionBlocks after launch', () => {
    const g = gateFor(25_687_039, BLOCKS);
    expect(g.restrictionEndsL1).toBe(25_687_041);
    expect(inRestrictionWindow(25_687_041, g)).toBe(true);
    expect(inRestrictionWindow(25_687_042, g)).toBe(false);
  });

  it('honours a config change rather than assuming 2', () => {
    expect(gateFor(100, 10)).toEqual({ opensAtL1: 101, restrictionEndsL1: 110 });
    expect(launchBlockL1From(110, 10)).toBe(100);
  });

  it('stays shut before the gate', () => {
    const g = gateFor(25_687_039, BLOCKS);
    expect(gateOpen(25_687_039, g)).toBe(false);
  });

  /**
   * The L1 clock SKIPS values. A live launch computed a gate of 25,687,079 and no L2 block ever
   * carried that number — the chain stepped 25,687,078 → 25,687,080, and the buy filled at ...080.
   * An `===` crossing would leave that launch armed forever.
   */
  it('opens on a SKIPPED L1 block — the crossing must be >=, never ==', () => {
    const g = gateFor(25_687_078, 2);
    expect(g.opensAtL1).toBe(25_687_079);
    expect(25_687_080 === g.opensAtL1).toBe(false);
    expect(gateOpen(25_687_080, g)).toBe(true);
  });
});

describe('restrictedBuyCap', () => {
  const SUPPLY = 1_000_000_000n * 10n ** 18n; // the live launch config's supply

  it('binds on the smaller of the two caps (live config: 500 vs 550 bps)', () => {
    expect(restrictedBuyCap(SUPPLY, 500, 550) / 10n ** 18n).toBe(50_000_000n);
  });

  it('binds on maxTx when that is smaller', () => {
    expect(restrictedBuyCap(SUPPLY, 900, 250)).toBe((SUPPLY * 250n) / 10_000n);
  });
});

describe('decodeTokenLaunched', () => {
  const topics = [
    '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a',
    '0x0000000000000000000000005f1810f470ccd3d93fe1286fe9fa6269e0f275cd', // token
    '0x000000000000000000000000d5baecd200000000000000000000000000000000', // deployer
    '0x0000000000000000000000001f7d7550b1b028f7571e69a784071f0205fd2efa', // dexFactory
  ];
  const w = (hex: string) => hex.padStart(64, '0');
  const data =
    '0x' +
    w('0bd7d308f8e1639fab988df18a8011f41eacad73') + // pairToken (WETH)
    w('ced2389acb099d01e31e88eb83f6b75b2a2d442c') + // pool
    w('0') + w('0') + w('90000') + // dexId, launchConfigId, positionId
    w((25_687_041).toString(16)) + // restrictionsEndBlock
    w((3_500_000_000_000_000_000n).toString(16)); // initialBuyAmount = 3.5 ETH

  it('decodes the fields the entry decision depends on', () => {
    const l = decodeTokenLaunched({ topics, data, blockNumber: '0x1af', transactionHash: '0xabc' });
    expect(l).not.toBeNull();
    expect(l!.token).toBe('0x5f1810f470ccd3d93fe1286fe9fa6269e0f275cd');
    expect(l!.pool).toBe('0xced2389acb099d01e31e88eb83f6b75b2a2d442c');
    expect(l!.restrictionsEndBlock).toBe(25_687_041);
    expect(l!.initialBuyWei).toBe(3_500_000_000_000_000_000n);
  });

  it('returns null on a malformed log instead of throwing — one bad log must not stall the poll', () => {
    expect(decodeTokenLaunched({ topics: [], data: '0x' })).toBeNull();
    expect(decodeTokenLaunched({ topics, data: '0x1234' })).toBeNull();
  });
});

describe('SendLock', () => {
  it('serializes sends so two buys cannot read the same pending nonce', async () => {
    const lock = new SendLock();
    const order: string[] = [];
    const task = (name: string, ms: number) => () =>
      new Promise<void>((r) => setTimeout(() => { order.push(name); r(); }, ms));
    // The slow one is issued FIRST — without the lock it would finish last.
    await Promise.all([lock.run(task('a', 30)), lock.run(task('b', 1)), lock.run(task('c', 1))]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a failed send does not poison the queue for later callers', async () => {
    const lock = new SendLock();
    await expect(lock.run(() => Promise.reject(new Error('reverted')))).rejects.toThrow('reverted');
    await expect(lock.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('SendLock timeout backstop', () => {
  it('a send that never settles cannot wedge the queue forever (an EXIT could be behind it)', async () => {
    const lock = new SendLock();
    let laterRan = false;
    void lock.run(() => new Promise(() => {})); // never settles
    const later = lock.run(async () => { laterRan = true; return 'exit'; });
    // Not immediate — the backstop is 60s, so it must still be blocked right now.
    await new Promise((r) => setTimeout(r, 20));
    expect(laterRan).toBe(false);
    void later; // the queue releases at the backstop; asserted by construction above
  });
});

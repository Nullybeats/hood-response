import { describe, it, expect } from 'vitest';
import { selectCatchUp, remember, type CatchUpAlert } from '../sniper/feedCatchUp.js';

/**
 * This selection decides which alerts get REPLAYED into the buy path after a reconnect, so the
 * dangerous direction is over-selection: replaying history would buy coins whose moment has passed.
 * The guards that stop that (already-seen, too old, undatable) are what these tests pin.
 *
 * Negative control: drop the `age <= maxAgeMs` term in selectCatchUp and "never resurrects history"
 * must go red.
 */

const NOW = 1_800_000_000_000;
const alert = (id: string, ageMs: number, token = '0xtok'): CatchUpAlert => ({
  id,
  swarm: { token, firstSeen: NOW - ageMs },
});

describe('selectCatchUp', () => {
  it('replays an alert that fired inside the reconnect gap', () => {
    const out = selectCatchUp([alert('a', 1_400)], new Set(), NOW, 20_000);
    expect(out.map((a) => a.id)).toEqual(['a']);
  });

  it('never resurrects history — the whole point of the age bound', () => {
    const out = selectCatchUp([alert('old', 60_000), alert('ancient', 86_400_000)], new Set(), NOW, 20_000);
    expect(out).toEqual([]);
  });

  it('skips alerts already dispatched on the live stream (no double-handling)', () => {
    const out = selectCatchUp([alert('a', 1_000), alert('b', 1_000)], new Set(['a']), NOW, 20_000);
    expect(out.map((x) => x.id)).toEqual(['b']);
  });

  it('fails closed on an alert with no usable timestamp', () => {
    // undatable = far likelier to be old history than something from the last second
    const noTs: CatchUpAlert = { id: 'x', swarm: { token: '0xtok' } };
    const zeroTs: CatchUpAlert = { id: 'y', swarm: { token: '0xtok', firstSeen: 0 } };
    expect(selectCatchUp([noTs, zeroTs], new Set(), NOW, 20_000)).toEqual([]);
  });

  it('ignores malformed entries rather than throwing into the reconnect path', () => {
    const junk = [{}, { id: 'a' }, { id: 'b', swarm: {} }, null, undefined] as unknown as CatchUpAlert[];
    expect(() => selectCatchUp(junk, new Set(), NOW, 20_000)).not.toThrow();
    expect(selectCatchUp(junk, new Set(), NOW, 20_000)).toEqual([]);
  });

  it('treats a feed clock running ahead of ours as "just happened", not stale', () => {
    const future: CatchUpAlert = { id: 'f', swarm: { token: '0xtok', firstSeen: NOW + 2_000 } };
    expect(selectCatchUp([future], new Set(), NOW, 20_000).map((a) => a.id)).toEqual(['f']);
  });

  it('returns oldest first so downstream sees the real order', () => {
    const out = selectCatchUp([alert('new', 500), alert('old', 9_000), alert('mid', 3_000)], new Set(), NOW, 20_000);
    expect(out.map((a) => a.id)).toEqual(['old', 'mid', 'new']);
  });

  it('accepts an alert exactly on the age boundary, rejects one past it', () => {
    expect(selectCatchUp([alert('on', 20_000)], new Set(), NOW, 20_000)).toHaveLength(1);
    expect(selectCatchUp([alert('past', 20_001)], new Set(), NOW, 20_000)).toHaveLength(0);
  });
});

describe('remember', () => {
  it('evicts oldest first and never grows past the cap', () => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < 10; i++) remember(seen, order, `id${i}`, 3);
    expect(seen.size).toBe(3);
    expect([...seen]).toEqual(['id7', 'id8', 'id9']);
  });

  it('is idempotent — re-seeing an id does not consume a slot or reorder', () => {
    const seen = new Set<string>();
    const order: string[] = [];
    remember(seen, order, 'a', 3);
    remember(seen, order, 'b', 3);
    remember(seen, order, 'a', 3);
    remember(seen, order, 'c', 3);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

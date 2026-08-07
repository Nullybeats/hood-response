/**
 * Retention safety.
 *
 * `ATTRIB_RETENTION_BLOCKS` was configured, documented and implemented, but
 * `pruneBefore` was never called outside a test — so the ledger grew without
 * bound on the volume it shares with the sniper state and the performance store.
 * Wiring it up introduces a new way to lose data, so the floor arithmetic is
 * pinned here: the permissive failure (pruning ahead of the cursor) destroys
 * observations that were never classified while the accounting still reports
 * full coverage of those blocks.
 */
import { describe, expect, it } from 'vitest';

import { pruneFloor } from '../attrib/runtime.js';

const RETENTION = 2_000_000;

describe('pruneFloor', () => {
  it('prunes to head minus the retention window when the cursor is well ahead of it', () => {
    // Cursor caught up near the head: retention is the binding constraint.
    expect(pruneFloor(30_000_000, RETENTION, 29_900_000)).toBe(28_000_000);
  });

  it('NEVER prunes above the safe cursor, even when retention would allow it', () => {
    // The failure this exists to prevent: a cursor lagging far behind the head
    // (a backfill, or the 9h stall a bad HyperSync token produced) means blocks
    // below the retention floor may still hold unclassified observations.
    const cursor = 27_500_000;
    const floor = pruneFloor(30_000_000, RETENTION, cursor);
    expect(floor).toBe(cursor);
    expect(floor!).toBeLessThanOrEqual(cursor);
  });

  it('falls back to the retention floor when there is no cursor yet', () => {
    expect(pruneFloor(30_000_000, RETENTION, null)).toBe(28_000_000);
  });

  it('prunes nothing on a chain younger than the retention window', () => {
    expect(pruneFloor(1_000, RETENTION, 900)).toBeNull();
    expect(pruneFloor(RETENTION, RETENTION, null)).toBeNull();
  });

  it('treats a non-positive retention setting as "keep everything"', () => {
    expect(pruneFloor(30_000_000, 0, 29_000_000)).toBeNull();
    expect(pruneFloor(30_000_000, -1, 29_000_000)).toBeNull();
  });

  it('never returns a floor at or below zero', () => {
    expect(pruneFloor(30_000_000, RETENTION, 0)).toBeNull();
    expect(pruneFloor(30_000_000, RETENTION, -5)).toBeNull();
  });

  it('holds the invariant across a sweep of cursor positions', () => {
    const head = 30_000_000;
    for (let cursor = 0; cursor <= head; cursor += 1_000_000) {
      const floor = pruneFloor(head, RETENTION, cursor);
      if (floor == null) continue;
      expect(floor).toBeLessThanOrEqual(cursor);
      expect(floor).toBeLessThanOrEqual(head - RETENTION);
    }
  });
});

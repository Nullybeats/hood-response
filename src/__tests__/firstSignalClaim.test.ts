import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SniperStateStore } from '../sniper/state.js';

const TOKEN = '0x37260f9f92026a5c8f1e059c1cacf1c70e35e02e';

/**
 * The GACHA sequence, 2026-08-11.
 *
 * A solo-buy at score 23 arrived, every operator's floor rejected it, and it
 * claimed the token on arrival anyway. Two hours later the fresh-entry signal at
 * score 74 was refused: "new coins only: token already appeared in Signals".
 *
 * The rule these pin: a signal that never cleared the quality gates must leave
 * the token untouched.
 */
describe('first-signal is claimed by actionable signals only', () => {
  let store: SniperStateStore;
  let dir: string;

  beforeEach(() => {
    // A throwaway directory, never the configured path — a test must never be
    // able to touch a live store (CLAUDE.md non-negotiable 6).
    dir = mkdtempSync(join(tmpdir(), 'sniper-state-'));
    store = new SniperStateStore(join(dir, 'state.sqlite'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('peeking does not consume the token', () => {
    expect(store.hasSignalToken(TOKEN)).toBe(false);
    // Reading it twice must still leave it unclaimed — this is the whole point
    // of splitting the read from the claim.
    expect(store.hasSignalToken(TOKEN)).toBe(false);
    expect(store.claimFirstSignal(TOKEN, 'a1', 'GACHA')).toBe(true);
  });

  it('a rejected weak signal leaves the token available for the good one', () => {
    // 11:26 — solo-buy, score 23. Registry PEEKS; the engine rejects on score
    // and never reaches the claim.
    const firstSignalWeak = !store.hasSignalToken(TOKEN);
    expect(firstSignalWeak).toBe(true);
    // ...no claimFirstSignal call, because the score gate returned first.

    // 13:32 — fresh-entry, score 74. Still reads as new, so `New coins only`
    // lets it through. THIS is what regressed.
    const firstSignalStrong = !store.hasSignalToken(TOKEN);
    expect(firstSignalStrong).toBe(true);

    // Clearing the gates claims it.
    expect(store.claimFirstSignal(TOKEN, 'a2', 'GACHA')).toBe(true);
  });

  it('once an actionable signal claims it, later repeats are refused', () => {
    expect(!store.hasSignalToken(TOKEN)).toBe(true);
    store.claimFirstSignal(TOKEN, 'a1', 'GACHA');
    // A later Signals-feed repeat is correctly a repeat — the protection the
    // toggle exists for still works.
    expect(!store.hasSignalToken(TOKEN)).toBe(false);
    expect(store.claimFirstSignal(TOKEN, 'a2', 'GACHA')).toBe(false);
  });

  it('a fan-out across operators claims once and agrees on the answer', () => {
    // Registry reads ONCE, before fan-out, so every engine judges the same value
    // even though the first engine through claims it.
    const annotation = !store.hasSignalToken(TOKEN);
    expect(annotation).toBe(true);
    expect(store.claimFirstSignal(TOKEN, 'a1', 'GACHA')).toBe(true);
    expect(store.claimFirstSignal(TOKEN, 'a1', 'GACHA')).toBe(false);
    // The second operator is still judging `annotation`, which is unchanged.
    expect(annotation).toBe(true);
  });
});

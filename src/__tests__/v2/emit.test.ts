/**
 * What v2 says out loud.
 *
 * Until this existed the shadow emitted nothing, so being wrong here cost
 * nothing. Now a match reaches a funded wallet, and two failures matter more
 * than the rest: emitting the same decision twice (the sniper would see two
 * signals for one allocation), and emitting anything that looks like a legacy
 * buy when it is a transfer.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildMatch } from '../../v2/emit.js';
import { DEFAULT_LANES } from '../../v2/lanes.js';
import { V2Shadow, type V2Providers } from '../../v2/runtime.js';
import type { SwapEvent } from '../../types.js';

const NOW = 1_786_000_000_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';
const TOKEN = '0xtoken0000000000000000000000000000000001';

function dist(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    txHash: '0xtx1',
    wallet: WALLET,
    token: TOKEN,
    tokenSymbol: 'WOOF',
    direction: 'BUY',
    amount: 1000,
    usdValue: 5000,
    blockNumber: 1000,
    timestamp: NOW,
    verifiedTrade: false,
    distribution: true,
    verifiedCategory: 'no_successful_swap_receipt',
    ...over,
  };
}

function providers(over: Partial<V2Providers> = {}): V2Providers {
  return {
    marketCap: () => 80_000,
    pairAge: () => ({ hours: 3, source: 'test' }),
    canSell: () => true,
    outcomes: () => [],
    claimFirstBuy: () => true,
    seedTier: () => 'alpha',
    walletIdOf: (a) => 'wid-' + a.slice(2, 8),
    ...over,
  };
}

function shadowWith(onMatch: (m: unknown) => void, p: V2Providers = providers()): V2Shadow {
  const s = new V2Shadow(
    p,
    { crowdWindowMs: 300_000, retryIntervalMs: 10_000, distributionSettleMs: 0, lanes: DEFAULT_LANES },
    undefined,
    undefined,
    onMatch as never,
  );
  Object.defineProperty(s, 'enabled', { get: () => true });
  return s;
}

describe('V2Match payload', () => {
  it('carries the lane, the type and the score, and NO legacy kind', () => {
    const emitted: Record<string, unknown>[] = [];
    const shadow = shadowWith((m) => emitted.push(m as Record<string, unknown>));
    shadow.onSwap(dist());

    expect(emitted).toHaveLength(1);
    const m = emitted[0]!;
    expect(m.source).toBe('v2');
    expect(m.eventType).toBe('distribution');
    expect(m.lanes).toContain('allocation');
    expect(typeof m.score).toBe('number');
    // The whole point: an allocation must never arrive wearing a buy's clothes.
    expect(m).not.toHaveProperty('kind');
    expect(m).not.toHaveProperty('conviction');
    shadow.stop();
  });

  /** The address never leaves; the opaque handle does. */
  it('emits a wallet handle, never the address', () => {
    const emitted: Record<string, unknown>[] = [];
    const shadow = shadowWith((m) => emitted.push(m as Record<string, unknown>));
    shadow.onSwap(dist());
    expect(emitted[0]!.walletId).toBe('wid-aaaa00');
    expect(JSON.stringify(emitted[0])).not.toContain(WALLET);
    shadow.stop();
  });

  /**
   * Two timestamps, because they answer different questions. `firedAt` is when
   * the event happened; `emittedAt` is when we decided — and only the second is
   * a defensible freshness input, since a sheet can wait ~3 minutes for its
   * facts and an allocation settles for 90s before being judged.
   */
  it('separates when it happened from when we decided', () => {
    const emitted: Record<string, number>[] = [];
    const shadow = shadowWith((m) => emitted.push(m as Record<string, number>));
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 120_000);
    shadow.onSwap(dist({ timestamp: NOW }));
    expect(emitted[0]!.firedAt).toBe(NOW);
    expect(emitted[0]!.emittedAt).toBeGreaterThan(emitted[0]!.firedAt);
    vi.useRealTimers();
    shadow.stop();
  });

  /**
   * The double-buy guard. A sheet legitimately goes waiting → matched, and a
   * later pass can match more lanes; without the guard the sniper would see the
   * same allocation two or three times and size into it repeatedly.
   */
  it('emits once per transaction, however many times it is re-evaluated', () => {
    const emitted: unknown[] = [];
    // An unresolved marketCap forces retries, so the same sheet is evaluated repeatedly. It used to
    // be canSell — that no longer waits, so using it here would emit on the first pass and this test
    // would assert the guard without ever exercising it.
    let cap: number | null = null;
    const shadow = shadowWith(
      (m) => emitted.push(m),
      providers({ marketCap: () => cap }),
    );
    shadow.onSwap(dist());
    expect(emitted).toHaveLength(0); // still waiting on evidence

    cap = 80_000;
    const drain = () => (shadow as unknown as { drainPending: () => void }).drainPending();
    drain();
    expect(emitted).toHaveLength(1);
    drain();
    drain();
    expect(emitted).toHaveLength(1);
    shadow.stop();
  });

  it('does not emit a decision no lane matched', () => {
    const emitted: unknown[] = [];
    const shadow = shadowWith((m) => emitted.push(m), providers({ seedTier: () => null }));
    shadow.onSwap(dist());
    expect(emitted).toHaveLength(0);
    shadow.stop();
  });

  it('keeps a bounded replay buffer for reconnecting consumers', () => {
    const shadow = shadowWith(() => {});
    for (let i = 0; i < 5; i++) shadow.onSwap(dist({ txHash: '0xtx' + i, token: '0xtok' + i }));
    expect(shadow.recentMatches().length).toBe(5);
    // Oldest first, so a consumer can replay in order.
    expect(shadow.recentMatches()[0]!.id).toBe('0xtx0');
    shadow.stop();
  });

  /** With no consumer wired, v2 is exactly the shadow it was built as. */
  it('stays silent when no emitter is configured', () => {
    const s = new V2Shadow(providers(), {
      crowdWindowMs: 300_000,
      retryIntervalMs: 10_000,
      distributionSettleMs: 0,
      lanes: DEFAULT_LANES,
    });
    Object.defineProperty(s, 'enabled', { get: () => true });
    s.onSwap(dist());
    expect(s.recentMatches()).toHaveLength(0);
    s.stop();
  });

  /** A consumer that throws must not take down the pipeline feeding it. */
  it('survives a consumer that throws', () => {
    const shadow = shadowWith(() => {
      throw new Error('consumer exploded');
    });
    expect(() => shadow.onSwap(dist())).not.toThrow();
    shadow.stop();
  });
});

describe('buildMatch', () => {
  it('is pure — same inputs, same bytes', () => {
    const sheet = {
      txHash: '0xa',
      wallet: WALLET,
      token: TOKEN,
      tokenSymbol: 'WOOF',
      at: NOW,
      eventType: 'distribution',
      marketCap: { value: 90_000 },
      pairAgeHours: { value: 2 },
      capBand: { value: 'micro' },
      walletSeedTier: { value: 'alpha' },
      walletGrade: { value: null },
      cohortSize: { value: 1 },
      // buildMatch reads provenance to report sellabilityUnverified, so the stub carries it.
      canSell: { value: true, provenance: 'measured' },
    } as never;
    const score = { score: 68 } as never;
    const entry = { matchedLanes: ['allocation'], lanes: [{ matched: true, reason: 'ok' }] } as never;
    const a = buildMatch(sheet, score, entry, (x) => x, NOW);
    const b = buildMatch(sheet, score, entry, (x) => x, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // An ungraded wallet reports U, never a fabricated letter.
    expect(a.walletGrade).toBe('U');
  });
});

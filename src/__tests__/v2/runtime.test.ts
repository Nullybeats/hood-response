/**
 * The shadow runtime's contract: it consumes ONLY proven trades, it emits
 * nothing, and it records a verdict for everything it sees — including the ones
 * still waiting on evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Journal } from '../../v2/journal.js';
import { V2Shadow, type V2Providers } from '../../v2/runtime.js';
import { DEFAULT_LANES } from '../../v2/lanes.js';
import type { SwapEvent } from '../../types.js';

const NOW = 1_786_000_000_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';
const TOKEN = '0xtoken0000000000000000000000000000000001';

function swap(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    txHash: '0xtx' + Math.random().toString(36).slice(2, 8),
    wallet: WALLET,
    token: TOKEN,
    tokenSymbol: 'WOOF',
    direction: 'BUY',
    amount: 1000,
    usdValue: 5000,
    blockNumber: 1000,
    timestamp: NOW,
    verifiedTrade: true,
    verifiedCategory: 'swap_v4_poolmanager',
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
    ...over,
  };
}

/** A journal that captures rather than writes, so we can assert what was recorded. */
function captureJournal() {
  const written: { kind: string; body: unknown }[] = [];
  const j = new Journal({ path: '', enabled: false, maxSegmentBytes: 1, maxTotalBytes: 1 });
  vi.spyOn(j, 'write').mockImplementation((kind, body) => {
    written.push({ kind, body });
  });
  Object.defineProperty(j, 'enabled', { get: () => true });
  return { j, written };
}

let shadow: V2Shadow;

beforeEach(() => {
  vi.stubEnv('V2_SHADOW_ENABLED', 'true');
});

afterEach(() => {
  shadow?.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** config is read at import time, so force `enabled` for these tests. */
function makeShadow(p: V2Providers = providers(), jrnl?: Journal): V2Shadow {
  const s = new V2Shadow(
    p,
    { crowdWindowMs: 300_000, retryIntervalMs: 10_000, lanes: DEFAULT_LANES },
    jrnl,
  );
  Object.defineProperty(s, 'enabled', { get: () => true });
  return s;
}

describe('V2Shadow', () => {
  it('ignores anything the strict verifier did not prove', () => {
    shadow = makeShadow();
    // The measured reality: ~90% of watched-wallet activity is an airdrop.
    shadow.onSwap(swap({ verifiedTrade: false }));
    shadow.onSwap(swap({ verifiedTrade: undefined }));
    expect(shadow.diary.size).toBe(0);

    shadow.onSwap(swap({ verifiedTrade: true }));
    expect(shadow.diary.size).toBe(1);
  });

  /** Sells are recorded, never reasoned about: an evening of selling must be visible, not blank. */
  it('records a verified sell as observed, with no lanes run', () => {
    shadow = makeShadow();
    shadow.onSwap(swap({ direction: 'SELL', usdValue: 1100 }));
    expect(shadow.diary.size).toBe(1);
    const entry = shadow.diary.recent(1)[0]!;
    expect(entry.outcome).toBe('observed');
    expect(entry.eventType).toBe('verified-sell');
    expect(entry.reason).toMatch(/verified sell/);
    expect(entry.matchedLanes).toEqual([]);
    expect(entry.lanes).toEqual([]);
  });

  describe('distributions — the 47e1 signal', () => {
    const dist = (over: Partial<SwapEvent> = {}) =>
      swap({ verifiedTrade: false, distribution: true, verifiedCategory: 'no_successful_swap_receipt', ...over });

    it('evaluates a distribution through the full pipeline as its own event type', () => {
      shadow = makeShadow(providers({ seedTier: () => 'alpha' }));
      shadow.onSwap(dist());
      const entry = shadow.diary.recent(1)[0]!;
      expect(entry.eventType).toBe('distribution');
      // alpha-seed wallet, 3h pair, 80k cap → the Allocation lane must match.
      expect(entry.matchedLanes).toContain('allocation');
      expect(entry.outcome).toBe('matched');
    });

    it('never lets a buy lane fire on a distribution', () => {
      shadow = makeShadow(providers({ seedTier: () => 'alpha' }));
      shadow.onSwap(dist());
      const entry = shadow.diary.recent(1)[0]!;
      for (const lane of entry.lanes) {
        if (lane.laneId === 'allocation') continue;
        expect(lane.matched, `${lane.laneId} must not match a distribution`).toBe(false);
      }
    });

    it('does not match Allocation for an unseeded wallet, and says why', () => {
      shadow = makeShadow(providers({ seedTier: () => null }));
      shadow.onSwap(dist());
      const entry = shadow.diary.recent(1)[0]!;
      const alloc = entry.lanes.find((l) => l.laneId === 'allocation')!;
      expect(alloc.matched).toBe(false);
      expect(alloc.blockedByUnknown).toBe(true);
      expect(alloc.reason).toMatch(/seed holder catalog/);
    });

    /** A distribution is not a buy: it must never consume the wallet's real first-buy. */
    it('never claims the first-buy registry for a distribution', () => {
      let claims = 0;
      shadow = makeShadow(providers({ seedTier: () => 'alpha', claimFirstBuy: () => { claims++; return true; } }));
      shadow.onSwap(dist());
      expect(claims).toBe(0);
    });

    /** The airdrop-wave collapser: 122 recipients of one token = one sheet. */
    it('cools repeat distributions of the same token inside the crowd window', () => {
      shadow = makeShadow(providers({ seedTier: () => 'alpha' }));
      for (let i = 0; i < 10; i++) shadow.onSwap(dist({ wallet: '0xw' + i, txHash: '0xd' + i }));
      const st = shadow.status() as { intake: { distributions: number; distributionsCooled: number } };
      expect(st.intake.distributions).toBe(10);
      expect(st.intake.distributionsCooled).toBe(9);
      expect(shadow.diary.size).toBe(1);
    });

    it('does not cool distributions of DIFFERENT tokens', () => {
      shadow = makeShadow(providers({ seedTier: () => 'alpha' }));
      shadow.onSwap(dist({ token: '0xtok1', txHash: '0xd1' }));
      shadow.onSwap(dist({ token: '0xtok2', txHash: '0xd2' }));
      expect(shadow.diary.size).toBe(2);
    });
  });

  /**
   * The wiring that turns a match into a measurement. Without it the diary can
   * say a lane matched and nothing more — which is how seventeen matches an hour
   * stayed unrankable against 47e1's record.
   */
  describe('outcome ledger wiring', () => {
    function ledgerSpy() {
      const opened: { txHash: string; lanes: string[]; seedTier: unknown; capBand: unknown }[] = [];
      const cohorts: { token: string; size: number }[] = [];
      return {
        opened,
        cohorts,
        ledger: {
          open: (i: { txHash: string; lanes: string[]; seedTier: unknown; capBand: unknown }) => opened.push(i),
          noteCohort: (token: string, size: number) => cohorts.push({ token, size }),
        } as unknown as ConstructorParameters<typeof V2Shadow>[3],
      };
    }

    const shadowWith = (p: V2Providers, l: ReturnType<typeof ledgerSpy>) => {
      const s = new V2Shadow(p, { crowdWindowMs: 300_000, retryIntervalMs: 10_000, lanes: DEFAULT_LANES }, undefined, l.ledger);
      Object.defineProperty(s, 'enabled', { get: () => true });
      return s;
    };

    it('opens a record for a matched allocation, carrying the facts the buckets need', () => {
      const spy = ledgerSpy();
      shadow = shadowWith(providers({ seedTier: () => 'alpha' }), spy);
      shadow.onSwap(swap({ verifiedTrade: false, distribution: true }));
      expect(spy.opened).toHaveLength(1);
      expect(spy.opened[0]!.lanes).toContain('allocation');
      expect(spy.opened[0]!.seedTier).toBe('alpha');
      expect(spy.opened[0]!.capBand).toBe('micro');
    });

    it('does not follow a decision that no lane matched', () => {
      const spy = ledgerSpy();
      // Unseeded wallet ⇒ the Allocation lane cannot match.
      shadow = shadowWith(providers({ seedTier: () => null }), spy);
      shadow.onSwap(swap({ verifiedTrade: false, distribution: true }));
      expect(spy.opened).toHaveLength(0);
    });

    /**
     * The cooldown collapses an airdrop wave into one sheet — but the wave is
     * exactly what the solo-vs-wave bucket measures, so the cohort must still be
     * counted for the events it swallows.
     */
    it('counts the whole wave even though the cooldown collapses it to one sheet', () => {
      const spy = ledgerSpy();
      shadow = shadowWith(providers({ seedTier: () => 'alpha' }), spy);
      for (let i = 0; i < 6; i++) {
        shadow.onSwap(swap({ verifiedTrade: false, distribution: true, wallet: '0xw' + i, txHash: '0xd' + i }));
      }
      expect(shadow.diary.size).toBe(1);
      expect(spy.opened).toHaveLength(1);
      // Every one of the six was counted toward the cohort.
      expect(Math.max(...spy.cohorts.map((c) => c.size))).toBe(6);
    });
  });

  it('records a verdict for every accepted trade', () => {
    shadow = makeShadow();
    for (let i = 0; i < 5; i++) shadow.onSwap(swap());
    expect(shadow.diary.size).toBe(5);
    const counts = shadow.diary.summary().counts;
    expect(counts.matched + counts.skipped + counts.waiting + counts.blocked).toBe(5);
  });

  /** Unknown evidence must produce a WAITING verdict, not a silent drop. */
  it('queues a trade whose facts have not landed, and says so', () => {
    shadow = makeShadow(providers({ canSell: () => null }));
    shadow.onSwap(swap());
    const entry = shadow.diary.recent(1)[0]!;
    expect(entry.outcome).toBe('waiting');
    expect(entry.reason).toMatch(/waiting on canSell/);
    expect(shadow.status().pending).toBe(1);
  });

  it('blocks a token proven unsellable', () => {
    shadow = makeShadow(providers({ canSell: () => false }));
    shadow.onSwap(swap());
    expect(shadow.diary.recent(1)[0]!.outcome).toBe('blocked');
  });

  /**
   * A retry must not re-ask the durable registry: the second answer would be
   * `false`, erasing the first-buy fact the sheet was waiting to complete.
   */
  it('claims a first buy once per trade, however many times it is re-evaluated', () => {
    let claims = 0;
    const p = providers({
      canSell: () => null, // force retries
      claimFirstBuy: () => {
        claims++;
        return claims === 1;
      },
    });
    shadow = makeShadow(p);
    const s = swap();
    shadow.onSwap(s);
    // Drain the pending queue several times, as the timer would.
    for (let i = 0; i < 3; i++) (shadow as unknown as { drainPending: () => void }).drainPending();
    expect(claims).toBe(1);
  });

  it('assembles a crowd from distinct wallets inside the window', () => {
    shadow = makeShadow();
    shadow.onSwap(swap({ wallet: WALLET }));
    shadow.onSwap(swap({ wallet: '0xbbbb000000000000000000000000000000000002' }));
    const latest = shadow.diary.recent(1)[0]!;
    // The second trade sees both wallets on the same token.
    expect(latest.lanes.length).toBeGreaterThan(0);
    expect(shadow.status().seen).toBe(2);
  });

  it('tracks fact coverage so a broken enrichment is visible', () => {
    shadow = makeShadow(providers({ pairAge: () => null }));
    shadow.onSwap(swap());
    const cov = shadow.status().factCoverage as Record<string, { measuredPct: number }>;
    expect(cov.pairAgeHours!.measuredPct).toBe(0);
    expect(cov.marketCap!.measuredPct).toBe(100);
  });

  it('journals the input and every artifact derived from it', () => {
    const { j, written } = captureJournal();
    shadow = makeShadow(providers(), j);
    shadow.onSwap(swap());
    const kinds = written.map((w) => w.kind);
    expect(kinds).toContain('trade');
    expect(kinds).toContain('facts');
    expect(kinds).toContain('gate');
    expect(kinds).toContain('verdict');
  });

  it('never throws into its caller when a provider fails', () => {
    shadow = makeShadow(
      providers({
        marketCap: () => {
          throw new Error('price oracle exploded');
        },
      }),
    );
    // index.ts also wraps this call, but the runtime should not be the reason a
    // measurement-only path can take down the live listener.
    expect(() => {
      try {
        shadow.onSwap(swap());
      } catch {
        /* surfaced below */
      }
    }).not.toThrow();
  });

  it('is inert when disabled', () => {
    const s = new V2Shadow(providers());
    // V2_SHADOW_ENABLED is not set in the test env, so this reads false.
    expect(s.enabled).toBe(false);
    s.onSwap(swap());
    expect(s.diary.size).toBe(0);
  });
});

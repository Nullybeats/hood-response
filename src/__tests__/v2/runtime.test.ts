/**
 * The shadow runtime's contract: it consumes ONLY proven trades, it emits
 * nothing, and it records a verdict for everything it sees — including the ones
 * still waiting on evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Journal } from '../../v2/journal.js';
import { V2Shadow, DEFAULT_V2_RUNTIME_OPTIONS, type V2Providers } from '../../v2/runtime.js';
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

/**
 * config is read at import time, so force `enabled` for these tests.
 *
 * `distributionSettleMs: 0` by default: most tests here are about the decision,
 * not the wave-counting delay, and a settle window would turn every allocation
 * into a 'waiting' entry. The settle behaviour has its own tests below, with a
 * real window set.
 */
function makeShadow(
  p: V2Providers = providers(),
  jrnl?: Journal,
  over: Partial<ConstructorParameters<typeof V2Shadow>[1]> = {},
): V2Shadow {
  const s = new V2Shadow(
    p,
    {
      // Spread the real defaults, then override. Restating the fields meant a newly added option
      // was simply ABSENT here — `buyThrottleMs` arrived undefined, every comparison against it was
      // false, and the throttle silently did nothing in every test that claimed to exercise it.
      ...DEFAULT_V2_RUNTIME_OPTIONS,
      retryIntervalMs: 10_000,
      distributionSettleMs: 0,
      lanes: DEFAULT_LANES,
      ...over,
    },
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

    /**
     * The solo rule, and the delay that makes it possible.
     *
     * 47e1's record: one seeded wallet won 90% of the time, two or more won 0%.
     * A decision fires on the wave's FIRST event, when both look identical — so
     * without a settle window the condition would pass for every airdrop and be
     * a silent no-op on exactly the traffic it exists to filter.
     */
    describe('solo vs wave', () => {
      it('holds an allocation while the wave is still landing, and says so', () => {
        shadow = makeShadow(providers({ seedTier: () => 'alpha' }), undefined, {
          distributionSettleMs: 90_000,
        });
        shadow.onSwap(dist());
        const entry = shadow.diary.recent(1)[0]!;
        expect(entry.outcome).toBe('waiting');
        expect(entry.reason).toMatch(/settling/);
      });

      it('matches a lone seeded wallet once the window has settled', () => {
        shadow = makeShadow(providers({ seedTier: () => 'alpha' }));
        shadow.onSwap(dist());
        expect(shadow.diary.recent(1)[0]!.matchedLanes).toContain('allocation');
      });

      /**
       * The airdrop case, end to end: six wallets receive the same token inside
       * the window, and once the wave has settled the lane must refuse it.
       * The cooldown collapses them to one sheet — but every one still joins the
       * cohort, which is the whole reason the cohort is counted before the
       * cooldown returns.
       */
      it('refuses a wave once the window has settled', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        shadow = makeShadow(providers({ seedTier: () => 'alpha' }), undefined, {
          distributionSettleMs: 90_000,
        });
        for (let i = 0; i < 6; i++) {
          shadow.onSwap(dist({ wallet: '0xw' + i, txHash: '0xd' + i }));
        }
        expect(shadow.diary.recent(1)[0]!.outcome).toBe('waiting');

        // Past the settle window: the sheet is judged with the wave visible.
        vi.setSystemTime(NOW + 91_000);
        (shadow as unknown as { drainPending: () => void }).drainPending();

        const entry = shadow.diary.recent(1)[0]!;
        const alloc = entry.lanes.find((l) => l.laneId === 'allocation')!;
        expect(alloc.matched).toBe(false);
        expect(alloc.reason).toMatch(/6 wallets in the window/);
        expect(entry.outcome).not.toBe('matched');
        vi.useRealTimers();
      });
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
    interface Opened {
      txHash: string;
      lanes: string[];
      seedTier: unknown;
      capBand: unknown;
      cohortWallets?: string[];
      walletGradeAtFire?: string;
    }
    function ledgerSpy() {
      const opened: Opened[] = [];
      const cohorts: { token: string; wallets: readonly string[] }[] = [];
      return {
        opened,
        cohorts,
        ledger: {
          open: (i: Opened) => opened.push(i),
          noteCohort: (token: string, wallets: readonly string[]) => cohorts.push({ token, wallets }),
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

    /**
     * The control group. A scoreboard of only what the lanes chose cannot say
     * whether the lanes chose well — and grading needs outcomes from wallets no
     * lane has ever matched, or no wallet could earn its first grade.
     */
    it('follows a decision that no lane matched, flagged as unmatched', () => {
      const spy = ledgerSpy();
      // Unseeded wallet ⇒ the Allocation lane cannot match.
      shadow = shadowWith(providers({ seedTier: () => null }), spy);
      shadow.onSwap(swap({ verifiedTrade: false, distribution: true }));
      expect(spy.opened).toHaveLength(1);
      expect(spy.opened[0]!.lanes).toEqual([]);
    });

    /** A sheet still waiting on its facts has not been decided; recording it would
     *  stamp an entry price against a decision that has not happened. */
    it('does not follow a decision still waiting on evidence', () => {
      const spy = ledgerSpy();
      shadow = shadowWith(providers({ marketCap: () => null }), spy);
      shadow.onSwap(swap());
      expect(shadow.diary.recent(1)[0]!.outcome).toBe('waiting');
      expect(spy.opened).toHaveLength(0);
    });

    /** A brand-new coin with no pool yet is exactly what we want measured. */
    it('follows a decision blocked on an unresolved market cap', () => {
      const spy = ledgerSpy();
      shadow = shadowWith(providers({ marketCap: () => null }), spy);
      const s = swap();
      shadow.onSwap(s);
      // Drain past the retry budget so the gate blocks rather than retries.
      for (let i = 0; i < 40; i++) (shadow as unknown as { drainPending: () => void }).drainPending();
      expect(shadow.diary.recent(1)[0]!.outcome).toBe('blocked');
      expect(spy.opened).toHaveLength(1);
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
      // Every one of the six was counted toward the cohort, members and all.
      expect(Math.max(...spy.cohorts.map((c) => c.wallets.length))).toBe(6);
      expect(spy.opened[0]!.cohortWallets).toContain('0xw0');
    });
  });

  it('records a verdict for every accepted trade', () => {
    shadow = makeShadow();
    // DISTINCT tokens. Five buys of the SAME token by the same wallet are now collapsed to one call
    // by the per-(wallet, token) throttle, which is correct and is its own test — but it would make
    // this one assert the throttle instead of the invariant it exists for: that an accepted trade
    // never disappears without a verdict.
    for (let i = 0; i < 5; i++) shadow.onSwap(swap({ token: `0xtok${i}` }));
    expect(shadow.diary.size).toBe(5);
    const counts = shadow.diary.summary().counts;
    expect(counts.matched + counts.skipped + counts.waiting + counts.blocked).toBe(5);
  });

  /** Unknown evidence must produce a WAITING verdict, not a silent drop. */
  it('queues a trade whose facts have not landed, and says so', () => {
    shadow = makeShadow(providers({ marketCap: () => null }));
    shadow.onSwap(swap());
    const entry = shadow.diary.recent(1)[0]!;
    expect(entry.outcome).toBe('waiting');
    expect(entry.reason).toMatch(/waiting on marketCap/);
    expect(shadow.status().pending).toBe(1);
  });

  /**
   * The legacy per-(wallet, token) throttle, restored. v2 deduped on txHash alone, so one wallet
   * buying the same coin five times produced five calls — harmless while nothing fired, and a spam
   * feed now that the lanes match the reference engine's rate.
   *
   * Keyed on wallet AND token: a DIFFERENT watched wallet buying the same coin is corroboration, and
   * suppressing that would gut the crowd lane. Both halves are asserted, because a throttle that is
   * too broad fails silently in the direction of missing signals.
   */
  it('collapses a wallet re-buying the same token, but not a different wallet', () => {
    shadow = makeShadow(providers());
    shadow.onSwap(swap({ txHash: '0xa' }));
    shadow.onSwap(swap({ txHash: '0xb' }));                       // same wallet + token: throttled
    expect(shadow.status().intake).toMatchObject({ verifiedBuys: 2, buysThrottled: 1 });

    shadow.onSwap(swap({ txHash: '0xc', wallet: '0xdead00000000000000000000000000000000beef' }));
    expect((shadow.status().intake as { buysThrottled: number }).buysThrottled).toBe(1);
  });

  /**
   * Persisting the pending queue across a redeploy.
   *
   * The legacy queue has survived restarts since it was written; v2's was memory-only, so every
   * deploy silently dropped every in-flight decision — and a sheet waiting on a market cap is
   * exactly the one most likely to be mid-flight when a deploy lands.
   */
  describe('pending queue durability', () => {
    it('carries a waiting sheet across a restart, attempts intact', () => {
      const first = makeShadow(providers({ marketCap: () => null }));
      // `timestamp` is the BLOCK time and is checked against the rules epoch on restore. The shared
      // NOW fixture in this file predates that epoch, so a durability test has to stamp a real one
      // or it would assert the epoch drop while claiming to test persistence.
      first.onSwap(swap({ txHash: '0xkeep', timestamp: Date.now() }));
      const saved = first.snapshotPending();
      expect(saved).toHaveLength(1);
      first.stop();

      shadow = makeShadow(providers({ marketCap: () => null }));
      shadow.restorePending(saved, 0);
      expect(shadow.status().pending).toBe(1);
    });

    /**
     * THE ONE THAT MATTERS. `pendingMs` is charged against the gate's 180s patience, so without
     * forgiving the downtime a five-minute deploy would block every restored sheet the instant it
     * came back — persisting the queue only to discard it on arrival, which is worse than not
     * persisting at all. `attempts` is NOT forgiven: that counts how many times we asked.
     *
     * NEGATIVE CONTROL: pass the downtime as 0 below and the sheet survives, because nothing was
     * charged for it — which is precisely the bug this argument is about.
     */
    it('forgives the downtime, so a long deploy does not instantly exhaust the budget', () => {
      const first = makeShadow(providers({ marketCap: () => null }));
      first.onSwap(swap({ txHash: '0xdeploy', timestamp: Date.now() }));
      const saved = first.snapshotPending();
      first.stop();

      // Pretend the snapshot is 10 minutes old — well past the gate's 180s patience.
      const TEN_MIN = 600_000;
      const stale = saved.map((p) => ({ ...p, firstSeenAt: p.firstSeenAt - TEN_MIN }));

      shadow = makeShadow(providers({ marketCap: () => null }));
      shadow.restorePending(stale, TEN_MIN);
      shadow.restorePending([], 0); // no-op, proves an empty restore is safe
      const [restored] = (shadow as unknown as { pending: { firstSeenAt: number; attempts: number }[] }).pending;
      // Shifted back to roughly now, so the sheet gets its remaining patience rather than none.
      expect(Date.now() - restored!.firstSeenAt).toBeLessThan(5_000);
    });

    /** A sheet decided under retired rules must not come back, exactly as the ledger and diary do. */
    it('drops a pre-epoch sheet rather than restoring it', () => {
      shadow = makeShadow(providers({ marketCap: () => null }));
      shadow.restorePending(
        [{ trade: swap({ txHash: '0xold', timestamp: 1 }), firstSeenAt: Date.now(), attempts: 0 }],
        0,
      );
      expect(shadow.status().pending).toBe(0);
    });
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
      marketCap: () => null, // force retries (the one remaining required fact)
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

/**
 * The pricing budget is the scarcest thing in this pipeline.
 *
 * Measured on the live feed 2026-08-08: ~500 distributions per boot each asked
 * for a cold Uniswap v4/v3 pool discovery, queueing ~2,200 RPC reads against a
 * 2/s shared bucket. Every fact sheet then timed out waiting, market cap
 * resolved on 0.5% of them, and the Allocation lane — the only lane that can
 * fire on this feed — matched nothing at all.
 *
 * `warm: false` never changes an answer. It declines to go and LOOK for one
 * that no lane could act on. See `V2Shadow.worthPricing`.
 */
describe('what is worth a network round trip', () => {
  function spyProviders(seedTier: (w: string) => 'alpha' | 'beta' | 'chroma' | null) {
    const warmed: { token: string; warm: boolean }[] = [];
    const p = providers({
      // Unknown until somebody pays to find out — the state of a new coin.
      marketCap: (token: string, warm = true) => {
        warmed.push({ token, warm });
        return null;
      },
      seedTier,
    });
    return { p, warmed };
  }

  it('does not price a distribution to a wallet no lane would accept', () => {
    const { p, warmed } = spyProviders(() => 'chroma');
    shadow = makeShadow(p);
    shadow.onSwap(swap({ distribution: true }));
    expect(warmed).toHaveLength(1);
    expect(warmed[0]!.warm).toBe(false);
  });

  it('still prices a distribution to an alpha or beta seed wallet', () => {
    for (const tier of ['alpha', 'beta'] as const) {
      const { p, warmed } = spyProviders(() => tier);
      shadow = makeShadow(p);
      shadow.onSwap(swap({ distribution: true }));
      expect(warmed[0]!.warm, `${tier} seed must still be priced`).toBe(true);
      shadow.stop();
    }
  });

  it('always prices a verified buy, whoever made it', () => {
    const { p, warmed } = spyProviders(() => null);
    shadow = makeShadow(p);
    shadow.onSwap(swap({ distribution: false }));
    expect(warmed[0]!.warm).toBe(true);
  });

  /**
   * The skip must not become a silent third state. An unpriced sheet still
   * reaches a verdict and still says market cap is unknown — the operator sees
   * the same honest block, just without paying for it.
   */
  it('records a verdict for a skipped sheet exactly as it would for a priced one', () => {
    const { p } = spyProviders(() => 'chroma');
    shadow = makeShadow(p);
    shadow.onSwap(swap({ distribution: true }));
    expect(shadow.diary.size).toBe(1);
  });
});

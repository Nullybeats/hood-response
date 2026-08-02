import { describe, it, expect } from 'vitest';
import { PerformanceTracker } from '../engine/performance.js';
import type { Swarm } from '../types.js';

// Minimal PriceOracle stub: returns whatever price we set for a token.
function stubPrice(prices: Record<string, number>) {
  return {
    async refreshNow() {},
    priceOf: (addr: string) => prices[addr] ?? 0,
    isLive: (addr: string) => (prices[addr] ?? 0) > 0,
  } as unknown as import('../chain/price.js').PriceOracle;
}

function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    id: 'a-' + Math.random().toString(36).slice(2),
    kind: 'BUY',
    token: '0xtok',
    tokenSymbol: 'GEM',
    walletCount: 3,
    wallets: [],
    walletSummary: '2 alpha · 1 beta',
    walletLabels: [],
    walletIds: [],
    totalUsd: 3000,
    marketCap: 60_000,
    newToken: false,
    dexUrl: 'x',
    priceLive: true,
    priceUsd: 1,
    conviction: 70,
    convictionBreakdown: {
      walletQuality: 0,
      walletCount: 0,
      totalCapital: 0,
      velocity: 0,
      liquidity: 0,
      marketCap: 0,
      historicalAccuracy: 0,
      buySellRatio: 0,
    },
    windowSeconds: 10,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...over,
  };
}

describe('PerformanceTracker', () => {
  it('only tracks alerts with a live entry price', () => {
    const perf = new PerformanceTracker(stubPrice({}));
    perf.track(swarm({ priceLive: false, priceUsd: 1 }));
    perf.track(swarm({ priceLive: true, priceUsd: 0 }));
    perf.track(swarm({ priceLive: true, priceUsd: null }));
    expect(perf.list()).toHaveLength(0);
  });

  it('records peak and current return as the price moves', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    perf.track(swarm({ token: '0xtok', priceUsd: 1 }));

    // @ts-expect-error exercise the private sampler directly.
    prices['0xtok'] = 2; await perf.sample(); // +100%
    // @ts-expect-error
    prices['0xtok'] = 1.5; await perf.sample(); // pulled back to +50%, peak stays

    const call = perf.list()[0]!;
    expect(call.maxGainPct).toBe(100);
    expect(call.lastGainPct).toBe(50);
  });

  it('emits a milestone event the first time peak crosses each 50% interval', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    perf.track(swarm({ token: '0xtok', priceUsd: 1 }));
    const seen: number[] = [];
    perf.on('milestone', ({ milestonePct }: { milestonePct: number }) => seen.push(milestonePct));

    // @ts-expect-error exercise the private sampler directly.
    prices['0xtok'] = 1.4; await perf.sample(); // +40% — no milestone yet
    expect(seen).toEqual([]);

    // @ts-expect-error
    prices['0xtok'] = 1.6; await perf.sample(); // +60% — crosses 50
    expect(seen).toEqual([50]);

    // @ts-expect-error
    prices['0xtok'] = 1.6; await perf.sample(); // flat — no new peak, no re-fire
    expect(seen).toEqual([50]);
  });

  it('never fires on the way down — only a NEW peak can announce a milestone', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    perf.track(swarm({ token: '0xtok', priceUsd: 1 }));
    const seen: number[] = [];
    perf.on('milestone', ({ milestonePct }: { milestonePct: number }) => seen.push(milestonePct));

    // @ts-expect-error exercise the private sampler directly.
    prices['0xtok'] = 1.6; await perf.sample(); // +60% — crosses 50, fires once
    expect(seen).toEqual([50]);

    // Price crashes back toward entry, then partially recovers — but never
    // exceeds the prior peak (1.6), so no milestone (up OR down) should fire.
    // @ts-expect-error
    prices['0xtok'] = 0.5; await perf.sample(); // -50% — a real drop
    // @ts-expect-error
    prices['0xtok'] = 1.2; await perf.sample(); // recovering, still below peak
    // @ts-expect-error
    prices['0xtok'] = 1.59; await perf.sample(); // right up to the old peak, not past it
    expect(seen).toEqual([50]);

    // Only once it breaks the OLD peak and reaches new ground does it fire again.
    // @ts-expect-error
    prices['0xtok'] = 2.1; await perf.sample(); // +110% — new peak, crosses 100
    expect(seen).toEqual([50, 100]);
  });

  it('announces every interval a big jump passes through, not just the top one', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    perf.track(swarm({ token: '0xtok', priceUsd: 1 }));
    const seen: number[] = [];
    perf.on('milestone', ({ milestonePct }: { milestonePct: number }) => seen.push(milestonePct));

    // @ts-expect-error exercise the private sampler directly.
    prices['0xtok'] = 3.3; await perf.sample(); // +230% in one jump
    expect(seen).toEqual([50, 100, 150, 200]);
  });

  it('milestone payload carries a snapshot of the call, including its wallet labels', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    perf.track(swarm({ token: '0xtok', priceUsd: 1, tokenSymbol: 'GEM', walletLabels: ['tendies'] }));
    let payload: { call: { tokenSymbol: string; walletLabels: string[] }; milestonePct: number } | null = null;
    perf.on('milestone', (p: typeof payload) => { payload = p; });

    // @ts-expect-error exercise the private sampler directly.
    prices['0xtok'] = 1.6; await perf.sample(); // +60% — a single crossing of 50
    expect(payload).not.toBeNull();
    expect(payload!.call.tokenSymbol).toBe('GEM');
    expect(payload!.call.walletLabels).toEqual(['tendies']);
    expect(payload!.milestonePct).toBe(50);
  });

  it('summary buckets by wallet count and repeat, with a win rate', async () => {
    const prices: Record<string, number> = { '0xwin': 1, '0xflat': 1 };
    const perf = new PerformanceTracker(stubPrice(prices));
    // A multi-wallet repeat that runs, and a solo single that goes nowhere.
    perf.track(swarm({ id: 'w', token: '0xwin', walletCount: 3, repeatCount: 3 }));
    perf.track(swarm({ id: 'f', token: '0xflat', walletCount: 1, repeatCount: 1 }));

    // @ts-expect-error private sampler
    prices['0xwin'] = 3; await perf.sample(); // +200% → a win (>= 50)

    const s = perf.summary();
    expect(s.total).toBe(2);
    const multi = s.byWalletCount.find((b) => b.label.startsWith('multi'))!;
    const solo = s.byWalletCount.find((b) => b.label.startsWith('solo'))!;
    expect(multi.count).toBe(1);
    expect(multi.winRatePct).toBe(100);
    expect(solo.winRatePct).toBe(0);
    const repeat = s.byRepeat.find((b) => b.label.startsWith('repeat'))!;
    expect(repeat.bestMaxGainPct).toBe(200);
  });

  it('summary buckets by conviction and entry market cap', () => {
    const perf = new PerformanceTracker(stubPrice({ '0xa': 1, '0xb': 1 }));
    perf.track(swarm({ id: 'hi', token: '0xa', conviction: 85, marketCap: 40_000 }));
    perf.track(swarm({ id: 'lo', token: '0xb', conviction: 55, marketCap: 3_000_000 }));

    const s = perf.summary();
    const band80 = s.byConviction.find((b) => b.label === '80-89')!;
    const bandLt60 = s.byConviction.find((b) => b.label === '<60')!;
    expect(band80.count).toBe(1);
    expect(bandLt60.count).toBe(1);
    const mcLt50k = s.byMarketCap.find((b) => b.label === '<50K')!;
    const mc2mPlus = s.byMarketCap.find((b) => b.label === '2M+')!;
    expect(mcLt50k.count).toBe(1);
    expect(mc2mPlus.count).toBe(1);
  });

  it('summary buckets by wallet (not mutually exclusive) and token age', () => {
    const perf = new PerformanceTracker(stubPrice({ '0xa': 1, '0xb': 1 }));
    perf.track(
      swarm({
        id: 'a',
        token: '0xa',
        walletLabels: ['tendies', 'hmm'],
        walletIds: ['id-tendies', 'id-hmm'],
        pairAgeHours: 0.5,
      }),
    );
    perf.track(
      swarm({
        id: 'b',
        token: '0xb',
        walletLabels: ['tendies'],
        walletIds: ['id-tendies'],
        pairAgeHours: 30,
      }),
    );

    const s = perf.summary();
    const tendies = s.byWallet.find((b) => b.walletId === 'id-tendies')!;
    const hmm = s.byWallet.find((b) => b.walletId === 'id-hmm')!;
    expect(tendies.count).toBe(2);
    expect(hmm.count).toBe(1);
    expect(tendies.label).toBe('tendies'); // label still carried for display
    const under1h = s.byTokenAge.find((b) => b.label === '<1h')!;
    const oneToSevenDays = s.byTokenAge.find((b) => b.label === '1-7d')!;
    expect(under1h.count).toBe(1);
    expect(oneToSevenDays.count).toBe(1);
  });

  it('buckets a call with no known pair age as "unknown"', () => {
    const perf = new PerformanceTracker(stubPrice({ '0xa': 1 }));
    perf.track(swarm({ id: 'a', token: '0xa', pairAgeHours: null }));
    const unknown = perf.summary().byTokenAge.find((b) => b.label === 'unknown')!;
    expect(unknown.count).toBe(1);
  });

  it('reset() clears every tracked call, open or closed', () => {
    const perf = new PerformanceTracker(stubPrice({ '0xtok': 1 }));
    perf.track(swarm({ token: '0xtok' }));
    expect(perf.list()).toHaveLength(1);
    perf.reset();
    expect(perf.list()).toHaveLength(0);
    expect(perf.summary().total).toBe(0);
  });

  it('resetInfo reflects the configured auto-reset schedule', () => {
    const perf = new PerformanceTracker(stubPrice({}));
    const info = perf.resetInfo();
    expect(info).toEqual({ enabled: true, hour: 8, tz: 'America/New_York' });
  });

  // byWallet is the "which wallet actually calls winners" record. It used to key on the label,
  // which both merged distinct wallets and split a single wallet's history — these pin the fix.
  describe('byWallet groups on the stable id, not the label', () => {
    it('keeps two wallets that share a label apart', () => {
      const perf = new PerformanceTracker(stubPrice({}));
      perf.track(swarm({ walletLabels: ['alpha · 3 coins'], walletIds: ['aaaa'], priceUsd: 1 }));
      perf.track(swarm({ walletLabels: ['alpha · 3 coins'], walletIds: ['bbbb'], priceUsd: 1 }));

      const byWallet = perf.summary().byWallet;
      expect(byWallet).toHaveLength(2);
      expect(new Set(byWallet.map((b) => b.walletId))).toEqual(new Set(['aaaa', 'bbbb']));
      // Both are labelled identically — the label alone could never have told them apart.
      expect(byWallet.every((b) => b.label === 'alpha · 3 coins')).toBe(true);
      expect(byWallet.every((b) => b.count === 1)).toBe(true);
    });

    it('keeps one wallet whole when its label changes', () => {
      const perf = new PerformanceTracker(stubPrice({}));
      perf.track(swarm({ walletLabels: ['alpha · 3 coins'], walletIds: ['aaaa'], priceUsd: 1 }));
      perf.track(swarm({ walletLabels: ['alpha · 4 coins'], walletIds: ['aaaa'], priceUsd: 1 }));

      const byWallet = perf.summary().byWallet;
      expect(byWallet).toHaveLength(1);
      expect(byWallet[0]!.walletId).toBe('aaaa');
      expect(byWallet[0]!.count).toBe(2);
      // Display follows the newest label so the wallet reads as it looks today.
      expect(byWallet[0]!.label).toBe('alpha · 4 coins');
    });

    it('counts a multi-wallet call once for each participating wallet', () => {
      const perf = new PerformanceTracker(stubPrice({}));
      perf.track(
        swarm({ walletLabels: ['alpha · 1', 'beta · 2'], walletIds: ['aaaa', 'bbbb'], priceUsd: 1 }),
      );

      const byWallet = perf.summary().byWallet;
      expect(byWallet).toHaveLength(2);
      expect(byWallet.every((b) => b.count === 1)).toBe(true);
    });

    it('skips calls tracked before walletIds existed without dropping them elsewhere', () => {
      const perf = new PerformanceTracker(stubPrice({}));
      perf.track(swarm({ walletLabels: ['alpha · 3 coins'], walletIds: [], priceUsd: 1 }));

      expect(perf.summary().byWallet).toHaveLength(0);
      expect(perf.summary().total).toBe(1); // still counted in every other bucket
    });
  });
});

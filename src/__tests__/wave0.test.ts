import { describe, it, expect } from 'vitest';
import { SniperEngine } from '../sniper/engine.js';
import type { SniperStateStore, StoredSniperState } from '../sniper/state.js';
import type { Swarm } from '../types.js';

function stubPrice(prices: Record<string, number>, ethUsd: number | null = null) {
  return {
    async refreshNow() {},
    priceOf: (a: string) => prices[a] ?? 0,
    isLive: (a: string) => (prices[a] ?? 0) > 0,
    pairIdOf: () => null,
    ethUsdPrice: () => ethUsd,
    liquidityOf: () => null,
  } as unknown as import('../chain/price.js').PriceOracle;
}

function stubSafety() {
  return {
    async check() {
      return { ok: true, honeypot: false, hardFails: [], buyTaxPct: 0, sellTaxPct: 0 } as unknown as Awaited<
        ReturnType<import('../chain/safety.js').SafetyChecker['check']>
      >;
    },
  } as unknown as import('../chain/safety.js').SafetyChecker;
}

function stubExecutor(log: string[]) {
  return {
    ready: true,
    address: () => '0xwallet',
    async balanceEth() { return 1; },
    async buy(token: string, eth: number) {
      log.push('buy:' + token + ':' + eth);
      return { txHash: '0xbuy', tokensReceived: 1000, ethSpent: eth, gasEth: 0.00001, quotedTokens: 1000, venue: 'v4' as const };
    },
    async sell(token: string) {
      log.push('sell:' + token);
      return { txHash: '0xsell', ethReceived: 0.002, quotedEthOut: 0.002, tokensSold: 1000, gasEth: 0.00001, venue: 'v4' as const };
    },
    async previewRoundTrip(_t: string, eth: number) {
      return { venue: 'v4' as const, ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.98, lossPct: 2, poolLiquidity: 1e18 };
    },
    async valueInEth() { return { tokens: 1000, ethOut: 0.001 }; },
    async protocolFeeInfo() { return { hook: '0x0', feePctPerSwap: null }; },
  } as unknown as import('../sniper/executor.js').SwapExecutor;
}

/** In-memory SniperStateStore stub that serves one owner's durable record. */
function stubState(durable: Partial<StoredSniperState> | null): SniperStateStore {
  let saved: StoredSniperState | null = durable
    ? ({ version: 1, positions: [], settings: {}, buys: [], recentLosses: [], decisions: [], removedLog: [], ...durable } as StoredSniperState)
    : null;
  return {
    enabled: true,
    keyEnabled: false,
    load: () => saved,
    save: (_o: string, s: StoredSniperState) => { saved = s; },
    audit: () => {},
    claimFirstSignal: () => true,
    hasKey: () => false,
  } as unknown as SniperStateStore;
}

function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    id: 's-' + Math.random().toString(36).slice(2),
    kind: 'ENTRY', token: '0xtok', tokenSymbol: 'GEM', walletCount: 3, wallets: [],
    walletSummary: '3 alpha', walletLabels: [], totalUsd: 3000, marketCap: 60_000,
    newToken: false, dexUrl: 'x', priceLive: true, priceUsd: 1, conviction: 75,
    convictionBreakdown: { walletQuality: 0, walletCount: 0, totalCapital: 0, velocity: 0, liquidity: 0, marketCap: 0, historicalAccuracy: 0, buySellRatio: 0 },
    windowSeconds: 10, firstSeen: Date.now(), lastSeen: Date.now(), ...over,
  } as Swarm;
}

describe('Wave 0 — settings migration', () => {
  it('migrates a pre-v2 operator to ENTRY,SOLO · conviction ungated · roundtrip 5, once', async () => {
    // A legacy operator whose durable settings carry the OLD losing config.
    const state = stubState({
      mode: 'live',
      settingsSchemaVersion: 1,
      settings: { kinds: 'BUY,ENTRY', primeOnly: true, minConviction: 60, maxConviction: 90, maxRoundtripPct: 35, buyEth: 0.005 } as unknown,
    });
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor([]), stubSafety(), { owner: 'op@x.com', state });
    await eng.load();
    const s = (await eng.snapshot()).settings;
    expect(s.kinds).toBe('ENTRY,SOLO');
    expect(s.primeOnly).toBe(false);
    expect(s.minConviction).toBe(0);
    expect(s.maxConviction).toBe(100);
    expect(s.maxRoundtripPct).toBe(5);
    // Operator-set fields the migration doesn't touch are preserved.
    expect(s.buyEth).toBe(0.005);
  });

  it('does NOT re-migrate an already-v2 operator (their kinds are preserved)', async () => {
    const state = stubState({
      mode: 'live',
      settingsSchemaVersion: 2,
      settings: { kinds: 'BUY', primeOnly: true, maxRoundtripPct: 20 } as unknown,
    });
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor([]), stubSafety(), { owner: 'op@x.com', state });
    await eng.load();
    const s = (await eng.snapshot()).settings;
    expect(s.kinds).toBe('BUY'); // untouched — they chose it post-migration
    expect(s.maxRoundtripPct).toBe(20);
  });
});

describe('Wave 0 — defaults & sticky state', () => {
  it('a BUY-kind alert is skipped by default (BUY not in ENTRY,SOLO)', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, primeOnly: false });
    await eng.onAlert(swarm({ kind: 'BUY' }));
    expect(log).toHaveLength(0);
    const d = (await eng.snapshot()).decisions;
    expect(d[0]!.reason).toContain('kind BUY not in buy list');
  });

  it('ENTRY and SOLO alerts both buy by default', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xa': 1, '0xb': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, primeOnly: false });
    await eng.onAlert(swarm({ token: '0xa', kind: 'ENTRY' }));
    await eng.onAlert(swarm({ token: '0xb', kind: 'SOLO' }));
    expect(log).toEqual(['buy:0xa:0.0005', 'buy:0xb:0.0005']);
  });

  it('mode survives a simulated restart (durable live → engine boots live)', async () => {
    const state = stubState({ mode: 'live', settingsSchemaVersion: 2, settings: {} as unknown });
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor([]), stubSafety(), { owner: 'op@x.com', state });
    await eng.load();
    expect(eng.executionMode).toBe('live');
  });
});

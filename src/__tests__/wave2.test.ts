import { describe, it, expect } from 'vitest';
import { SniperEngine } from '../sniper/engine.js';
import type { Swarm } from '../types.js';

function stubPrice() {
  return {
    async refreshNow() {}, priceOf: () => 1, isLive: () => true, pairIdOf: () => null,
    ethUsdPrice: () => 1, liquidityOf: () => null,
  } as unknown as import('../chain/price.js').PriceOracle;
}
function stubSafety() {
  return { async check() { return { ok: true, honeypot: false, hardFails: [], buyTaxPct: 0, sellTaxPct: 0 } as unknown as Awaited<ReturnType<import('../chain/safety.js').SafetyChecker['check']>>; } } as unknown as import('../chain/safety.js').SafetyChecker;
}
function stubExecutor(log: string[]) {
  return {
    ready: true, address: () => '0xw', async balanceEth() { return 1; },
    async buy(t: string, eth: number) { log.push('buy:' + t); return { txHash: '0xb', tokensReceived: 1000, tokensReceivedRaw: '1000', ethSpent: eth, gasEth: 1e-5, quotedTokens: 1000, venue: 'v4' as const }; },
    async sell() { return { txHash: '0xs', ethReceived: 0.001, quotedEthOut: 0.001, tokensSold: 1000, gasEth: 1e-5, venue: 'v4' as const }; },
    async previewRoundTrip(_t: string, eth: number) { return { venue: 'v4' as const, ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.98, lossPct: 2, poolLiquidity: 1e18 }; },
    async valueInEth() { return { tokens: 1000, ethOut: 0.001 }; },
    async tokenMeta() { return { symbol: 'REAL', totalSupply: 1e6 }; },
    async protocolFeeInfo() { return { hook: '0x0', feePctPerSwap: null }; },
    async prepareExit() {},
  } as unknown as import('../sniper/executor.js').SwapExecutor;
}
function swarm(over: Partial<Swarm> = {}): Swarm {
  return { id: 's1', kind: 'ENTRY', token: '0xtok', tokenSymbol: 'GEM', walletCount: 3, wallets: [], walletSummary: '3', walletLabels: [], totalUsd: 3000, marketCap: 60000, newToken: false, dexUrl: 'x', priceLive: true, priceUsd: 1, conviction: 75, convictionBreakdown: { walletQuality: 0, walletCount: 0, totalCapital: 0, velocity: 0, liquidity: 0, marketCap: 0, historicalAccuracy: 0, buySellRatio: 0 }, windowSeconds: 10, firstSeen: Date.now(), lastSeen: Date.now(), ...over } as Swarm;
}

describe('Wave 2 — freshness gate + timing', () => {
  it('skips an alert older than the staleness cutoff', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice(), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, primeOnly: false, maxRoundtripPct: 0 });
    await eng.onAlert(swarm({ firstSeen: Date.now() - 60_000 })); // 60s old ≫ 15s default
    expect(log).toHaveLength(0);
    expect((await eng.snapshot()).decisions[0]!.reason).toContain('stale');
  });

  it('a fresh alert buys and records a per-stage latency breakdown', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice(), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, primeOnly: false, maxRoundtripPct: 0 });
    await eng.onAlert(swarm({ firstSeen: Date.now(), receivedAt: Date.now(), enrichMs: 42 }));
    expect(log).toEqual(['buy:0xtok']);
    const pos = (await eng.snapshot()).positions[0]!;
    expect(pos.gateTimingsMs).toBeDefined();
    expect(pos.gateTimingsMs!.enrich).toBe(42);
    expect(typeof pos.gateTimingsMs!.submit).toBe('number');
  });
});

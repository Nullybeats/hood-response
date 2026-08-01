import { describe, it, expect } from 'vitest';
import { SniperEngine, normalizeLadder } from '../sniper/engine.js';
import type { Swarm } from '../types.js';

const ONE = 1_000_000_000_000_000_000n; // 1e18 base units
const LOT = 1000n * ONE; // entry lot: 1000 tokens

function stubPrice(px: () => number) {
  return {
    async refreshNow() {},
    priceOf: () => px(),
    isLive: () => true,
    pairIdOf: () => null,
    ethUsdPrice: () => 1, // ethUsd=1 so px = valueInEth.ethOut / tokens
    liquidityOf: () => null,
  } as unknown as import('../chain/price.js').PriceOracle;
}
function stubSafety() {
  return { async check() { return { ok: true, honeypot: false, hardFails: [], buyTaxPct: 0, sellTaxPct: 0 } as unknown as Awaited<ReturnType<import('../chain/safety.js').SafetyChecker['check']>>; } } as unknown as import('../chain/safety.js').SafetyChecker;
}

/** Executor stub: buy returns a real raw lot; sell records the raw amount sold; valueInEth reflects a
 *  mutable live multiple so sample() sees the price ramp. */
function stubExecutor(mult: () => number, sells: { raw: bigint; tokens: number }[]) {
  return {
    ready: true,
    address: () => '0xwallet',
    async balanceEth() { return 1; },
    async buy(_t: string, eth: number) {
      return { txHash: '0xbuy', tokensReceived: 1000, tokensReceivedRaw: LOT.toString(), ethSpent: eth, gasEth: 0.00001, quotedTokens: 1000, venue: 'v4' as const };
    },
    async sell(_t: string, _p: unknown, _e: unknown, tokens: number, raw: string) {
      sells.push({ raw: BigInt(raw), tokens });
      return { txHash: '0xsell', ethReceived: 0.001, quotedEthOut: 0.001, tokensSold: tokens, gasEth: 0.00001, venue: 'v4' as const };
    },
    async previewRoundTrip(_t: string, eth: number) { return { venue: 'v4' as const, ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.98, lossPct: 2, poolLiquidity: 1e18 }; },
    // px = ethOut*ethUsd/tokens = ethOut/1 (tokens=1) = mult (entry px = 1)
    async valueInEth() { return { tokens: 1, ethOut: mult() }; },
    async tokenMeta() { return { symbol: 'REAL', totalSupply: 1e6 }; },
    async protocolFeeInfo() { return { hook: '0x0', feePctPerSwap: null }; },
    async prepareExit() {},
  } as unknown as import('../sniper/executor.js').SwapExecutor;
}
function swarm(over: Partial<Swarm> = {}): Swarm {
  return { id: 's1', kind: 'ENTRY', token: '0xtok', tokenSymbol: 'GEM', walletCount: 3, wallets: [], walletSummary: '3', walletLabels: [], totalUsd: 3000, marketCap: 60000, newToken: false, dexUrl: 'x', priceLive: true, priceUsd: 1, conviction: 75, convictionBreakdown: { walletQuality: 0, walletCount: 0, totalCapital: 0, velocity: 0, liquidity: 0, marketCap: 0, historicalAccuracy: 0, buySellRatio: 0 }, windowSeconds: 10, firstSeen: Date.now(), lastSeen: Date.now(), ...over } as Swarm;
}

/** Isolate the ladder: no rug/trail/recoup/legacy-TP, depth gate off. */
function ladderSettings(tpLadder: { mult: number; sellFraction: number }[]) {
  return { enabled: true, primeOnly: false, maxRoundtripPct: 0, rugGuard: false, trailingStopPct: 0, recoupAtPct: 0, takeProfitPct: 0, tpLadder } as const;
}

describe('Wave 1 — TP ladder', () => {
  it('fires each rung once, selling the right fraction of the ORIGINAL lot', async () => {
    let px = 1; const sells: { raw: bigint; tokens: number }[] = [];
    const eng = new SniperEngine(stubPrice(() => px), stubExecutor(() => px, sells), stubSafety());
    eng.updateSettings(ladderSettings([{ mult: 1.35, sellFraction: 0.5 }, { mult: 3, sellFraction: 0.25 }]));
    await eng.onAlert(swarm());
    // @ts-expect-error private sampler
    px = 1.4; await eng.sample();   // crosses rung 1.35 → sell 50% of original
    expect(sells).toHaveLength(1);
    expect(sells[0]!.raw).toBe(LOT / 2n);                // 500e18 = 50% of ORIGINAL
    // @ts-expect-error
    px = 1.4; await eng.sample();   // same price → rung already hit, no re-fire
    expect(sells).toHaveLength(1);
    // @ts-expect-error
    px = 3.5; await eng.sample();   // crosses rung 3 → sell 25% of ORIGINAL
    expect(sells).toHaveLength(2);
    expect(sells[1]!.raw).toBe(LOT / 4n);                // 250e18 = 25% of ORIGINAL (not of remaining)
    const pos = (await eng.snapshot()).positions[0]!;
    expect(pos.status).toBe('open');                      // remainder still riding
    expect(pos.tpRungsHit).toEqual([1.35, 3]);
    expect(Math.round(pos.remainingPct)).toBe(25);        // 100 − 50 − 25
  });

  it('a rung that would consume ~all the remainder does a full close', async () => {
    let px = 1; const sells: { raw: bigint; tokens: number }[] = [];
    const eng = new SniperEngine(stubPrice(() => px), stubExecutor(() => px, sells), stubSafety());
    eng.updateSettings(ladderSettings([{ mult: 1.5, sellFraction: 1 }]));
    await eng.onAlert(swarm());
    // @ts-expect-error
    px = 1.6; await eng.sample();
    const pos = (await eng.snapshot()).positions[0]!;
    expect(pos.status).toBe('closed');
    expect(pos.closeReason).toBe('take-profit');
  });

  it('when a ladder is set the legacy single takeProfitPct is ignored', async () => {
    let px = 1; const sells: { raw: bigint; tokens: number }[] = [];
    const eng = new SniperEngine(stubPrice(() => px), stubExecutor(() => px, sells), stubSafety());
    // takeProfitPct 20 would fire at +20%, but a ladder is set → it must be ignored; rung 1.35 governs.
    eng.updateSettings({ ...ladderSettings([{ mult: 1.35, sellFraction: 0.5 }]), takeProfitPct: 20 });
    await eng.onAlert(swarm());
    // @ts-expect-error
    px = 1.25; await eng.sample();   // +25%: past the (ignored) TP, below the rung → nothing sells
    expect(sells).toHaveLength(0);
    expect((await eng.snapshot()).positions[0]!.status).toBe('open');
  });
});

describe('Wave 1 — normalizeLadder', () => {
  it('sorts ascending, drops invalid, dedupes, caps cumulative fraction ≤ 1', () => {
    const out = normalizeLadder([
      { mult: 3, sellFraction: 0.5 },
      { mult: 1.35, sellFraction: 0.6 },
      { mult: 1.35, sellFraction: 0.9 }, // dup mult → dropped
      { mult: 0.9, sellFraction: 0.5 },  // mult ≤ 1 → dropped
      { mult: 5, sellFraction: 0.5 },
    ]);
    expect(out.map((r) => r.mult)).toEqual([1.35, 3]); // 5× dropped: whole lot allocated by 1.35+3
    expect(out[0]!.sellFraction).toBe(0.6);
    expect(out[1]!.sellFraction).toBeCloseTo(0.4, 6);  // capped: 1 − 0.6
    expect(out.length).toBe(2);
  });
});

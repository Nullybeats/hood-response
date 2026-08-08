/**
 * The buy rule for v2 signals — the code that decides whether real money moves.
 *
 * A v2 match has no `kind` and no `conviction`; it has lanes and a score. The
 * failure this suite exists to prevent is a v2 signal falling through the legacy
 * gates: `swarm.conviction < minConviction` evaluates `undefined < 0` as false,
 * so a signal with neither field would have sailed straight past a rule that
 * looks like it is filtering.
 */
import { describe, it, expect } from 'vitest';

import { SniperEngine } from '../sniper/engine.js';
import type { Swarm } from '../types.js';

function stubPrice(prices: Record<string, number>) {
  return {
    async refreshNow() {},
    priceOf: (a: string) => prices[a] ?? 0,
    isLive: (a: string) => (prices[a] ?? 0) > 0,
    pairIdOf: () => null,
    ethUsdPrice: () => null,
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
    async sell() {
      return { txHash: '0xsell', ethReceived: 0.002, quotedEthOut: 0.002, tokensSold: 1000, gasEth: 0.00001, venue: 'v4' as const };
    },
    async previewRoundTrip(_t: string, eth: number) {
      return { venue: 'v4' as const, ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.98, lossPct: 2, poolLiquidity: 1e18 };
    },
    async valueInEth() { return { tokens: 1000, ethOut: 0.001 }; },
    async protocolFeeInfo() { return { hook: '0x0', feePctPerSwap: null }; },
  } as unknown as import('../sniper/executor.js').SwapExecutor;
}

/** A v2 match as it arrives at the sniper: lanes + score, no kind, no conviction. */
function v2(over: Partial<Swarm> = {}): Swarm {
  return {
    id: '0xtx' + Math.random().toString(36).slice(2),
    source: 'v2',
    lanes: ['allocation'],
    laneReasons: ['distribution, alpha-seed wallet, pair 1h old'],
    score: 68,
    eventType: 'distribution',
    cohortSize: 1,
    emittedAt: Date.now(),
    token: '0xtok',
    tokenSymbol: 'GEM',
    walletCount: 1,
    wallets: [],
    walletSummary: '1 wallet',
    walletLabels: [],
    marketCap: 90_000,
    priceLive: true,
    priceUsd: 1,
    firstSeen: Date.now(),
    ...over,
  } as unknown as Swarm;
}

async function armed(log: string[], lanes: string[], minScore = 60) {
  const eng = new SniperEngine(stubPrice({ '0xtok': 1, '0xb': 1 }), stubExecutor(log), stubSafety());
  eng.updateSettings({ enabled: true, enabledLanes: lanes, minScore });
  return eng;
}

async function reasonOf(eng: SniperEngine): Promise<string> {
  return (await eng.snapshot()).decisions[0]!.reason;
}

describe('lanes as the buy rule', () => {
  it('buys a match from an enabled lane', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2());
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  /** The migrated default. No lane named ⇒ nothing bought, whatever arrives. */
  it('buys nothing when no lane is enabled', async () => {
    const log: string[] = [];
    const eng = await armed(log, []);
    await eng.onAlert(v2());
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('no v2 lane is enabled');
  });

  it('skips a lane the operator did not enable, and names it', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['earliest-entry']);
    await eng.onAlert(v2({ lanes: ['allocation'] }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('allocation');
  });

  /**
   * FAILS CLOSED. This is the one that would have bitten silently: the legacy
   * comparison `conviction < minConviction` treats a missing number as passing,
   * because `null < 0` is false.
   */
  it('refuses an unscored match rather than treating it as passing', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ score: null }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('unscored');
  });

  it('applies the score floor', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation'], 70);
    await eng.onAlert(v2({ score: 68 }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('below floor 70');
  });

  /**
   * A v2 match must never be judged by legacy rules — it has none of the fields
   * they read, so every one of them would silently pass.
   */
  it('ignores primeOnly, kinds and conviction for a v2 signal', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    // primeOnly would reject anything without `prime`; kinds would reject a
    // missing kind. Neither may be consulted.
    eng.updateSettings({ primeOnly: true, kinds: 'ENTRY', minConviction: 90 });
    await eng.onAlert(v2());
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  /** And the reverse: a legacy alert must not be judged by lane rules. */
  it('still applies the legacy rules to a legacy alert', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    eng.updateSettings({ primeOnly: false, kinds: 'ENTRY' });
    await eng.onAlert({
      id: 'legacy1', kind: 'BUY', token: '0xb', tokenSymbol: 'OLD', walletCount: 2, wallets: [],
      walletSummary: '2 alpha', walletLabels: [], marketCap: 50_000, priceLive: true, priceUsd: 1,
      conviction: 75, firstSeen: Date.now(),
    } as unknown as Swarm);
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('kind BUY not in buy list');
  });

  /**
   * Freshness is measured from the DECISION, not the block. v2 waits up to ~3
   * minutes for facts and settles an allocation 90s to count the wave, so aging
   * from block time would skip essentially every match — a 100% skip rate that
   * looks exactly like a quiet market.
   */
  it('ages a v2 match from when it was emitted, not from the block', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ firstSeen: Date.now() - 10 * 60_000, emittedAt: Date.now() }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  it('records the lane, not a fabricated kind, on the decision', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2());
    const d = (await eng.snapshot()).decisions[0]!;
    expect(d.kind).toBe('allocation');
  });
});

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
  it('buys a v2 match on lanes alone, with no legacy setting consulted', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    // These fields still exist in the persisted blob so a rollback keeps operator config, but
    // nothing reads them any more. Setting them to values that WOULD have rejected this match is
    // the assertion: it buys regardless.
    eng.updateSettings({ primeOnly: true, kinds: 'ENTRY', minConviction: 90 });
    await eng.onAlert(v2());
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  /**
   * And the reverse: a legacy alert is REFUSED, not re-judged.
   *
   * It cannot be allowed to fall through to the lane checks — it carries no `lanes` and no
   * `score`, and `undefined < minScore` is false, so a rule that looks like it is filtering would
   * pass it. Refusing by shape is the only version of this that fails closed.
   */
  it('refuses a legacy alert instead of judging it by lane rules', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert({
      id: 'legacy1', kind: 'BUY', token: '0xb', tokenSymbol: 'OLD', walletCount: 2, wallets: [],
      walletSummary: '2 alpha', walletLabels: [], marketCap: 50_000, priceLive: true, priceUsd: 1,
      conviction: 75, prime: true, firstSeen: Date.now(),
    } as unknown as Swarm);
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('legacy signal');
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

/**
 * One position per coin.
 *
 * The ledger shows the same token signalling repeatedly inside an hour (DERP
 * fired five times in one 60-minute window). Without these guards that is five
 * positions in one coin, five entry fees, and a concentration nobody chose.
 *
 * `holdsOpen` is the rule; the in-flight lock closes the race where two signals
 * both clear it before either has recorded a position. Both are string
 * comparisons on an address, which is why the casing test below exists: every
 * producer emits lowercase TODAY, so a convention is doing the work of an
 * invariant, and the engine now consumes two independent producers.
 */
describe('never twice into the same coin', () => {
  it('refuses a second buy while the first position is open', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2());
    await eng.onAlert(v2());                    // same token, new signal
    expect(log).toEqual(['buy:0xtok:0.0005']);  // exactly one
    expect(await reasonOf(eng)).toContain('already holding');
  });

  /**
   * The failure this prevents is silent: a checksummed address is what
   * `getAddress()` and most explorers return, and `'0xTOK' !== '0xtok'` makes
   * every per-token guard miss at once. The result is a second position, not an
   * error.
   */
  it('treats the same address as the same coin whatever its casing', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ token: '0xtok' }));
    await eng.onAlert(v2({ token: '0xTOK' }));  // the other producer's spelling
    expect(log).toHaveLength(1);
    expect(await reasonOf(eng)).toContain('already holding');
  });

  /**
   * Two matches on one coin, spelled differently by whatever produced them. The engine consumes a
   * single stream now, so this is no longer a cross-producer case — but the guard is a string
   * comparison on an address, and normalising it is what makes the rule structural rather than a
   * convention that happens to hold.
   */
  it('blocks a second match on a coin already held, whatever the address casing', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ token: '0xtok' }));
    await eng.onAlert(v2({ token: '0xTok' }));
    expect(log).toHaveLength(1);
    expect(await reasonOf(eng)).toContain('already holding');
  });
});

/**
 * The wallet-grade filter.
 *
 * Grades are earned from allocation outcomes and are deliberately NOT a lane condition — the lane
 * has to keep firing while the record accrues, or the grades it would need could never be
 * measured. This is the operator's own filter on top, so acting on a grade is a choice rather
 * than something the rules do silently.
 *
 * Measured 2026-08-08, the first hour grades existed: `beta · #4 HMM` — the wallet behind 15 of 16
 * matched signals — graded F at a 5% hit rate over 20 allocations. So the control has something
 * real to act on immediately.
 */
describe('the wallet-grade filter', () => {
  async function armedWithGrades(log: string[], grades: string[]) {
    const eng = await armed(log, ['allocation']);
    eng.updateSettings({ allowedWalletGrades: grades });
    return eng;
  }

  it('allows every grade by default, so adding the control changes nothing', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ walletGrade: 'F' }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  it('skips a grade the operator excluded, and names it', async () => {
    const log: string[] = [];
    const eng = await armedWithGrades(log, ['A', 'B', 'C', 'D', 'U']);
    await eng.onAlert(v2({ walletGrade: 'F' }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('wallet grade F');
  });

  it('buys a grade that is on the list', async () => {
    const log: string[] = [];
    const eng = await armedWithGrades(log, ['A', 'B']);
    await eng.onAlert(v2({ walletGrade: 'B' }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  /**
   * `U` means "fewer than 5 measured outcomes", not "bad". Excluding it is a real position — buy
   * only proven wallets — but it must be deliberate, because every wallet reads U until it has a
   * record, and a default that excluded U would have silently bought nothing for weeks.
   */
  it('treats an ABSENT grade as U, never as passing', async () => {
    const log: string[] = [];
    const eng = await armedWithGrades(log, ['A', 'B', 'C', 'D', 'F']); // U withheld
    await eng.onAlert(v2({ walletGrade: undefined }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('wallet grade U');
  });

  it('buys nothing when every grade is excluded', async () => {
    const log: string[] = [];
    const eng = await armedWithGrades(log, []);
    await eng.onAlert(v2({ walletGrade: 'A' }));
    expect(log).toHaveLength(0);
    expect(await reasonOf(eng)).toContain('no wallet grade is enabled');
  });

  /** The lane itself must stay grade-blind, so grading can keep accruing in the background. */
  it('does not make the lane itself require a grade', async () => {
    const log: string[] = [];
    const eng = await armed(log, ['allocation']);
    await eng.onAlert(v2({ walletGrade: 'U' }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });
});

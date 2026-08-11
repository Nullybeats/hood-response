import { describe, it, expect } from 'vitest';
import { SniperEngine, MIN_BUY_ETH } from '../sniper/engine.js';
import type { SwapExecutor } from '../sniper/executor.js';
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

// No real GoPlus network call in tests — deterministic, instant.
function stubSafety(buyTaxPct: number | null = 0, sellTaxPct: number | null = 0, ok = true, hardFails: string[] = []) {
  return {
    async check() {
      return { ok, honeypot: !ok, hardFails, buyTaxPct, sellTaxPct } as unknown as Awaited<
        ReturnType<import('../chain/safety.js').SafetyChecker['check']>
      >;
    },
  } as unknown as import('../chain/safety.js').SafetyChecker;
}

function stubExecutor(
  log: string[],
  overrides: Partial<{
    valueInEth: (token: string) => Promise<{ tokens: number; ethOut: number }>;
    tokenMeta: (token: string) => Promise<{ symbol: string; totalSupply: number }>;
    readBuyTx: (
      token: string,
      txHash: string,
    ) => Promise<{ ethSpent: number; tokensReceived: number; blockTimestamp: number; gasEth: number }>;
    protocolFeeInfo: (token: string) => Promise<{ hook: string; feePctPerSwap: number | null }>;
    previewRoundTrip: (
      token: string,
      eth: number,
    ) => Promise<{ venue: 'v4' | 'v3'; ethIn: number; quotedTokens: number; ethBack: number; lossPct: number; poolLiquidity: number | null } | null>;
  }> = {},
) {
  return {
    ready: true,
    address: () => '0xwallet',
    async balanceEth() {
      return 1;
    },
    // Display-path read. Delegates to balanceEth here on purpose: these stubs assert on CALL
    // COUNTS, so a caching double would hide a trade path that had started reading stale state.
    async balanceEthForDisplay() {
      return 1;
    },
    async buy(token: string, eth: number) {
      log.push('buy:' + token + ':' + eth);
      return { txHash: '0xbuy', tokensReceived: 1000, ethSpent: eth, gasEth: 0.00001, quotedTokens: 1000, venue: 'v4' as const };
    },
    async sell(token: string) {
      log.push('sell:' + token);
      return { txHash: '0xsell', ethReceived: 0.002, quotedEthOut: 0.002, tokensSold: 1000, gasEth: 0.00001, venue: 'v4' as const };
    },
    previewRoundTrip:
      overrides.previewRoundTrip ??
      (async (_token: string, eth: number) => ({
        venue: 'v4' as const,
        ethIn: eth,
        quotedTokens: 1000,
        ethBack: eth * 0.9, // healthy pool: 10% round-trip loss, under the 35% gate
        lossPct: 10,
        poolLiquidity: 1e18,
      })),
    valueInEth: overrides.valueInEth ?? (async () => ({ tokens: 1000, ethOut: 0.001 })),
    tokenMeta: overrides.tokenMeta ?? (async () => ({ symbol: 'REAL', totalSupply: 1_000_000 })),
    readBuyTx:
      overrides.readBuyTx ??
      (async () => ({
        ethSpent: 0.0008,
        tokensReceived: 13583.78,
        blockTimestamp: 1_700_000_000_000,
        gasEth: 0.00001,
      })),
    protocolFeeInfo: overrides.protocolFeeInfo ?? (async () => ({ hook: '0x0', feePctPerSwap: null })),
  } as unknown as SwapExecutor;
}

/**
 * A v2 match, which is the ONLY shape the engine buys from since the cutover.
 *
 * These tests are mostly about what happens AFTER the buy decision — exits, gas accounting,
 * cooldowns, depth. The signal is their vehicle, so it has to be a shape that can still get
 * through the gate; a legacy alert is now refused before any of that runs.
 */
function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    id: 's-' + Math.random().toString(36).slice(2),
    source: 'v2',
    lanes: ['allocation'],
    laneReasons: ['distribution, beta-seed wallet, solo, pair 0h old, micro cap'],
    score: 75,
    eventType: 'distribution',
    cohortSize: 1,
    emittedAt: Date.now(),
    token: '0xtok',
    tokenSymbol: 'GEM',
    walletCount: 1,
    wallets: [],
    walletSummary: '1 wallet',
    walletLabels: [],
    totalUsd: 3000,
    marketCap: 60_000,
    newToken: false,
    dexUrl: 'x',
    priceLive: true,
    priceUsd: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...over,
  } as unknown as Swarm;
}

describe('SniperEngine', () => {
  it('does nothing when disabled', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    await eng.onAlert(swarm());
    expect(log).toHaveLength(0);
  });

  it('buys a qualifying alert and enforces the min buy floor', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], buyEth: 0.0001 }); // below the floor
    await eng.onAlert(swarm());
    expect(log).toEqual(['buy:0xtok:' + MIN_BUY_ETH]); // floored up to 0.0005
    const snap = await eng.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.status).toBe('open');
  });

  it('depth gate: skips a pool whose round-trip loss exceeds the cap, captures telemetry when it buys', async () => {
    // Thin pool: buying 0.0005Ξ round-trips to 0.00025Ξ (−50% loss) → over the 35% cap.
    const thin: string[] = [];
    const thinEng = new SniperEngine(
      stubPrice({ '0xtok': 1 }),
      stubExecutor(thin, {
        previewRoundTrip: async (_t, eth) => ({ venue: 'v4', ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.5, lossPct: 50, poolLiquidity: 1 }),
      }),
      stubSafety(),
    );
    thinEng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await thinEng.onAlert(swarm());
    expect(thin).toHaveLength(0); // never reached executor.buy
    const td = (await thinEng.snapshot()).decisions;
    expect(td[0]!.reason).toContain('too thin');

    // Healthy pool (default stub = 10% round-trip): buys AND records telemetry.
    const ok: string[] = [];
    const okEng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(ok), stubSafety());
    okEng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await okEng.onAlert(swarm());
    expect(ok).toEqual(['buy:0xtok:0.0005']);
    const pos = (await okEng.snapshot()).positions[0]!;
    expect(pos.entryRoundTripPct).toBe(10);
    expect(pos.venue).toBe('v4');
    expect(pos.entrySlippagePct).toBe(0); // stub: received 1000 == quoted 1000
    expect(typeof pos.buyLatencyMs).toBe('number');
  });

  it('recent-loss cooldown: skips re-buying a token that just stopped us out at a loss', async () => {
    const log: string[] = [];
    const prices: Record<string, number> = { '0xtok': 1 };
    // stub sell returns ethReceived 0.002; make the buy cost 0.005 so the close books a LOSS.
    const eng = new SniperEngine(stubPrice(prices), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], buyEth: 0.005, lossCooldownMin: 90, trailingStopPct: 15 });
    await eng.onAlert(swarm({ token: '0xtok' }));
    expect(log).toContain('buy:0xtok:0.005'); // bought (0.005 in, stub sells for 0.002 → loss)
    prices['0xtok'] = 0.5; // −50% → trips the trailing stop, books a loss
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    expect(log).toContain('sell:0xtok');
    // A fresh alert for the same token is now blocked by the cooldown.
    log.length = 0;
    await eng.onAlert(swarm({ token: '0xtok' }));
    expect(log).toHaveLength(0); // no re-buy
    const d = (await eng.snapshot()).decisions;
    expect(d[0]!.reason).toContain('loss cooldown');
  });

  it('depth gate off (maxRoundtripPct=0) buys even a thin pool', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(
      stubPrice({ '0xtok': 1 }),
      stubExecutor(log, {
        previewRoundTrip: async (_t, eth) => ({ venue: 'v4', ethIn: eth, quotedTokens: 1000, ethBack: eth * 0.4, lossPct: 60, poolLiquidity: 1 }),
      }),
      stubSafety(),
    );
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], maxRoundtripPct: 0 });
    await eng.onAlert(swarm());
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  it('skips a below-floor score, an unenabled lane, or a coin already held', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1, '0xb': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], minScore: 60 });
    await eng.onAlert(swarm({ token: '0xa', score: 50 })); // below the floor
    await eng.onAlert(swarm({ token: '0xb', lanes: ['proven-wallets'] })); // lane not enabled
    expect(log).toHaveLength(0);
    // First buy of 0xtok works; a second match for the same token is skipped.
    await eng.onAlert(swarm({ token: '0xtok' }));
    await eng.onAlert(swarm({ token: '0xtok' }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  /**
   * The legacy stream is retired, and it must be retired LOUDLY. A silent drop would be
   * indistinguishable from a quiet market — the failure mode this whole engine keeps re-learning.
   */
  it('refuses a legacy alert outright, and says so', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xa': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert({
      id: 'legacy-1', kind: 'ENTRY', token: '0xa', tokenSymbol: 'OLD', walletCount: 3, wallets: [],
      walletSummary: '3 alpha', walletLabels: [], marketCap: 60_000, priceLive: true, priceUsd: 1,
      conviction: 95, prime: true, firstSeen: Date.now(),
    } as unknown as Swarm);
    expect(log).toHaveLength(0);
    const d = (await eng.snapshot()).decisions;
    expect(d[0]!.reason).toContain('legacy signal');
  });

  it('records a decision + reason for every signal', async () => {
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor([]), stubSafety());
    await eng.onAlert(swarm()); // disabled
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], minScore: 60 });
    await eng.onAlert(swarm({ token: '0xa', score: 30 })); // below floor
    await eng.onAlert(swarm({ token: '0xtok', score: 75 })); // bought
    const d = (await eng.snapshot()).decisions;
    expect(d[0]!.action).toBe('bought'); // newest first
    expect(d.some((x) => x.reason === 'sniper is OFF')).toBe(true);
    expect(d.some((x) => x.reason.includes('below floor 60'))).toBe(true);
  });

  it('manual sell-now closes an open position', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert(swarm());
    const id = (await eng.snapshot()).positions[0]!.id;
    await eng.sellNow(id);
    expect(log).toContain('sell:0xtok');
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('manual');
  });

  it('auto-sells at take-profit and books realized PnL', async () => {
    const log: string[] = [];
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 50 });
    await eng.onAlert(swarm());

    prices['0xtok'] = 2; // +100% → past the 50% take-profit
    // @ts-expect-error exercise the private sampler
    await eng.sample();

    expect(log).toContain('sell:0xtok');
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('take-profit');
    // Realized PnL now books the ACTUAL ETH received on the sell (stub: 0.002) minus
    // the 0.0005 Ξ spent = +0.0015 — the real fill, not a price-ratio estimate.
    expect(snap.pnl.realizedPnlEth).toBeCloseTo(0.0015, 6);
    expect(snap.positions[0]!.exitValueEth).toBe(0.002);
    expect(snap.positions[0]!.exitSlippagePct).toBe(0); // stub: received == quoted
  });

  it('imports a wallet holding with the real symbol, MC, and a market-priced ETH value', async () => {
    // On-chain quote returns ~0 (thin/odd route) but the market price is real —
    // ethIn should come from tokens*price/ETHprice, not the flaky quote.
    const prices: Record<string, number> = { '0xheld': 0.001 }; // token USD price
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([], {
      valueInEth: async () => ({ tokens: 1000, ethOut: 0 }), // flaky on-chain quote
      tokenMeta: async () => ({ symbol: 'IMAGINE', totalSupply: 1_000_000 }),
    }), stubSafety());
    const pos = await eng.importPosition('0xheld');
    expect(pos.tokenSymbol).toBe('IMAGINE');
    expect(pos.entryMarketCap).toBe(1000); // 0.001 * 1,000,000
    // 1000 tokens * $0.001 / ($2000/ETH) = 0.0005 ETH — not the flaky 0 quote.
    expect(pos.ethIn).toBeCloseTo(0.0005, 6);
  });

  it('re-importing an already-tracked token replaces the stale record', async () => {
    const prices: Record<string, number> = { '0xheld': 0.001 };
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([]), stubSafety());
    const first = await eng.importPosition('0xheld');
    const second = await eng.importPosition('0xheld');
    expect(second.id).not.toBe(first.id);
    const snap = await eng.snapshot();
    expect(snap.positions.filter((p) => p.status === 'open')).toHaveLength(1);
  });

  it('refuses to auto-replace a REAL bought position on re-import (must Untrack first)', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert(swarm()); // a genuine buy, buyTx = '0xbuy' (not 'imported')

    await expect(eng.importPosition('0xtok')).rejects.toThrow(/REAL bought position/);

    // Untrack first, then import succeeds and the audit log keeps the real tx.
    const id = (await eng.snapshot()).positions[0]!.id;
    eng.untrack(id);
    const imported = await eng.importPosition('0xtok');
    expect(imported.buyTx).toBe('imported');

    const snap = await eng.snapshot();
    expect(snap.removedLog).toHaveLength(1);
    expect(snap.removedLog[0]!.buyTx).toBe('0xbuy');
  });

  it('restores a position from a real tx with the EXACT on-chain amounts', async () => {
    const prices: Record<string, number> = { '0xheld': 0.0001 };
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([], {
      readBuyTx: async () => ({
        ethSpent: 0.0008,
        tokensReceived: 13583.78,
        blockTimestamp: 1_700_000_000_000,
        gasEth: 0.00001,
      }),
      tokenMeta: async () => ({ symbol: 'IMAGINE', totalSupply: 1_000_000_000 }),
    }), stubSafety());
    const pos = await eng.restoreFromTx('0xheld', '0xreal51238fe9');
    expect(pos.tokenSymbol).toBe('IMAGINE');
    expect(pos.ethIn).toBeCloseTo(0.0008, 8); // the EXACT real spend, not a re-valued guess
    expect(pos.tokensReceived).toBeCloseTo(13583.78, 2);
    expect(pos.buyTx).toBe('0xreal51238fe9');
    expect(pos.openedAt).toBe(1_700_000_000_000); // the real block time, not "now"
    // entryPriceUsd derived from the real spend ratio: 0.0008*2000/13583.78
    expect(pos.entryPriceUsd).toBeCloseTo((0.0008 * 2000) / 13583.78, 8);
  });

  it('restoring the SAME tx again updates the record instead of throwing', async () => {
    const prices: Record<string, number> = { '0xheld': 0.0001 };
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([]), stubSafety());
    const first = await eng.restoreFromTx('0xheld', '0xsametx');
    const second = await eng.restoreFromTx('0xheld', '0xsametx');
    expect(second.id).not.toBe(first.id); // re-confirmed as a fresh record
    const snap = await eng.snapshot();
    expect(snap.positions.filter((p) => p.status === 'open')).toHaveLength(1);
  });

  it('restoring with a DIFFERENT real tx than an existing real position is refused', async () => {
    const prices: Record<string, number> = { '0xheld': 0.0001 };
    const eng = new SniperEngine(stubPrice(prices, 2000), stubExecutor([]), stubSafety());
    await eng.restoreFromTx('0xheld', '0xfirsttx');
    await expect(eng.restoreFromTx('0xheld', '0xdifferenttx')).rejects.toThrow(/REAL bought position/);
  });

  it('captures real gas + tax + protocol-fee data on a buy, and computes net-of-gas PnL', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(
      stubPrice({ '0xtok': 1 }),
      stubExecutor(log, { protocolFeeInfo: async () => ({ hook: '0xbags', feePctPerSwap: 2 }) }),
      stubSafety(0, 3), // 0% buy tax, 3% sell tax
    );
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert(swarm());

    const snap = await eng.snapshot();
    const pos = snap.positions[0]!;
    expect(pos.buyGasEth).toBeCloseTo(0.00001, 8);
    expect(pos.buyTaxPct).toBe(0);
    expect(pos.sellTaxPct).toBe(3);
    expect(pos.protocolFeePctPerSwap).toBe(2);
    // gasEth (view) = buyGasEth only so far (no sell yet); net = pnl - gas.
    expect(pos.gasEth).toBeCloseTo(0.00001, 8);
    expect(pos.netPnlEth).toBeCloseTo(pos.pnlEth - 0.00001, 8);
  });

  it('rolls buy + sell gas into netPnlEth once a position is closed', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert(swarm());
    const id = (await eng.snapshot()).positions[0]!.id;
    await eng.sellNow(id);

    const snap = await eng.snapshot();
    const pos = snap.positions[0]!;
    expect(pos.gasEth).toBeCloseTo(0.00002, 8); // buy gas + sell gas
    expect(snap.pnl.totalGasEth).toBeCloseTo(0.00002, 8);
    expect(snap.pnl.netPnlEth).toBeCloseTo(snap.pnl.totalPnlEth - 0.00002, 8);
  });

  it('per-position take-profit overrides the global setting', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 90 }); // global: far away
    await eng.onAlert(swarm());
    const id = (await eng.snapshot()).positions[0]!.id;
    eng.setPositionTakeProfit(id, 20); // this position: much tighter

    prices['0xtok'] = 1.25; // +25% — past this position's 20%, not the global 90%
    // @ts-expect-error exercise the private sampler
    await eng.sample();

    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('take-profit');
  });

  it('setting take-profit to null disables it for that position', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 10 }); // global would fire
    await eng.onAlert(swarm());
    const id = (await eng.snapshot()).positions[0]!.id;
    eng.setPositionTakeProfit(id, null); // disable for this one

    prices['0xtok'] = 2; // +100%, well past the global 10%
    // @ts-expect-error exercise the private sampler
    await eng.sample();

    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('open'); // stays open — TP is off
  });

  it('honeypot gate: skips a buy when the safety check fails (cannot sell)', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety(0, 0, false, ['honeypot']));
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'] });
    await eng.onAlert(swarm());
    expect(log.some((l) => l.startsWith('buy'))).toBe(false); // never bought the honeypot
  });

  it('trailing stop: exits when price falls trailingStopPct below the peak', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 0, trailingStopPct: 15 });
    await eng.onAlert(swarm()); // entry @ 1
    prices['0xtok'] = 2; // runs to 2 → peak 2, no drawdown
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    expect((await eng.snapshot()).positions[0]!.status).toBe('open');
    prices['0xtok'] = 1.6; // −20% off the peak (past 15%)
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('trailing-stop');
  });

  it('rug guard: dumps when the on-chain sell value collapses past rugDropPct, even with price healthy', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const quote = { tokens: 1000, ethOut: 0.001 };
    const eng = new SniperEngine(
      stubPrice(prices),
      stubExecutor([], { valueInEth: async () => ({ ...quote }) }),
      stubSafety(),
    );
    // Trailing stop OFF so ONLY the rug guard can close this — isolates the new path.
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 0, trailingStopPct: 0, rugGuard: true, rugDropPct: 50 });
    await eng.onAlert(swarm()); // entry
    // First sample establishes the exit-value high-water (peak 0.001); display price stays healthy at 1.
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    expect((await eng.snapshot()).positions[0]!.status).toBe('open');
    // Liquidity pulled: the executable sell value craters 60% while the display price is unchanged.
    quote.ethOut = 0.0004;
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    const snap2 = await eng.snapshot();
    expect(snap2.positions[0]!.status).toBe('closed');
    expect(snap2.positions[0]!.closeReason).toBe('rug-pull');
  });

  it('rug guard: does NOT fire on a healthy runner whose sell value keeps rising', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const quote = { tokens: 1000, ethOut: 0.001 };
    const eng = new SniperEngine(
      stubPrice(prices),
      stubExecutor([], { valueInEth: async () => ({ ...quote }) }),
      stubSafety(),
    );
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 0, trailingStopPct: 0, rugGuard: true, rugDropPct: 50 });
    await eng.onAlert(swarm());
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    quote.ethOut = 0.003; // 3× up — value climbing, no pull
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    expect((await eng.snapshot()).positions[0]!.status).toBe('open');
  });

  it('trailing stop doubles as stop-loss: a coin that never runs exits near −trailingStopPct', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, enabledLanes: ['allocation'], takeProfitPct: 0, trailingStopPct: 15 });
    await eng.onAlert(swarm()); // entry @ 1, peak = entry = 1
    prices['0xtok'] = 0.8; // −20% from entry, never made a new high
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('trailing-stop');
  });
});

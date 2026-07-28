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
  }> = {},
) {
  return {
    ready: true,
    address: () => '0xwallet',
    async balanceEth() {
      return 1;
    },
    async buy(token: string, eth: number) {
      log.push('buy:' + token + ':' + eth);
      return { txHash: '0xbuy', tokensReceived: 1000, ethSpent: eth, gasEth: 0.00001 };
    },
    async sell(token: string) {
      log.push('sell:' + token);
      return { txHash: '0xsell', ethReceived: 0.002, tokensSold: 1000, gasEth: 0.00001 };
    },
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

function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    id: 's-' + Math.random().toString(36).slice(2),
    kind: 'BUY',
    token: '0xtok',
    tokenSymbol: 'GEM',
    walletCount: 3,
    wallets: [],
    walletSummary: '3 alpha',
    walletLabels: [],
    totalUsd: 3000,
    marketCap: 60_000,
    newToken: false,
    dexUrl: 'x',
    priceLive: true,
    priceUsd: 1,
    conviction: 75,
    convictionBreakdown: {
      walletQuality: 0, walletCount: 0, totalCapital: 0, velocity: 0,
      liquidity: 0, marketCap: 0, historicalAccuracy: 0, buySellRatio: 0,
    },
    windowSeconds: 10,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...over,
  };
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
    eng.updateSettings({ enabled: true, buyEth: 0.0001 }); // below the floor
    await eng.onAlert(swarm());
    expect(log).toEqual(['buy:0xtok:' + MIN_BUY_ETH]); // floored up to 0.0005
    const snap = await eng.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.status).toBe('open');
  });

  it('skips alerts outside the conviction band, wrong kind, or already held', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1, '0xb': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true, minConviction: 60, maxConviction: 100 });
    await eng.onAlert(swarm({ token: '0xa', conviction: 50 })); // too low
    await eng.onAlert(swarm({ token: '0xb', kind: 'SELL' })); // wrong kind
    expect(log).toHaveLength(0);
    // First buy of 0xtok works; a second alert for the same token is skipped.
    await eng.onAlert(swarm({ token: '0xtok' }));
    await eng.onAlert(swarm({ token: '0xtok' }));
    expect(log).toEqual(['buy:0xtok:0.0005']);
  });

  it('records a decision + reason for every alert', async () => {
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor([]), stubSafety());
    await eng.onAlert(swarm()); // disabled
    eng.updateSettings({ enabled: true, minConviction: 60, maxConviction: 100 });
    await eng.onAlert(swarm({ token: '0xa', conviction: 30 })); // below band
    await eng.onAlert(swarm({ token: '0xtok', conviction: 75 })); // bought
    const d = (await eng.snapshot()).decisions;
    expect(d[0]!.action).toBe('bought'); // newest first
    expect(d.some((x) => x.reason === 'sniper is OFF')).toBe(true);
    expect(d.some((x) => x.reason.includes('outside 60-100'))).toBe(true);
  });

  it('manual sell-now closes an open position', async () => {
    const log: string[] = [];
    const eng = new SniperEngine(stubPrice({ '0xtok': 1 }), stubExecutor(log), stubSafety());
    eng.updateSettings({ enabled: true });
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
    eng.updateSettings({ enabled: true, takeProfitPct: 50 });
    await eng.onAlert(swarm());

    prices['0xtok'] = 2; // +100% → past the 50% take-profit
    // @ts-expect-error exercise the private sampler
    await eng.sample();

    expect(log).toContain('sell:0xtok');
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('take-profit');
    expect(snap.pnl.realizedPnlEth).toBeCloseTo(0.0005, 6); // entry 0.0005 Ξ → 2x = +0.0005
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
    eng.updateSettings({ enabled: true });
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
    eng.updateSettings({ enabled: true });
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
    eng.updateSettings({ enabled: true });
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
    eng.updateSettings({ enabled: true, takeProfitPct: 90 }); // global: far away
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
    eng.updateSettings({ enabled: true, takeProfitPct: 10 }); // global would fire
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
    eng.updateSettings({ enabled: true });
    await eng.onAlert(swarm());
    expect(log.some((l) => l.startsWith('buy'))).toBe(false); // never bought the honeypot
  });

  it('trailing stop: exits when price falls trailingStopPct below the peak', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, takeProfitPct: 0, trailingStopPct: 15 });
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

  it('trailing stop doubles as stop-loss: a coin that never runs exits near −trailingStopPct', async () => {
    const prices: Record<string, number> = { '0xtok': 1 };
    const eng = new SniperEngine(stubPrice(prices), stubExecutor([]), stubSafety());
    eng.updateSettings({ enabled: true, takeProfitPct: 0, trailingStopPct: 15 });
    await eng.onAlert(swarm()); // entry @ 1, peak = entry = 1
    prices['0xtok'] = 0.8; // −20% from entry, never made a new high
    // @ts-expect-error exercise the private sampler
    await eng.sample();
    const snap = await eng.snapshot();
    expect(snap.positions[0]!.status).toBe('closed');
    expect(snap.positions[0]!.closeReason).toBe('trailing-stop');
  });
});

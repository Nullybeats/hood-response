import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { PriceOracle } from '../chain/price.js';
import { Aggregator } from '../engine/aggregator.js';
import { AlertEngine } from '../engine/alertEngine.js';
import type { Swarm } from '../types.js';

function makeEngine(): { store: MemoryStore; agg: Aggregator; engine: AlertEngine } {
  const store = new MemoryStore();
  const price = new PriceOracle([...store.tokensByAddress.values()]);
  const agg = new Aggregator(store, price);
  const engine = new AlertEngine(store, agg);
  return { store, agg, engine };
}

function soloSwarm(
  token: string,
  marketCap: number | null,
  opts: { wallet?: string; price?: number } = {},
): Swarm {
  return {
    id: 'swarm-' + Math.random().toString(36).slice(2),
    kind: 'SOLO',
    token,
    tokenSymbol: 'GEM',
    walletCount: 1,
    wallets: [opts.wallet ?? '0x1'],
    walletSummary: '1 retail',
    totalUsd: 500,
    marketCap,
    priceUsd: opts.price ?? null,
    conviction: 12,
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
    windowSeconds: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    newToken: true,
    dexUrl: 'https://dexscreener.com/x',
    priceLive: true,
  };
}

describe('AlertEngine', () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it('seeds a default swarm rule and a solo low-cap rule', () => {
    const ids = ctx.engine.listRules().map((r) => r.id);
    expect(ids).toContain('default');
    expect(ids).toContain('solo-lowcap');
  });

  it('keeps the multi-wallet detection floor at 2 despite the 1-wallet solo rule', () => {
    // The solo rule has minWallets 1 but must not lower the swarm threshold.
    expect(ctx.agg.detectionFloor).toBe(2);
  });

  it('fires a solo alert only when market cap is under the cap', async () => {
    const under = await ctx.engine.evaluate(soloSwarm('0xlowcap', 50_000));
    expect(under).toHaveLength(1);
    expect(under[0]!.ruleId).toBe('solo-lowcap');

    const over = await ctx.engine.evaluate(soloSwarm('0xhighcap', 250_000));
    expect(over).toHaveLength(0);

    // Below the market-cap floor (dust) → no solo alert.
    const dust = await ctx.engine.evaluate(soloSwarm('0xdust', 5_000));
    expect(dust).toHaveLength(0);
  });

  it('fails closed on an UNKNOWN market cap — the ANOA case', async () => {
    // A cap-banded rule cannot establish band membership without a cap. Null
    // used to sail through `swarm.marketCap <= 0` because the oracle guaranteed
    // a (fabricated) positive number, so the branch was never exercised.
    const unknown = await ctx.engine.evaluate(soloSwarm('0xunknown', null));
    expect(unknown).toHaveLength(0);
  });

  it('does not match a solo swarm against the multi-wallet default rule', async () => {
    const fired = await ctx.engine.evaluate(soloSwarm('0xzz', 40_000));
    // Only the solo rule should fire, never the default BUY/SELL/ROTATION rule.
    expect(fired.every((a) => a.ruleId === 'solo-lowcap')).toBe(true);
  });

  it('escalates on DISTINCT wallets, reports % change since last alert, flags new holder', async () => {
    const first = soloSwarm('0xrepeat', 50_000, { wallet: '0xaaa', price: 100 });
    await ctx.engine.evaluate(first);
    expect(first.repeatCount).toBe(1);
    expect(first.repeatWallets).toBe(1);
    expect(first.repeatNewWallet).toBe(false);
    expect(first.repeatPriceChangePct).toBeNull();
    expect(first.conviction).toBe(12); // no escalation on the first

    // A DIFFERENT top holder buys the same coin, price up 10% → strongest repeat.
    const second = soloSwarm('0xrepeat', 50_000, { wallet: '0xbbb', price: 110 });
    await ctx.engine.evaluate(second);
    expect(second.repeatCount).toBe(2);
    expect(second.repeatWallets).toBe(2);
    expect(second.repeatNewWallet).toBe(true);
    expect(second.repeatPriceChangePct).toBe(10);
    expect(second.repeatWindowMinutes).toBeGreaterThan(0);
    expect(second.conviction).toBe(20); // +4 distinct-wallet + 4 new-holder

    // A third distinct holder, price down vs the last alert (110 → 99 = -10%).
    const third = soloSwarm('0xrepeat', 50_000, { wallet: '0xccc', price: 99 });
    await ctx.engine.evaluate(third);
    expect(third.repeatCount).toBe(3);
    expect(third.repeatWallets).toBe(3);
    expect(third.repeatPriceChangePct).toBe(-10);
    expect(third.conviction).toBe(24); // +8 distinct-wallet + 4 new-holder

    // A different token keeps its own independent count.
    const other = soloSwarm('0xother', 50_000, { wallet: '0xaaa' });
    await ctx.engine.evaluate(other);
    expect(other.repeatCount).toBe(1);
  });

  it('suppresses the same busy wallet re-buying, but lets a different wallet through', async () => {
    // Even with no cooldown, a lone repeat from an already-seen wallet is the
    // noise we want gone — while a NEW wallet on the same token always fires.
    const solo = ctx.engine.listRules().find((r) => r.id === 'solo-lowcap')!;
    ctx.engine.upsertRule({ ...solo, cooldownSeconds: 0 });

    const first = soloSwarm('0xbusy', 50_000, { wallet: '0xhot' });
    expect(await ctx.engine.evaluate(first)).toHaveLength(1);

    const again = soloSwarm('0xbusy', 50_000, { wallet: '0xhot' });
    expect(await ctx.engine.evaluate(again)).toHaveLength(0); // same wallet → suppressed
    expect(again.repeatCount).toBeUndefined();

    const other = soloSwarm('0xbusy', 50_000, { wallet: '0xnew' });
    expect(await ctx.engine.evaluate(other)).toHaveLength(1); // different wallet → fires
    expect(other.repeatNewWallet).toBe(true);
    expect(other.repeatWallets).toBe(2);
  });

  it('does not count a swarm that fires no alert', async () => {
    // Over the cap → suppressed → must not consume a repeat slot for the token.
    const over = soloSwarm('0xnofire', 250_000);
    await ctx.engine.evaluate(over);
    expect(over.repeatCount).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../store/memory.js';
import { PriceOracle } from '../chain/price.js';
import { Aggregator } from '../engine/aggregator.js';
import type { SwapEvent } from '../types.js';

function makeStore(): { store: MemoryStore; agg: Aggregator; wallets: string[]; token: string } {
  const store = new MemoryStore();
  const price = new PriceOracle([...store.tokensByAddress.values()]);
  const agg = new Aggregator(store, price);
  agg.detectionFloor = 3;
  agg.maxWindowSeconds = 30;
  const token = store.tokensBySymbol.get('CASHCAT')!.address;
  const wallets = [...store.wallets.keys()].slice(0, 6);
  return { store, agg, wallets, token };
}

function swap(wallet: string, token: string, direction: 'BUY' | 'SELL', ts: number): SwapEvent {
  return {
    txHash: '0x0',
    wallet,
    token,
    tokenSymbol: 'CASHCAT',
    direction,
    amount: 100_000,
    usdValue: 5_000,
    blockNumber: 1,
    timestamp: ts,
  };
}

describe('Aggregator', () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });

  it('detects a swarm once the detection floor of unique wallets is crossed', () => {
    const { agg, wallets, token } = ctx;
    const now = Date.now();
    expect(agg.ingest(swap(wallets[0]!, token, 'BUY', now))).toHaveLength(0);
    expect(agg.ingest(swap(wallets[1]!, token, 'BUY', now + 100))).toHaveLength(0);
    const detected = agg.ingest(swap(wallets[2]!, token, 'BUY', now + 200));
    expect(detected).toHaveLength(1);
    expect(detected[0]!.kind).toBe('BUY');
    expect(detected[0]!.walletCount).toBe(3);
    expect(detected[0]!.tokenSymbol).toBe('CASHCAT');
    // Privacy-preserving makeup is populated for display.
    expect(detected[0]!.walletSummary).toMatch(/\d+\s\w/);
    // With no price source reachable, the market cap is UNKNOWN — not a number.
    // This assertion used to read `toBeGreaterThan(0)` and passed only because
    // the oracle fabricated a cap from a hash of the token address.
    expect(detected[0]!.marketCap).toBeNull();
    expect(detected[0]!.priceLive).toBe(false);
    expect(detected[0]!.priceSource).toBeNull();
  });

  it('does not re-emit for the same wallet set', () => {
    const { agg, wallets, token } = ctx;
    const now = Date.now();
    agg.ingest(swap(wallets[0]!, token, 'BUY', now));
    agg.ingest(swap(wallets[1]!, token, 'BUY', now));
    expect(agg.ingest(swap(wallets[2]!, token, 'BUY', now))).toHaveLength(1);
    // Same wallet buying again must not fire a new swarm.
    expect(agg.ingest(swap(wallets[2]!, token, 'BUY', now + 10))).toHaveLength(0);
    // A 4th distinct wallet grows the set and fires again.
    expect(agg.ingest(swap(wallets[3]!, token, 'BUY', now + 20))).toHaveLength(1);
  });

  it('ignores dust swaps below the threshold', () => {
    const { agg, wallets, token } = ctx;
    const now = Date.now();
    const dust = (w: string): SwapEvent => ({ ...swap(w, token, 'BUY', now), usdValue: 1 });
    agg.ingest(dust(wallets[0]!));
    agg.ingest(dust(wallets[1]!));
    expect(agg.ingest(dust(wallets[2]!))).toHaveLength(0);
  });

  it('ignores settlement/equity symbols (e.g. WETH) entirely', () => {
    const { agg, wallets, token } = ctx;
    const now = Date.now();
    const weth = (w: string): SwapEvent => ({ ...swap(w, token, 'BUY', now), tokenSymbol: 'WETH' });
    expect(agg.ingest(weth(wallets[0]!))).toHaveLength(0);
    expect(agg.ingest(weth(wallets[1]!))).toHaveLength(0);
    expect(agg.ingest(weth(wallets[2]!))).toHaveLength(0);
    expect(agg.soloCandidate(weth(wallets[0]!))).toBeNull();
    expect(agg.firstEntryCandidate(weth(wallets[0]!))).toBeNull();
  });

  it('does not count untracked wallets', () => {
    const { agg, token } = ctx;
    const now = Date.now();
    const detected = [
      agg.ingest(swap('0xdeadbeef00000000000000000000000000000001', token, 'BUY', now)),
      agg.ingest(swap('0xdeadbeef00000000000000000000000000000002', token, 'BUY', now)),
      agg.ingest(swap('0xdeadbeef00000000000000000000000000000003', token, 'BUY', now)),
    ].flat();
    expect(detected).toHaveLength(0);
  });

  it('discovers a brand-new token when tracked wallets swarm into it', () => {
    const { store, agg, wallets } = ctx;
    const unknown = '0xnew0000000000000000000000000000000000cafe';
    expect(store.tokensByAddress.has(unknown)).toBe(false);
    const buy = (w: string): SwapEvent => ({
      ...swap(w, unknown, 'BUY', Date.now()),
      tokenSymbol: 'MOONPIG777',
    });
    agg.ingest(buy(wallets[0]!));
    agg.ingest(buy(wallets[1]!));
    const detected = agg.ingest(buy(wallets[2]!));
    expect(detected).toHaveLength(1);
    expect(detected[0]!.newToken).toBe(true);
    expect(detected[0]!.tokenSymbol).toBe('MOONPIG777');
    // The token is now auto-registered as discovered.
    const token = store.tokensByAddress.get(unknown);
    expect(token?.discovered).toBe(true);
  });

  it('throttles a solo per (wallet, token) but lets a different wallet through', () => {
    const { agg, wallets, token } = ctx;
    const now = Date.now();
    const solo = agg.soloCandidate(swap(wallets[0]!, token, 'BUY', now));
    expect(solo).not.toBeNull();
    expect(solo!.kind).toBe('SOLO');
    expect(solo!.walletCount).toBe(1);
    // Same wallet buying the same token again right away is throttled.
    expect(agg.soloCandidate(swap(wallets[0]!, token, 'BUY', now + 1000))).toBeNull();
    // A DIFFERENT tracked wallet on the same token is NOT throttled — we must
    // not let one busy wallet hide the others.
    expect(agg.soloCandidate(swap(wallets[1]!, token, 'BUY', now + 1000))).not.toBeNull();
    // Sells never produce solo candidates.
    expect(agg.soloCandidate(swap(wallets[2]!, token, 'SELL', now))).toBeNull();
  });

  it('emits a first-entry candidate only for a qualifying-tier wallet, once', () => {
    const { store, agg, token } = ctx;
    const now = Date.now();
    const alpha = [...store.wallets.values()].find((w) => w.tier === 'alpha')!.address;
    const delta = [...store.wallets.values()].find((w) => w.tier === 'delta')!.address;

    const first = agg.firstEntryCandidate(swap(alpha, token, 'BUY', now));
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('ENTRY');
    expect(first!.walletCount).toBe(1);

    // Same wallet+token again → not a first entry.
    expect(agg.firstEntryCandidate(swap(alpha, token, 'BUY', now + 1000))).toBeNull();

    // A delta wallet is below the default fresh-entry tier gate (alpha,beta).
    const otherToken = store.tokensBySymbol.get('TENDIES')!.address;
    expect(agg.firstEntryCandidate(swap(delta, otherToken, 'BUY', now))).toBeNull();
  });

  it('mutes a wallet group so its wallets drop out, and restores them on unmute', () => {
    const { store, agg, token } = ctx;
    const now = Date.now();
    // A wallet sourced from a single coin — muting that coin should silence it.
    const solo = [...store.wallets.values()].find((w) => w.holdsTokens.length === 1)!;
    const coin = solo.holdsTokens[0]!;

    expect(agg.soloCandidate(swap(solo.address, token, 'BUY', now))).not.toBeNull();

    store.mutedTokens.add(coin.toUpperCase());
    expect(store.isWalletMuted(solo.address)).toBe(true);
    // Muted → ineligible for solo, swarm, and first-entry alike.
    expect(agg.soloCandidate(swap(solo.address, token, 'BUY', now + 61_000))).toBeNull();
    expect(agg.ingest(swap(solo.address, token, 'BUY', now + 61_000))).toHaveLength(0);

    // A cross-conviction wallet (holds more than the muted coin) stays active.
    const cross = [...store.wallets.values()].find(
      (w) => w.holdsTokens.length > 1 && w.holdsTokens.some((c) => c.toUpperCase() === coin.toUpperCase()),
    );
    if (cross) expect(store.isWalletMuted(cross.address)).toBe(false);

    store.mutedTokens.delete(coin.toUpperCase());
    expect(store.isWalletMuted(solo.address)).toBe(false);
    expect(agg.soloCandidate(swap(solo.address, token, 'BUY', now + 122_000))).not.toBeNull();
  });

  it('suppresses blue-chip buys/sells only when the matching side is toggled off', () => {
    const { store, token } = ctx; // token = CASHCAT, a seed/blue-chip coin
    expect(store.isBlueChip(token)).toBe(true);
    // A discovered coin is not a blue chip.
    store.ensureToken('0xdiscovered000000000000000000000000000abc', 'NEWGEM');
    expect(store.isBlueChip('0xdiscovered000000000000000000000000000abc')).toBe(false);

    // Defaults on → nothing suppressed.
    expect(store.blueChipSuppressed('BUY', token)).toBe(false);
    expect(store.blueChipSuppressed('SELL', token)).toBe(false);

    // Buys off → buy-side kinds suppressed, sell-side untouched.
    store.blueChipBuys = false;
    expect(store.blueChipSuppressed('BUY', token)).toBe(true);
    expect(store.blueChipSuppressed('SOLO', token)).toBe(true);
    expect(store.blueChipSuppressed('ENTRY', token)).toBe(true);
    expect(store.blueChipSuppressed('SELL', token)).toBe(false);

    // Sells off → sell-side kinds suppressed.
    store.blueChipSells = false;
    expect(store.blueChipSuppressed('SELL', token)).toBe(true);
    expect(store.blueChipSuppressed('ROTATION', token)).toBe(true);

    // A discovered (non-blue-chip) coin is never suppressed by this filter.
    expect(store.blueChipSuppressed('BUY', '0xdiscovered000000000000000000000000000abc')).toBe(false);
  });

  it('detects rotation when sellers of one token buy another', () => {
    const { store, agg, wallets } = ctx;
    const tokenA = store.tokensBySymbol.get('CASHCAT')!.address;
    const tokenB = store.tokensBySymbol.get('TENDIES')!.address;
    const now = Date.now();
    // 3 wallets sell token A.
    agg.ingest(swap(wallets[0]!, tokenA, 'SELL', now));
    agg.ingest(swap(wallets[1]!, tokenA, 'SELL', now));
    agg.ingest(swap(wallets[2]!, tokenA, 'SELL', now));
    // Same 3 wallets buy token B → BUY swarm + ROTATION.
    agg.ingest(swap(wallets[0]!, tokenB, 'BUY', now + 10));
    agg.ingest(swap(wallets[1]!, tokenB, 'BUY', now + 10));
    const result = agg.ingest(swap(wallets[2]!, tokenB, 'BUY', now + 10));
    const kinds = result.map((s) => s.kind);
    expect(kinds).toContain('BUY');
    expect(kinds).toContain('ROTATION');
    const rotation = result.find((s) => s.kind === 'ROTATION')!;
    expect(rotation.rotatedIntoSymbol).toBe('TENDIES');
  });
});

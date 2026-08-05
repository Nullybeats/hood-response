import { describe, it, expect } from 'vitest';
import { resolveMarketCap } from '../chain/marketCap.js';
import { fetchTokenMetadata } from '../chain/metadata.js';

/**
 * ANOA, the coin these guards exist for: 8 escalating BUY alerts at a fabricated
 * $13.1M cap (hash(address) * the 1e9 placeholder supply) against a real $2,598,
 * clearing the $25k floor whose only job was to stop it.
 */
const ANOA_FABRICATED_CAP = 13_098_760;
const ANOA_PLACEHOLDER_SUPPLY = 1_000_000_000;
const ANOA_HASH_PRICE = 0.01309876;

describe('market cap — multi-source resolution', () => {
  it("prefers the indexer's own cap, which knows circulating supply", () => {
    const r = resolveMarketCap({
      sourceCap: 45_777,
      price: 0.00004692,
      totalSupply: 975_000_000,
      supplyVerified: true,
    });
    expect(r.cap).toBe(45_777);
    expect(r.source).toBe('dexscreener');
    expect(r.reason).toBe('ok');
  });

  it('falls back to price x on-chain supply when the indexer has no cap', () => {
    // The brand-new-coin window: priced off its own pool, not yet indexed.
    const r = resolveMarketCap({
      sourceCap: null,
      price: 0.0000025788,
      totalSupply: 1_000_000_000,
      supplyVerified: true,
    });
    expect(r.source).toBe('derived-onchain');
    expect(r.cap).toBeCloseTo(2_578.8, 1);
  });

  it('is unknown — not zero, not a guess — when nothing has a price', () => {
    const r = resolveMarketCap({
      sourceCap: null,
      price: null,
      totalSupply: 1_000_000_000,
      supplyVerified: true,
    });
    expect(r.cap).toBeNull();
    expect(r.source).toBeNull();
    expect(r.reason).toBe('no-price');
  });

  it('REGRESSION (ANOA): refuses to multiply a price by a PLACEHOLDER supply', () => {
    const r = resolveMarketCap({
      sourceCap: null,
      price: ANOA_HASH_PRICE,
      totalSupply: ANOA_PLACEHOLDER_SUPPLY,
      supplyVerified: false, // ensureToken's placeholder, never read from chain
    });
    // The exact number this guard exists to prevent.
    expect(r.cap).not.toBe(ANOA_FABRICATED_CAP);
    expect(r.cap).toBeNull();
    expect(r.reason).toBe('unverified-supply');
  });

  it('rejects non-finite and non-positive inputs rather than propagating them', () => {
    expect(resolveMarketCap({ sourceCap: 0, price: null, totalSupply: 1, supplyVerified: true }).cap).toBeNull();
    expect(resolveMarketCap({ sourceCap: -5, price: null, totalSupply: 1, supplyVerified: true }).cap).toBeNull();
    expect(
      resolveMarketCap({ sourceCap: NaN, price: NaN, totalSupply: 1, supplyVerified: true }).cap,
    ).toBeNull();
    expect(
      resolveMarketCap({ sourceCap: null, price: Infinity, totalSupply: 1, supplyVerified: true }).cap,
    ).toBeNull();
    // A verified supply of 0 is not a supply.
    expect(
      resolveMarketCap({ sourceCap: null, price: 1, totalSupply: 0, supplyVerified: true }).reason,
    ).toBe('unverified-supply');
  });

  it('distinguishes the two unknowns, because they have different fixes', () => {
    const noPrice = resolveMarketCap({
      sourceCap: null,
      price: null,
      totalSupply: 1e9,
      supplyVerified: false,
    });
    const noSupply = resolveMarketCap({
      sourceCap: null,
      price: 0.001,
      totalSupply: 1e9,
      supplyVerified: false,
    });
    expect(noPrice.reason).toBe('no-price');
    expect(noSupply.reason).toBe('unverified-supply'); // this one is backfillable
  });
});

describe('token metadata — decimals and supply are independent', () => {
  /** Scripted eth_call responses keyed by selector. */
  function rpcServer(responses: Record<string, string | null>) {
    const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567', supply: '0x18160ddd' };
    return async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const data: string = body?.params?.[0]?.data ?? '';
      const which =
        data.startsWith(SEL.symbol) ? 'symbol' : data.startsWith(SEL.decimals) ? 'decimals' : 'supply';
      const result = responses[which];
      return {
        ok: true,
        json: async () => (result == null ? { error: { message: 'boom' } } : { result }),
      } as unknown as Response;
    };
  }

  const uint = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

  it('REGRESSION: a failed totalSupply() no longer discards the decimals', async () => {
    const original = globalThis.fetch;
    // decimals resolves; supply times out. Previously BOTH were dropped, which
    // made buildSwapFromLog return null and the token invisible to detection.
    globalThis.fetch = rpcServer({
      symbol: null,
      decimals: uint(18n),
      supply: null,
    }) as unknown as typeof fetch;
    try {
      const meta = await fetchTokenMetadata('http://rpc.test', '0xabc');
      expect(meta).not.toBeNull();
      expect(meta!.decimals).toBe(18); // the swap can now be decoded…
      expect(meta!.supplyVerified).toBeUndefined(); // …but the cap stays honest
      expect(meta!.totalSupply).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sets supplyVerified only when the contract actually returned a supply', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = rpcServer({
      symbol: null,
      decimals: uint(18n),
      supply: uint(1_000_000n * 10n ** 18n),
    }) as unknown as typeof fetch;
    try {
      const meta = await fetchTokenMetadata('http://rpc.test', '0xabc');
      expect(meta!.supplyVerified).toBe(true);
      expect(meta!.totalSupply).toBe(1_000_000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('never marks supply verified when decimals are unreadable', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = rpcServer({
      symbol: null,
      decimals: null,
      supply: uint(10n ** 24n),
    }) as unknown as typeof fetch;
    try {
      const meta = await fetchTokenMetadata('http://rpc.test', '0xabc');
      // A raw supply without decimals cannot be scaled — guessing 18 here is how
      // a cap ends up off by orders of magnitude.
      expect(meta?.supplyVerified).toBeUndefined();
      expect(meta?.decimals).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

import { describe, it, expect } from 'vitest';
import { AbiCoder, id } from 'ethers';
import {
  PoolVerifier,
  verifyV3Pool,
  verifyV4Pool,
  type EthCall,
} from '../attrib/poolVerify.js';
import { INIT_TOPIC, POOL_MANAGER, V3_FACTORY } from '../chain/uniswap.js';
import { classifyTransaction } from '../attrib/classifier.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../chain/receipt.js';
import type { TxLogView } from '../attrib/protocols/types.js';

// Real values captured from chain 4663 on 2026-08-05.
const POOL = '0x2dc56aa90f90a328e0fad9660bf01115bac2d628';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const PORT = '0x14112893f576c12f65b9f0f88e9a9a12723239b5';
const FEE = 10000;
const FACTORY = V3_FACTORY.toLowerCase();

const SEL = {
  factory: '0xc45a0155',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  getPool: '0x1698ee82',
};
const word = (v: string) => '0x' + v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const numWord = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** An honest node reproducing the real pool's answers. */
function goodNode(over: Partial<Record<string, string>> = {}): EthCall {
  return async (to, data) => {
    const t = to.toLowerCase();
    if (t === POOL) {
      if (data === SEL.factory) return { ok: true, result: over.factory ?? word(FACTORY) };
      if (data === SEL.token0) return { ok: true, result: word(WETH) };
      if (data === SEL.token1) return { ok: true, result: word(PORT) };
      if (data === SEL.fee) return { ok: true, result: numWord(FEE) };
    }
    if (t === FACTORY && data.startsWith(SEL.getPool)) {
      return { ok: true, result: over.getPool ?? word(POOL) };
    }
    return { ok: true, result: '0x' };
  };
}

describe('pool verification — identity, not a non-zero response', () => {
  it('VERIFIES the real pool: trusted factory + round-trip', async () => {
    const v = await verifyV3Pool(POOL, goodNode());
    expect(v.status).toBe('verified');
    expect(v.evidence.claimedFactory).toBe(FACTORY);
    expect(v.evidence.token0).toBe(WETH);
    expect(v.evidence.token1).toBe(PORT);
    expect(v.evidence.fee).toBe(FEE);
    expect(v.evidence.roundTripPool).toBe(POOL);
    // The proof is persisted so it can be re-run by hand.
    expect(v.evidence.rpcCalls!.map((c) => c.method)).toEqual([
      'factory()',
      'token0()',
      'token1()',
      'fee()',
      'getPool()',
    ]);
  });

  it('REJECTS a pool claiming an UNTRUSTED factory', async () => {
    // Anyone can deploy a contract that answers factory().
    const v = await verifyV3Pool(POOL, goodNode({ factory: word('0xdeadbeef') }));
    expect(v.status).toBe('unverified');
    expect(v.reason).toContain('not the trusted factory');
  });

  it('REJECTS when the round-trip names a DIFFERENT pool', async () => {
    // pool.factory() is the pool's claim about ITSELF. Only getPool is the
    // trusted factory independently naming this address.
    const v = await verifyV3Pool(POOL, goodNode({ getPool: word('0xabc0000000000000000000000000000000000001') }));
    expect(v.status).toBe('unverified');
    expect(v.reason).toContain('not this pool');
  });

  it('REJECTS when the factory disowns the pair entirely (zero address)', async () => {
    const v = await verifyV3Pool(POOL, goodNode({ getPool: word('0x0') }));
    expect(v.status).toBe('unverified');
  });

  it('REGRESSION: an RPC failure is PENDING, never unverified', async () => {
    // Caching "unverified" from a 429 would permanently disqualify a legitimate
    // pool on the strength of a throttle.
    const flaky: EthCall = async () => ({ ok: false, detail: 'http 429' });
    const v = await verifyV3Pool(POOL, flaky);
    expect(v.status).toBe('pending');
    expect(v.evidence.failure).toContain('429');
  });

  it('short-circuits to pending on a mid-chain failure rather than concluding', async () => {
    // Continuing on partial data risks reading a timeout as a negative.
    const call: EthCall = async (to, data) =>
      data === SEL.factory
        ? { ok: true, result: word(FACTORY) }
        : { ok: false, detail: 'timeout' };
    const v = await verifyV3Pool(POOL, call);
    expect(v.status).toBe('pending');
    expect(v.evidence.failure).toContain('token0()');
  });

  describe('caching', () => {
    it('caches deterministic answers but NEVER a pending one', async () => {
      let calls = 0;
      const failing: EthCall = async () => {
        calls += 1;
        return { ok: false, detail: 'http 429' };
      };
      const v = new PoolVerifier(failing);
      await v.verifyV3(POOL);
      await v.verifyV3(POOL);
      expect(calls).toBeGreaterThan(1); // retried, not concluded
      expect(v.stats()).toMatchObject({ verified: 0, unverified: 0, pending: 1 });
    });

    it('caches a verified pool and exposes it for the classifier', async () => {
      const v = new PoolVerifier(goodNode());
      await v.verifyV3(POOL);
      await v.verifyV3(POOL); // served from cache
      expect(v.stats().verified).toBe(1);
      expect(v.verifiedSet().has(POOL)).toBe(true);
    });

    it('an unverified pool never reaches the verified set', async () => {
      const v = new PoolVerifier(goodNode({ factory: word('0xbad') }));
      await v.verifyV3(POOL);
      expect(v.verifiedSet().size).toBe(0);
      expect(v.stats().unverified).toBe(1);
    });
  });

  describe('uniswap v4', () => {
    const poolId = '0x' + 'ab'.repeat(32);
    const init = (emitter: string): Parameters<typeof verifyV4Pool>[0] => ({
      address: emitter,
      topics: [INIT_TOPIC, poolId, word(WETH), word(PORT)],
      data: AbiCoder.defaultAbiCoder().encode(
        ['uint24', 'int24', 'address', 'uint160', 'int24'],
        [FEE, 200, '0x0000000000000000000000000000000000000000', 1n, 0],
      ),
      blockNumber: 123,
      logIndex: 4,
      transactionHash: '0xtx',
    });

    it('verifies an Initialize emitted BY the trusted PoolManager', () => {
      const v = verifyV4Pool(init(POOL_MANAGER));
      expect(v.status).toBe('verified');
      expect(v.evidence.poolId).toBe(poolId);
      expect(v.evidence.currency0).toBe(WETH);
      expect(v.evidence.currency1).toBe(PORT);
      expect(v.evidence.fee).toBe(FEE);
      expect(v.evidence.tickSpacing).toBe(200);
      // The receipt coordinates that established it.
      expect(v.evidence.blockNumber).toBe(123);
      expect(v.evidence.logIndex).toBe(4);
      expect(v.evidence.txHash).toBe('0xtx');
    });

    it('REJECTS an Initialize-shaped event from an arbitrary emitter', () => {
      // V4 is a singleton — emitter identity IS the verification.
      const v = verifyV4Pool(init('0x9999999999999999999999999999999999999999'));
      expect(v.status).toBe('unverified');
      expect(v.reason).toContain('not the trusted PoolManager');
    });

    it('rejects a malformed Initialize from the right emitter', () => {
      const bad = { ...init(POOL_MANAGER), topics: [INIT_TOPIC] };
      expect(verifyV4Pool(bad).status).toBe('unverified');
    });
  });

  describe('END TO END: the same shape, both directions', () => {
    // One economic shape — wallet gives WETH, receives PORT, pool emits Swap.
    const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
    const OTHER = '0x2222222222222222222222222222222222222222';
    let i = 0;
    const log = (address: string, topic0: string, t1?: string, t2?: string, data = '0x0'): TxLogView => ({
      address,
      topic0,
      topic1: t1 ?? null,
      topic2: t2 ?? null,
      topic3: null,
      data,
      logIndex: i++,
    });
    const shape = (): TxLogView[] => {
      i = 0;
      const amt = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
      return [
        log(WETH, TRANSFER_TOPIC, addressToTopic(WALLET), addressToTopic(POOL), amt),
        log(PORT, TRANSFER_TOPIC, addressToTopic(POOL), addressToTopic(WALLET), amt),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
      ];
    };
    const ctx = (verified: Set<string>) => ({
      txHash: '0xtx',
      logs: shape(),
      wallet: WALLET,
      walletTopic: addressToTopic(WALLET).toLowerCase(),
      txTo: null,
      selector: null,
      nativeValueWei: null,
      receiptStatus: '0x1',
      verifiedContracts: verified,
    });

    it('is UNSUPPORTED without provenance', () => {
      const r = classifyTransaction({ ctx: ctx(new Set()) });
      expect(r.outcome).toBe('unknown_unsupported');
      expect(r.category).toBe('unsupported_protocol');
    });

    it('becomes ELIGIBLE only once real provenance is supplied', async () => {
      // The verified set is produced by the SAME verifier the ingester uses —
      // not hand-written into the fixture.
      const verifier = new PoolVerifier(goodNode());
      const v = await verifier.verifyV3(POOL);
      expect(v.status).toBe('verified');

      const r = classifyTransaction({ ctx: ctx(verifier.verifiedSet()) });
      expect(r.outcome).toBe('confirmed_trade');
      expect(r.category).toBe('swap_v3_router');
    });

    it('a pool that FAILS verification leaves the same shape unsupported', async () => {
      const verifier = new PoolVerifier(goodNode({ factory: word('0xbad') }));
      await verifier.verifyV3(POOL);
      const r = classifyTransaction({ ctx: ctx(verifier.verifiedSet()) });
      expect(r.outcome).toBe('unknown_unsupported');
    });

    it('confirms a well-formed V4 PoolManager Swap only with a demonstrated exchange', () => {
      i = 0;
      const amt = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
      const poolId = '0x' + 'cd'.repeat(32);
      const v4ctx = {
        txHash: '0xv4',
        logs: [
          log(WETH, TRANSFER_TOPIC, addressToTopic(WALLET), addressToTopic(POOL_MANAGER), amt),
          log(PORT, TRANSFER_TOPIC, addressToTopic(POOL_MANAGER), addressToTopic(WALLET), amt),
          // V4 indexes PoolId in topic1 and sender in topic2. Neither is the
          // recipient; wallet attribution comes from the net transfers above.
          log(POOL_MANAGER, V4_SWAP_TOPIC, poolId, addressToTopic(OTHER)),
        ],
        wallet: WALLET,
        walletTopic: addressToTopic(WALLET).toLowerCase(),
        txTo: null,
        selector: null,
        nativeValueWei: null,
        receiptStatus: '0x1',
        verifiedContracts: new Set<string>(),
      };
      const r = classifyTransaction({ ctx: v4ctx });
      expect(r.outcome).toBe('confirmed_trade');
      expect(r.category).toBe('swap_v4_poolmanager');
    });

    it('does not certify a V4-shaped event from another contract or without a PoolId', () => {
      i = 0;
      const amt = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
      const malformed = {
        txHash: '0xbadv4',
        logs: [
          log(WETH, TRANSFER_TOPIC, addressToTopic(WALLET), addressToTopic(OTHER), amt),
          log(PORT, TRANSFER_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET), amt),
          log(OTHER, V4_SWAP_TOPIC, '0x' + 'cd'.repeat(32), addressToTopic(OTHER)),
        ],
        wallet: WALLET,
        walletTopic: addressToTopic(WALLET).toLowerCase(),
        txTo: null,
        selector: null,
        nativeValueWei: null,
        receiptStatus: '0x1',
        verifiedContracts: new Set<string>(),
      };
      const r = classifyTransaction({ ctx: malformed });
      expect(r.outcome).toBe('unknown_unsupported');
      expect(r.category).toBe('unsupported_protocol');
    });
  });
});

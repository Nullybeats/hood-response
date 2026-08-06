import { describe, it, expect } from 'vitest';
import { classifyTransaction } from '../attrib/classifier.js';
import { PoolVerifier, type EthCall } from '../attrib/poolVerify.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC } from '../chain/receipt.js';
import { RETRIABLE_UNKNOWN } from '../attrib/taxonomy.js';
import type { TxLogView } from '../attrib/protocols/types.js';

/**
 * "We have not verified this pool yet" must never become "this pool is not a
 * supported protocol."
 *
 * The old engine turned an absence of evidence into a positive BUY label. The
 * sophisticated version of that same mistake is to turn a 429 into a durable
 * verdict about a contract's identity — the sign is flipped but the error is
 * identical, and it is harder to see because the output looks conservative.
 */

const POOL = '0x2dc56aa90f90a328e0fad9660bf01115bac2d628';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const PORT = '0x14112893f576c12f65b9f0f88e9a9a12723239b5';
const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
const OTHER = '0x2222222222222222222222222222222222222222';

let i = 0;
const log = (address: string, topic0: string, t1?: string, t2?: string, data = '0x0'): TxLogView => ({
  address, topic0, topic1: t1 ?? null, topic2: t2 ?? null, topic3: null, data, logIndex: i++,
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
const ctx = (verified: Set<string>, pending?: Set<string>) => ({
  txHash: '0xtx',
  logs: shape(),
  wallet: WALLET,
  walletTopic: addressToTopic(WALLET).toLowerCase(),
  txTo: null,
  selector: null,
  nativeValueWei: null,
  receiptStatus: '0x1',
  verifiedContracts: verified,
  pendingContracts: pending,
});

describe('verification_pending is not unsupported_protocol', () => {
  it('a THROTTLED pool yields verification_pending, not a verdict', async () => {
    const throttled: EthCall = async () => ({ ok: false, detail: 'http 429' });
    const v = new PoolVerifier(throttled);
    const res = await v.verifyV3(POOL);
    expect(res.status).toBe('pending');

    const r = classifyTransaction({ ctx: ctx(v.verifiedSet(), v.pendingSet()) });
    expect(r.category).toBe('verification_pending');
    expect(r.outcome).toBe('unknown_unsupported');
    expect(RETRIABLE_UNKNOWN.has(r.category)).toBe(true);
  });

  it('a pool that COMPLETED verification and failed is unsupported_protocol', async () => {
    const word = (s: string) => '0x' + s.replace(/^0x/, '').padStart(64, '0');
    const wrongFactory: EthCall = async (_to, data) =>
      data === '0xc45a0155' ? { ok: true, result: word('0xdeadbeef') } : { ok: true, result: '0x' };
    const v = new PoolVerifier(wrongFactory);
    const res = await v.verifyV3(POOL);
    expect(res.status).toBe('unverified'); // a real, settled answer

    const r = classifyTransaction({ ctx: ctx(v.verifiedSet(), v.pendingSet()) });
    expect(r.category).toBe('unsupported_protocol');
    expect(RETRIABLE_UNKNOWN.has(r.category)).toBe(false);
  });

  it('NEGATIVE CONTROL: drop the pending set and the throttle becomes a verdict', async () => {
    // Demonstrates the bug is real and that the pendingContracts set is what
    // prevents it — not some other part of the pipeline.
    const throttled: EthCall = async () => ({ ok: false, detail: 'http 429' });
    const v = new PoolVerifier(throttled);
    await v.verifyV3(POOL);
    const r = classifyTransaction({ ctx: ctx(v.verifiedSet(), undefined) });
    expect(r.category).toBe('unsupported_protocol'); // <- the error being guarded against
  });

  it('once the throttle clears, the same tx confirms as a trade', async () => {
    // The pending verdict must be genuinely transient, not merely differently
    // labelled. Same logs, same wallet, working RPC.
    const word = (s: string) => '0x' + s.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const numWord = (n: number) => '0x' + n.toString(16).padStart(64, '0');
    const FACTORY = (await import('../chain/uniswap.js')).V3_FACTORY.toLowerCase();
    let fail = true;
    const recovering: EthCall = async (to, data) => {
      if (fail) return { ok: false, detail: 'http 429' };
      const t = to.toLowerCase();
      if (t === POOL) {
        if (data === '0xc45a0155') return { ok: true, result: word(FACTORY) };
        if (data === '0x0dfe1681') return { ok: true, result: word(WETH) };
        if (data === '0xd21220a7') return { ok: true, result: word(PORT) };
        if (data === '0xddca3f43') return { ok: true, result: numWord(10000) };
      }
      if (t === FACTORY) return { ok: true, result: word(POOL) };
      return { ok: true, result: '0x' };
    };
    const v = new PoolVerifier(recovering);

    await v.verifyV3(POOL);
    expect(classifyTransaction({ ctx: ctx(v.verifiedSet(), v.pendingSet()) }).category).toBe(
      'verification_pending',
    );

    fail = false;
    await v.verifyV3(POOL); // retried, because pending was never cached
    const r = classifyTransaction({ ctx: ctx(v.verifiedSet(), v.pendingSet()) });
    expect(r.outcome).toBe('confirmed_trade');
    expect(r.category).toBe('swap_v3_router');
    expect(v.pendingSet().size).toBe(0);
  });
});

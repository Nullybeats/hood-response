import { describe, it, expect } from 'vitest';
import { id } from 'ethers';
import { classifyCandidate, emptyTally } from '../chain/classify.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../chain/receipt.js';

const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
const OTHER = '0x2222222222222222222222222222222222222222';
const w = addressToTopic(WALLET).toLowerCase();
const o = addressToTopic(OTHER).toLowerCase();

const INCREASE_LIQUIDITY = id('IncreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const V4_MODIFY_LIQUIDITY = id(
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
).toLowerCase();

/** Transfer log helper: from -> to. */
const xfer = (from: string, to: string) => ({ topic0: TRANSFER_TOPIC, topic1: from, topic2: to });

describe('shadow classification — what a tracked transfer actually was', () => {
  it('a V3/V4 Swap in the same tx is swap-COOCCURRENCE, not proof of purchase', () => {
    const cls = classifyCandidate({
      txLogs: [xfer(o, w), { topic0: V3_SWAP_TOPIC }],
      walletTopic: w,
      incoming: true,
    });
    // The name is the point: a multi-call tx can contain a swap AND a transfer
    // to our wallet without the wallet having been the trader.
    expect(cls).toBe('swap-cooccurrence');
    expect(
      classifyCandidate({ txLogs: [xfer(o, w), { topic0: V4_SWAP_TOPIC }], walletTopic: w, incoming: true }),
    ).toBe('swap-cooccurrence');
  });

  it('REGRESSION: an LP add is liquidity, even though a Swap rides along', () => {
    // This is the real tx 0xeab0a2c9… shape: a position-manager action. A
    // single-sided/zap add swaps half the input first, so a Swap event IS
    // present — classifying on the swap alone would count the exact false
    // positive this exists to find. Liquidity is therefore checked FIRST.
    const cls = classifyCandidate({
      txLogs: [xfer(o, w), { topic0: V3_SWAP_TOPIC }, { topic0: INCREASE_LIQUIDITY }],
      walletTopic: w,
      incoming: true,
    });
    expect(cls).toBe('liquidity');
  });

  it('classifies a Uniswap V4 liquidity modification as liquidity', () => {
    expect(
      classifyCandidate({ txLogs: [xfer(o, w), { topic0: V4_MODIFY_LIQUIDITY }], walletTopic: w, incoming: true }),
    ).toBe('liquidity');
  });

  it('tokens in, nothing out, no DEX event = airdrop', () => {
    expect(classifyCandidate({ txLogs: [xfer(o, w)], walletTopic: w, incoming: true })).toBe(
      'airdrop',
    );
  });

  it('tokens in AND out with no DEX event = plain transfer, not an airdrop', () => {
    // The wallet gave something up, so it was not free — but no pool was
    // touched, so it is not a swap either (OTC, bridge, contract settlement).
    const cls = classifyCandidate({
      txLogs: [xfer(o, w), xfer(w, o)],
      walletTopic: w,
      incoming: true,
    });
    expect(cls).toBe('plain-transfer');
  });

  it('an outgoing transfer with no DEX event is a plain transfer, never an airdrop', () => {
    expect(classifyCandidate({ txLogs: [xfer(w, o)], walletTopic: w, incoming: false })).toBe(
      'plain-transfer',
    );
  });

  it('is case-insensitive about topics (sources differ in casing)', () => {
    const cls = classifyCandidate({
      txLogs: [xfer(o, w), { topic0: V3_SWAP_TOPIC.toUpperCase() }],
      walletTopic: w.toUpperCase(),
      incoming: true,
    });
    expect(cls).toBe('swap-cooccurrence');
  });

  it('tolerates an empty tx-log set rather than throwing', () => {
    // A context query that failed or truncated leaves no logs; the shadow must
    // degrade to a label, not crash the tick.
    expect(classifyCandidate({ txLogs: [], walletTopic: w, incoming: true })).toBe('airdrop');
    expect(classifyCandidate({ txLogs: [], walletTopic: w, incoming: false })).toBe(
      'plain-transfer',
    );
  });

  it('emptyTally covers every class exactly once', () => {
    expect(Object.keys(emptyTally()).sort()).toEqual(
      ['airdrop', 'liquidity', 'plain-transfer', 'swap-cooccurrence'].sort(),
    );
    expect(Object.values(emptyTally()).every((v) => v === 0)).toBe(true);
  });
});

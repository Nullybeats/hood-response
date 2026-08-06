import { describe, expect, it } from 'vitest';
import { id } from 'ethers';
import { verifiedTransferVerdict } from '../chain/liveTradeVerifier.js';
import { addressToTopic, TRANSFER_TOPIC, type DecodedTransfer } from '../chain/decoder.js';
import { V4_SWAP_TOPIC } from '../chain/receipt.js';
import { POOL_MANAGER } from '../chain/uniswap.js';
import type { TxContext, TxLogView } from '../attrib/protocols/types.js';

const WALLET = '0x5638484ba2d2f1d1d35020572b0aa439a9869192';
const FORK = '0x404a032297205d437dbafb39dab82474f18b95f0';
const FORK_ENTRY = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const OTHER = '0x1111111111111111111111111111111111111111';
const POOL_ID = '0x' + 'ab'.repeat(32);
const V4_MODIFY = id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)').toLowerCase();
const amount = 29_408_549_381_646_424_603_242_304n;
const INTERMEDIATE = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ROUTER = '0x8f10b468b06c6fd214b65f87778827f7d113f996';

const transfer: DecodedTransfer = {
  token: FORK, from: POOL_MANAGER, to: WALLET, rawValue: amount,
  txHash: '0x81b3d8adb1e31e51bf581ee5d1fcfd799213b1b59498f5b88597165b8c6d762f',
  blockNumber: 28_905_476, logIndex: 1,
};

function xfer(): TxLogView {
  return {
    address: FORK, topic0: TRANSFER_TOPIC, topic1: addressToTopic(POOL_MANAGER), topic2: addressToTopic(WALLET),
    topic3: null, data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 1,
  };
}

function ctx(logs: TxLogView[], over: Partial<TxContext> = {}): TxContext {
  return {
    txHash: transfer.txHash, logs, wallet: WALLET, walletTopic: addressToTopic(WALLET),
    txTo: FORK_ENTRY, selector: '0x12345678', nativeValueWei: '500000000000000000', receiptStatus: '0x1',
    verifiedContracts: new Set([FORK_ENTRY]), ...over,
  };
}

describe('live V3/V4 verified-trade gate', () => {
  it('keeps the observed FORK 0.5 ETH → FORK V4 route as a confirmed buy when its entry is audited', () => {
    const verdict = verifiedTransferVerdict(ctx([
      xfer(),
      { address: POOL_MANAGER, topic0: V4_SWAP_TOPIC, topic1: POOL_ID, topic2: addressToTopic(FORK_ENTRY), topic3: null, data: '0x', logIndex: 2 },
    ]), transfer, 'BUY', true);
    expect(verdict.legacyCandidate).toBe(true);
    expect(verdict.confirmed).toBe(true);
    expect(verdict.category).toBe('swap_v4_poolmanager');
  });

  it('fails closed when the trigger transfer does not agree with the wallet net exchange', () => {
    const verdict = verifiedTransferVerdict(ctx([
      // Net zero for FORK: a transfer receipt can show an incoming leg that is
      // later sent out in the same transaction, which is not a buy signal.
      xfer(),
      { address: FORK, topic0: TRANSFER_TOPIC, topic1: addressToTopic(WALLET), topic2: addressToTopic(OTHER), topic3: null, data: `0x${amount.toString(16).padStart(64, '0')}`, logIndex: 2 },
      { address: POOL_MANAGER, topic0: V4_SWAP_TOPIC, topic1: POOL_ID, topic2: addressToTopic(FORK_ENTRY), topic3: null, data: '0x', logIndex: 3 },
    ]), transfer, 'BUY', true);
    expect(verdict.legacyCandidate).toBe(true);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.category).toBe('trigger_direction_not_net_exchange');
  });

  it('does not turn a V4 liquidity action into a trade', () => {
    const verdict = verifiedTransferVerdict(ctx([
      xfer(),
      { address: POOL_MANAGER, topic0: V4_MODIFY, topic1: POOL_ID, topic2: addressToTopic(WALLET), topic3: null, data: '0x' + '0'.repeat(64 * 4), logIndex: 2 },
    ]), transfer, 'BUY', true);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.category).toBe('no_successful_swap_receipt');
  });

  it('suppresses the observed two-hop V4 route when a third party paid and the watched wallet only received output', () => {
    // tx 0x228c…699e1: two real V4 swaps occur, but the watched wallet only
    // receives the final token. The input comes from unrelated contracts and
    // the trace contains no native debit from the watched wallet. A nearby swap
    // is not evidence that this wallet bought the output.
    const output = { ...transfer, rawValue: 123n };
    const verdict = verifiedTransferVerdict(ctx([
      { address: INTERMEDIATE, topic0: TRANSFER_TOPIC, topic1: addressToTopic(OTHER), topic2: addressToTopic(ROUTER), topic3: null, data: '0x7b', logIndex: 1 },
      { address: POOL_MANAGER, topic0: V4_SWAP_TOPIC, topic1: POOL_ID, topic2: addressToTopic(ROUTER), topic3: null, data: '0x', logIndex: 2 },
      { address: FORK, topic0: TRANSFER_TOPIC, topic1: addressToTopic(ROUTER), topic2: addressToTopic(WALLET), topic3: null, data: '0x7b', logIndex: 3 },
      { address: POOL_MANAGER, topic0: V4_SWAP_TOPIC, topic1: '0x' + 'cd'.repeat(32), topic2: addressToTopic(ROUTER), topic3: null, data: '0x', logIndex: 4 },
    ], { nativeValueWei: '0', txTo: ROUTER, verifiedContracts: new Set() }), output, 'BUY', true);
    expect(verdict.legacyCandidate).toBe(true);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.category).toBe('insufficient_trace_data');
  });
});

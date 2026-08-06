import { describe, it, expect } from 'vitest';
import { id } from 'ethers';
import { classifyTransaction, walletDeltas } from '../attrib/classifier.js';
import { OUTCOME_OF, type Category } from '../attrib/taxonomy.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../chain/receipt.js';
import { POOL_MANAGER } from '../chain/uniswap.js';
import { TRANSFER_WITH_SCALED_UI } from '../attrib/protocols/index.js';
import type { TxContext, TxLogView } from '../attrib/protocols/types.js';

const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const V4_POOL_ID = '0x' + 'ab'.repeat(32);

const NPM = '0x58daec3116aae6d93017baaea7749052e8a04fa7'; // POSITION_MANAGER
const NATIVE = '0x0000000000000000000000000000000000000000';
const V3_BURN = id('Burn(address,int24,int24,uint128,uint256,uint256)').toLowerCase();
const NPM_INCREASE = id('IncreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const NPM_COLLECT = id('Collect(uint256,address,uint256,uint256)').toLowerCase();
const WETH_DEPOSIT = id('Deposit(address,uint256)').toLowerCase();

let idx = 0;
const hex = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

function log(address: string, topic0: string, t1?: string, t2?: string, data = '0x0'): TxLogView {
  return {
    address,
    topic0,
    topic1: t1 ?? null,
    topic2: t2 ?? null,
    topic3: null,
    data,
    logIndex: idx++,
  };
}
const xfer = (token: string, from: string, to: string, amt: bigint) =>
  log(token, TRANSFER_TOPIC, addressToTopic(from), addressToTopic(to), hex(amt));

/**
 * By default the pool and WETH are VERIFIED emitters — a topic hash alone is
 * never enough, so a fixture that does not establish identity would (correctly)
 * classify as `unsupported_protocol`. Tests that want the unverified path pass
 * `verifiedContracts: new Set()` explicitly.
 */
function ctx(logs: TxLogView[], over: Partial<TxContext> = {}): TxContext {
  idx = 0;
  return {
    txHash: '0xtx',
    logs,
    wallet: WALLET,
    walletTopic: addressToTopic(WALLET).toLowerCase(),
    txTo: null,
    selector: null,
    nativeValueWei: null,
    receiptStatus: '0x1',
    verifiedContracts: new Set([POOL, WETH, NPM]),
    ...over,
  };
}

describe('attribution classifier — a trade requires a demonstrated exchange', () => {
  it('confirms a V3 swap when the wallet gave one asset and received another', () => {
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 5000n * 10n ** 18n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
      ]),
    });
    expect(r.outcome).toBe('confirmed_trade');
    expect(r.category).toBe('swap_v3_router');
    expect(r.evidence.deltas).toHaveLength(2);
  });

  it('confirms a V4 swap on wallet deltas, NOT on the router being the sender', () => {
    // V4 topic1 is the PoolId; topic2 is the router/sender.  If we trusted that
    // sender as beneficiary we would credit the router, not the user — the
    // demonstrated wallet deltas are the only honest source.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 42n * 10n ** 18n),
        log(POOL_MANAGER, V4_SWAP_TOPIC, V4_POOL_ID, addressToTopic(OTHER)),
      ]),
    });
    expect(r.category).toBe('swap_v4_poolmanager');
  });

  it('REGRESSION: a zap (liquidity + swap) is neither a trade nor a non-trade', () => {
    // chain/receipt.ts:45 emits this as a wallet BUY today, because it requires
    // only the transfer plus *some* Swap. But calling it a plain non-trade would
    // be equally wrong — a zap or rebalance really does swap. It is genuinely
    // unresolved, so it is recorded as unresolved and suppressed for alerts
    // rather than forced into either bucket.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 100n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
        log(NPM, NPM_INCREASE, addressToTopic(WALLET)),
      ]),
    });
    expect(r.outcome).toBe('unknown_unsupported');
    expect(r.category).toBe('mixed_or_ambiguous_activity');
  });

  it('classifies an LP withdrawal (V3 Burn) as liquidity_remove, not a sell', () => {
    // The real shape of tx 0xeab0a2c9…, which the old engine counted as a trade.
    const r = classifyTransaction({
      ctx: ctx([
        log(POOL, V3_BURN, addressToTopic(WALLET)),
        xfer(TOKEN, POOL, WALLET, 900n),
      ]),
    });
    expect(r.category).toBe('liquidity_remove');
  });

  it('classifies fee collection as a non-trade', () => {
    const r = classifyTransaction({
      ctx: ctx([log(NPM, NPM_COLLECT, addressToTopic(WALLET)), xfer(TOKEN, POOL, WALLET, 5n)]),
    });
    expect(r.category).toBe('fee_collection');
  });

  it('REGRESSION: an incoming transfer with no counter-leg is an airdrop, not a BUY', () => {
    // The single largest false-positive class in the old engine: 286 airdrops
    // labelled BUY in one shadow window.
    const r = classifyTransaction({ ctx: ctx([xfer(TOKEN, OTHER, WALLET, 1000n)]) });
    expect(r.outcome).toBe('confirmed_non_trade');
    expect(r.category).toBe('airdrop_receive');
  });

  it('REGRESSION: an outgoing plain transfer is not a SELL', () => {
    const r = classifyTransaction({ ctx: ctx([xfer(TOKEN, WALLET, OTHER, 1000n)]) });
    expect(r.category).toBe('plain_transfer');
    expect(r.outcome).toBe('confirmed_non_trade');
  });

  it('a swap with no wallet movement is ambiguous_multiparty, never a trade', () => {
    // A router settling for someone else. "Destination is a router" must never
    // become "this wallet traded".
    const r = classifyTransaction({
      ctx: ctx([xfer(TOKEN, OTHER, POOL, 5n), log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER))]),
    });
    expect(r.outcome).toBe('unknown_unsupported');
    expect(r.category).toBe('ambiguous_multiparty');
  });

  it('one visible leg plus an unprovable native leg is insufficient_trace_data', () => {
    // Receipts cannot show native value moving through internal calls, so the
    // counter-leg may exist and be invisible. Refuse to decide either way.
    const r = classifyTransaction({
      ctx: ctx([xfer(TOKEN, POOL, WALLET, 900n), log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER))]),
    });
    expect(r.category).toBe('insufficient_trace_data');
    expect(r.outcome).toBe('unknown_unsupported');
  });

  it('accepts one leg when a WETH wrap proves the native side', () => {
    const r = classifyTransaction({
      ctx: ctx([
        log(WETH, WETH_DEPOSIT, addressToTopic(WALLET)),
        xfer(TOKEN, POOL, WALLET, 900n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER)),
      ]),
    });
    expect(r.outcome).toBe('confirmed_trade');
  });

  it('accepts one token leg when a TRACE proves the native payment', () => {
    // A user paying native ETH through internal calls leaves no Transfer and no
    // WETH Deposit. Only a trace can show it. `trace_native` is positive proof.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(TOKEN, POOL, WALLET, 900n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
      ]),
      extraDeltas: [
        { token: NATIVE, rawDelta: '-1000000000000000000', decimals: 18, source: 'trace_native' },
      ],
    });
    expect(r.outcome).toBe('confirmed_trade');
    expect(r.category).toBe('swap_v3_router');
  });

  it('an UNREADABLE trace is the absence of proof, not proof', () => {
    // `insufficient_trace_data` is the opposite of `trace_native`. An earlier
    // revision read the failure marker as evidence, which would have confirmed
    // trades on data we explicitly could not read.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(TOKEN, POOL, WALLET, 900n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
      ]),
      extraDeltas: [
        { token: NATIVE, rawDelta: '0', decimals: 18, source: 'insufficient_trace_data' },
      ],
    });
    expect(r.outcome).toBe('unknown_unsupported');
    expect(r.category).toBe('insufficient_trace_data');
    expect(r.evidence.note).toContain('could not be read');
  });

  it('a zero-value trace-native delta does not prove a payment', () => {
    const r = classifyTransaction({
      ctx: ctx([
        xfer(TOKEN, POOL, WALLET, 900n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
      ]),
      extraDeltas: [{ token: NATIVE, rawDelta: '0', decimals: 18, source: 'trace_native' }],
    });
    expect(r.category).toBe('insufficient_trace_data');
  });

  it('MIXED protocol actions are suppressed, not resolved', () => {
    // Documented limitation, asserted so it cannot be quietly overclaimed later:
    // net flow alone cannot separate a zap's swap leg from its liquidity leg.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 100n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
        log(NPM, NPM_INCREASE, addressToTopic(WALLET)),
      ]),
    });
    expect(r.category).toBe('mixed_or_ambiguous_activity');
    expect(r.evidence.note).toContain('not decomposed');
  });

  it('a reverted transaction is never a trade', () => {
    const r = classifyTransaction({
      ctx: ctx(
        [
          xfer(WETH, WALLET, POOL, 10n ** 18n),
          xfer(TOKEN, POOL, WALLET, 5n),
          log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
        ],
        { receiptStatus: '0x0' },
      ),
    });
    expect(r.category).toBe('failed_tx');
  });

  it('an unrecognised event blocks a plain-transfer label', () => {
    // Whatever we cannot name stays unknown rather than being laundered into a
    // confident non-trade. This is the 0xe193e7c3… case (180 events, unverified
    // contract, no ABI).
    const unknownSig = '0xe193e7c37810b51d21311419e54f4e77545d28aaaf66c45907900bbceac47ae2';
    const r = classifyTransaction({
      ctx: ctx([xfer(TOKEN, WALLET, OTHER, 5n), log(OTHER, unknownSig)]),
    });
    expect(r.outcome).toBe('unknown_unsupported');
    expect(r.category).toBe('unknown_topic');
  });

  it('recognises the tokenized-equity scaled-UI mirror as a non-trade', () => {
    const r = classifyTransaction({
      ctx: ctx([
        xfer(TOKEN, OTHER, WALLET, 5n),
        xfer(TOKEN, WALLET, OTHER, 5n),
        log(TOKEN, TRANSFER_WITH_SCALED_UI, addressToTopic(OTHER), addressToTopic(WALLET)),
      ]),
    });
    expect(r.outcome).toBe('confirmed_non_trade');
  });

  it('ignores ERC-721 Transfers when computing balances', () => {
    // A 4-topic Transfer carries a tokenId, not an amount. Counting it as a
    // balance would fabricate an enormous delta out of an LP position NFT.
    const nft: TxLogView = {
      address: TOKEN,
      topic0: TRANSFER_TOPIC,
      topic1: addressToTopic(OTHER),
      topic2: addressToTopic(WALLET),
      topic3: hex(12345n),
      data: '0x',
      logIndex: 0,
    };
    expect(walletDeltas(ctx([nft]))).toHaveLength(0);
  });

  it('every category maps to exactly one outcome', () => {
    for (const [cat, outcome] of Object.entries(OUTCOME_OF)) {
      expect(outcome).toBeTruthy();
      expect(OUTCOME_OF[cat as Category]).toBe(outcome);
    }
  });

  it('NO SILENT DROPS: every input yields exactly one outcome', () => {
    // The accounted-for invariant at the classifier level. Fuzz a range of
    // shapes; none may return undefined or throw.
    const shapes: TxLogView[][] = [
      [],
      [xfer(TOKEN, OTHER, WALLET, 1n)],
      [xfer(TOKEN, WALLET, OTHER, 1n)],
      [log(POOL, V3_SWAP_TOPIC)],
      [log(POOL, V4_SWAP_TOPIC)],
      [log(POOL, V3_BURN, addressToTopic(WALLET))],
      [log(OTHER, '0xdeadbeef')],
      [{ address: TOKEN, topic0: null, topic1: null, topic2: null, topic3: null, data: null, logIndex: 0 }],
      [xfer(TOKEN, OTHER, WALLET, 0n)],
    ];
    for (const logs of shapes) {
      const r = classifyTransaction({ ctx: ctx(logs) });
      expect(r.outcome).toBeTruthy();
      expect(OUTCOME_OF[r.category]).toBe(r.outcome);
      expect(r.classifierVersion).toBeGreaterThan(0);
    }
  });
});

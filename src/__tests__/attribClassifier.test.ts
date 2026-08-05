import { describe, it, expect } from 'vitest';
import { id } from 'ethers';
import { classifyTransaction, walletDeltas } from '../attrib/classifier.js';
import { OUTCOME_OF, type Category } from '../attrib/taxonomy.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../chain/receipt.js';
import { TRANSFER_WITH_SCALED_UI } from '../attrib/protocols/index.js';
import type { TxContext, TxLogView } from '../attrib/protocols/types.js';

const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

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
    // V4's Swap sender is the router. If we trusted that as beneficiary we would
    // credit the router, not the user — the deltas are the only honest source.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 42n * 10n ** 18n),
        log(POOL, V4_SWAP_TOPIC, addressToTopic(OTHER)),
      ]),
    });
    expect(r.category).toBe('swap_v4_poolmanager');
  });

  it('REGRESSION: a zap liquidity-add that emits a Swap is NOT a trade', () => {
    // This is the live defect in chain/receipt.ts:45 — it requires only that the
    // tx contain the transfer and *some* Swap, so this exact shape is emitted as
    // a wallet BUY today. Liquidity is checked first here precisely to stop it.
    const r = classifyTransaction({
      ctx: ctx([
        xfer(WETH, WALLET, POOL, 10n ** 18n),
        xfer(TOKEN, POOL, WALLET, 100n),
        log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
        log(POOL, NPM_INCREASE, addressToTopic(WALLET)),
      ]),
    });
    expect(r.outcome).toBe('confirmed_non_trade');
    expect(r.category).toBe('liquidity_add');
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
      ctx: ctx([log(POOL, NPM_COLLECT, addressToTopic(WALLET)), xfer(TOKEN, POOL, WALLET, 5n)]),
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

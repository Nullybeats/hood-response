import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbiCoder, zeroPadValue } from 'ethers';
import { V4PoolRegistry } from '../attrib/v4Registry.js';
import type { AttributionLedger, V4PoolInitialization } from '../attrib/ledger.js';
import { INIT_TOPIC, POOL_MANAGER } from '../chain/uniswap.js';
import { resetSchedulers } from '../attrib/scheduler.js';

const ID = '0x' + 'ab'.repeat(32);
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

afterEach(() => { vi.unstubAllGlobals(); resetSchedulers(); });

describe('durable V4 PoolId registry', () => {
  it('fetches the canonical Initialize proof once and proves token membership', async () => {
    let stored: V4PoolInitialization | null = null;
    const ledger = {
      v4PoolInitialization: vi.fn(() => stored),
      recordV4Initialization: vi.fn((init: { poolId: string; blockNumber: number; logIndex: number; txHash: string | null; evidence: Record<string, unknown> }) => {
        stored = {
          poolId: init.poolId, currency0: String(init.evidence.currency0), currency1: String(init.evidence.currency1),
          fee: Number(init.evidence.fee), tickSpacing: Number(init.evidence.tickSpacing), hooks: String(init.evidence.hooks),
          blockNumber: init.blockNumber, logIndex: init.logIndex, txHash: init.txHash,
        };
      }),
    } as unknown as AttributionLedger;
    const log = {
      address: POOL_MANAGER,
      topics: [INIT_TOPIC, ID, zeroPadValue(TOKEN, 32), zeroPadValue(OTHER, 32)],
      data: AbiCoder.defaultAbiCoder().encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, OTHER, 1n, 0]),
      blockNumber: '0x10', logIndex: '0x2', transactionHash: '0xinit',
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [log] })));
    vi.stubGlobal('fetch', fetch);
    const registry = new V4PoolRegistry(ledger, 'https://rpc.test');

    expect(await registry.containsToken(ID, TOKEN)).toBe('verified');
    expect(await registry.containsToken(ID, OTHER)).toBe('verified');
    expect(await registry.containsToken(ID, '0x3333333333333333333333333333333333333333')).toBe('mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ledger.recordV4Initialization).toHaveBeenCalledOnce();
  });

  it('keeps an unavailable Initialize lookup pending instead of calling it a mismatch', async () => {
    const ledger = { v4PoolInitialization: () => null, recordV4Initialization: vi.fn() } as unknown as AttributionLedger;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] })));
    expect(await new V4PoolRegistry(ledger, 'https://rpc.test').containsToken(ID, TOKEN)).toBe('pending');
  });
});

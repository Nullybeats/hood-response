import { verifyV4Pool } from './poolVerify.js';
import type { AttributionLedger } from './ledger.js';
import { INIT_TOPIC, POOL_MANAGER } from '../chain/uniswap.js';
import { logHttpFailure, logRpcError, logRpcThrow } from '../chain/rpcLog.js';
import { schedulerFor } from './scheduler.js';

export type V4PoolMembership = 'verified' | 'mismatch' | 'pending';

type RawLog = { address?: string; topics?: string[]; data?: string; blockNumber?: string; logIndex?: string; transactionHash?: string };
const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const num = (s: string | undefined): number => {
  try { return s ? Number(BigInt(s)) : -1; } catch { return -1; }
};

/**
 * Durable, on-demand V4 PoolId registry.
 *
 * PoolId is a hash of PoolKey, so a Swap event cannot tell us its currencies.
 * When a PoolId is first seen, fetch its canonical indexed Initialize log from
 * the trusted PoolManager, persist the complete key in the attribution ledger,
 * and use that immutable proof for all later decisions. A failed lookup is
 * `pending`, never a negative conclusion.
 */
export class V4PoolRegistry {
  private readonly inflight = new Map<string, Promise<V4PoolMembership>>();

  constructor(
    private readonly ledger: AttributionLedger,
    private readonly rpcUrl: string,
    private readonly manager = POOL_MANAGER,
  ) {}

  async containsToken(poolId: string, token: string): Promise<V4PoolMembership> {
    const id = lc(poolId);
    const target = lc(token);
    const known = this.ledger.v4PoolInitialization(id);
    if (known) return known.currency0 === target || known.currency1 === target ? 'verified' : 'mismatch';
    const flight = this.inflight.get(id);
    if (flight) return flight;
    const run = this.fetchAndStore(id, target);
    this.inflight.set(id, run);
    try { return await run; } finally { this.inflight.delete(id); }
  }

  private async fetchAndStore(poolId: string, token: string): Promise<V4PoolMembership> {
    const logs = await this.rpc<RawLog[]>('eth_getLogs', [{
      address: this.manager,
      fromBlock: '0x0', toBlock: 'latest',
      topics: [INIT_TOPIC, poolId],
    }]);
    if (!Array.isArray(logs) || logs.length !== 1) return 'pending';
    const log = logs[0]!;
    const v = verifyV4Pool({
      address: lc(log.address), topics: (log.topics ?? []).map(lc), data: log.data ?? '0x',
      blockNumber: num(log.blockNumber), logIndex: num(log.logIndex), transactionHash: log.transactionHash,
    }, this.manager);
    if (v.status !== 'verified' || !v.evidence.poolId || !v.evidence.currency0 || !v.evidence.currency1) return 'pending';
    this.ledger.recordV4Initialization({
      poolId: v.evidence.poolId, blockNumber: v.evidence.blockNumber ?? -1,
      logIndex: v.evidence.logIndex ?? -1, txHash: v.evidence.txHash ?? null, evidence: v.evidence,
    });
    return lc(v.evidence.currency0) === token || lc(v.evidence.currency1) === token ? 'verified' : 'mismatch';
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    if (!this.rpcUrl) return null;
    const sched = schedulerFor(this.rpcUrl);
    try {
      return await sched.run(async () => {
        const res = await fetch(this.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000),
        });
        const ctx = { op: 'v4-pool-registry', url: this.rpcUrl, method };
        if (!res.ok) {
          logHttpFailure(ctx, res.status, res.statusText);
          if (res.status === 429 || res.status === 503) sched.penalise(1_000);
          return null;
        }
        const body = await res.json() as { result?: T; error?: unknown };
        if (body.error) { logRpcError(ctx, body.error); return null; }
        return body.result ?? null;
      }, 'normal');
    } catch (err) {
      logRpcThrow({ op: 'v4-pool-registry', url: this.rpcUrl, method }, err);
      return null;
    }
  }
}

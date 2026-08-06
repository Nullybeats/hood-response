import { AbiCoder } from 'ethers';
import { logger } from '../logger.js';
import { logHttpFailure, logRpcThrow, redact, rpcHost } from '../chain/rpcLog.js';
import { INIT_TOPIC, POOL_MANAGER, V3_FACTORY } from '../chain/uniswap.js';
import { schedulerFor } from './scheduler.js';

/**
 * Pool verification: establishing CONTRACT IDENTITY, not obtaining a response.
 *
 * The failure this exists to prevent is subtle and cheap to make: a contract
 * that answers `factory()`, emits `Swap(...)`, or returns a non-zero address is
 * not thereby a Uniswap pool. Anyone can deploy one. Treating a successful call
 * as proof would let a spoofed pool mint `confirmed_trade` verdicts, and those
 * verdicts are what a sniper acts on.
 *
 * So verification is a CLOSED LOOP anchored at a trusted, configured address:
 *
 *   V3  trusted factory (chain/uniswap.ts)
 *       -> pool.factory() MUST equal it
 *       -> pool.token0(), token1(), fee()
 *       -> factory.getPool(token0, token1, fee) MUST equal the pool
 *
 * The round-trip is the part that matters. `pool.factory()` alone is a claim the
 * pool makes about itself; `getPool` is the TRUSTED factory independently
 * naming that same address. Both must agree.
 *
 *   V4  trusted PoolManager (singleton)
 *       -> an Initialize event EMITTED BY that manager
 *       -> poolId, currency0, currency1, fee, tickSpacing, hooks decoded from it
 *       -> with the block and log index that established it
 *
 * VERIFIED on chain 4663, 2026-08-05: pool 0x2dc56aa9… reports factory
 * 0x1f7d7550… (the configured one), token0/token1 WETH/Port, fee 10000, and
 * factory.getPool round-trips to the same address.
 *
 * A NEGATIVE IS NOT A FAILURE. An identity mismatch is a real, deterministic
 * answer and is cached. An RPC failure or rate limit is NOT — it leaves the pool
 * `pending` with the failure recorded, because caching "unverified" from a 429
 * would permanently disqualify a legitimate pool on the strength of a throttle.
 */

export type VerificationStatus =
  /** Identity closed the loop against a trusted anchor. */
  | 'verified'
  /** A definite, deterministic NO — wrong factory, or the round-trip disagreed. */
  | 'unverified'
  /** We could not find out. Never cached; always retried. */
  | 'pending';

export interface RpcEvidence {
  method: string;
  to: string;
  /** Call selector + args, so the proof can be re-run by hand. */
  data: string;
  result: string | null;
  ok: boolean;
}

export interface PoolVerification {
  pool: string;
  protocol: 'uniswap-v3' | 'uniswap-v4';
  status: VerificationStatus;
  reason: string;
  /** Everything the conclusion rests on, persisted so it can be audited. */
  evidence: {
    trustedAnchor: string;
    rpcCalls?: RpcEvidence[];
    /** V3 */
    claimedFactory?: string | null;
    token0?: string | null;
    token1?: string | null;
    fee?: number | null;
    roundTripPool?: string | null;
    /** V4 */
    poolId?: string | null;
    currency0?: string | null;
    currency1?: string | null;
    tickSpacing?: number | null;
    hooks?: string | null;
    blockNumber?: number | null;
    logIndex?: number | null;
    emitter?: string | null;
    txHash?: string | null;
    /** Present only when status is `pending`. */
    failure?: string;
  };
  checkedAt: number;
}

const SEL = {
  factory: '0xc45a0155',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  getPool: '0x1698ee82',
};

const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const pad = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const padNum = (n: number): string => n.toString(16).padStart(64, '0');
const toAddr = (hex: string | null): string | null =>
  hex && hex !== '0x' && hex.length >= 42 ? `0x${hex.slice(-40)}`.toLowerCase() : null;
const toNum = (hex: string | null): number | null => {
  if (!hex || hex === '0x') return null;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
};

const ZERO = '0x0000000000000000000000000000000000000000';

type CallResult = { ok: true; result: string | null } | { ok: false; detail: string };

export type EthCall = (to: string, data: string) => Promise<CallResult>;

/**
 * Default transport. Any non-2xx, JSON-RPC error or throw is a FAILURE, never
 * a negative answer — the distinction decides whether we cache.
 *
 * Runs under the SHARED per-host scheduler, the same one receipts and
 * transaction context use. Pool verification with its own limiter would simply
 * add its burst on top of theirs; the host counts the total either way.
 */
export function makeEthCall(rpcUrl: string): EthCall {
  const sched = schedulerFor(rpcUrl);
  return async (to, data) =>
    sched.run(async () => {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logHttpFailure({ op: 'pool-verify', url: rpcUrl, method: 'eth_call' }, res.status, res.statusText);
        // Slow EVERY caller on this host, not just this one. A limiter that
        // only penalises the rejected request leaves the aggregate rate exactly
        // where it was — which is what earned the 429.
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get('retry-after'));
          sched.penalise(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000);
        }
        return { ok: false, detail: `http ${res.status}` };
      }
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (body.error) return { ok: false, detail: redact(String(body.error.message)).slice(0, 120) };
      return { ok: true, result: body.result ?? null };
    } catch (err) {
      logRpcThrow({ op: 'pool-verify', url: rpcUrl, method: 'eth_call' }, err);
      return { ok: false, detail: redact(String(err)).slice(0, 120) };
    }
    }, 'background');
}

/**
 * Verify a Uniswap V3 pool by closing the loop against the trusted factory.
 *
 * Note the ordering: any RPC failure short-circuits to `pending` immediately.
 * Continuing on partial data risks concluding "unverified" from a call that
 * merely timed out.
 */
export async function verifyV3Pool(
  pool: string,
  call: EthCall,
  trustedFactory = V3_FACTORY,
): Promise<PoolVerification> {
  const p = lc(pool);
  const anchor = lc(trustedFactory);
  const rpcCalls: RpcEvidence[] = [];
  const base = { pool: p, protocol: 'uniswap-v3' as const, checkedAt: Date.now() };

  // Why a call failed matters as much as which one: a 429 is retriable soon, a
  // transport error may need a different source. Both go into the record.
  let lastFailure = '';
  const step = async (to: string, data: string, method: string): Promise<string | null | false> => {
    const r = await call(to, data);
    rpcCalls.push({ method, to, data, result: r.ok ? r.result : null, ok: r.ok });
    if (!r.ok) lastFailure = r.detail;
    return r.ok ? r.result : false;
  };
  const pending = (which: string): PoolVerification => ({
    ...base,
    status: 'pending',
    reason: 'could not establish identity — retry, do not conclude',
    evidence: {
      trustedAnchor: anchor,
      rpcCalls,
      failure: lastFailure ? `${which}: ${lastFailure}` : which,
    },
  });

  const facHex = await step(p, SEL.factory, 'factory()');
  if (facHex === false) return pending('factory() call failed');
  const claimedFactory = toAddr(facHex);

  // A pool claiming an UNTRUSTED factory is a definite no, whatever else it says.
  if (!claimedFactory || claimedFactory !== anchor) {
    return {
      ...base,
      status: 'unverified',
      reason: `pool.factory() is ${claimedFactory ?? 'unreadable'}, not the trusted factory`,
      evidence: { trustedAnchor: anchor, claimedFactory, rpcCalls },
    };
  }

  const t0Hex = await step(p, SEL.token0, 'token0()');
  if (t0Hex === false) return pending('token0() call failed');
  const t1Hex = await step(p, SEL.token1, 'token1()');
  if (t1Hex === false) return pending('token1() call failed');
  const feeHex = await step(p, SEL.fee, 'fee()');
  if (feeHex === false) return pending('fee() call failed');

  const token0 = toAddr(t0Hex);
  const token1 = toAddr(t1Hex);
  const fee = toNum(feeHex);
  if (!token0 || !token1 || fee == null) {
    return {
      ...base,
      status: 'unverified',
      reason: 'pool did not return a usable token pair and fee',
      evidence: { trustedAnchor: anchor, claimedFactory, token0, token1, fee, rpcCalls },
    };
  }

  // THE ROUND TRIP. pool.factory() is the pool's claim about itself; this is the
  // trusted factory independently naming the same address.
  const rtHex = await step(anchor, SEL.getPool + pad(token0) + pad(token1) + padNum(fee), 'getPool()');
  if (rtHex === false) return pending('factory.getPool() call failed');
  const roundTripPool = toAddr(rtHex);

  const ev = { trustedAnchor: anchor, claimedFactory, token0, token1, fee, roundTripPool, rpcCalls };
  if (!roundTripPool || roundTripPool === ZERO || roundTripPool !== p) {
    return {
      ...base,
      status: 'unverified',
      reason: `factory.getPool(token0, token1, fee) returned ${roundTripPool ?? 'nothing'}, not this pool`,
      evidence: ev,
    };
  }
  return {
    ...base,
    status: 'verified',
    reason: 'pool.factory() matches the trusted factory and getPool round-trips to this pool',
    evidence: ev,
  };
}

export interface InitializeLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: number;
  logIndex?: number;
  transactionHash?: string;
}

/**
 * Verify a Uniswap V4 pool from an Initialize event.
 *
 * V4 is a singleton, so there is no per-pool contract to interrogate — identity
 * rests entirely on the event having been EMITTED BY the trusted PoolManager.
 * An Initialize-shaped log from any other address proves nothing; that check is
 * the whole verification.
 */
export function verifyV4Pool(
  log: InitializeLog,
  trustedManager = POOL_MANAGER,
): PoolVerification {
  const anchor = lc(trustedManager);
  const emitter = lc(log.address);
  const base = { protocol: 'uniswap-v4' as const, checkedAt: Date.now() };

  if (emitter !== anchor) {
    return {
      ...base,
      pool: '',
      status: 'unverified',
      reason: `Initialize emitted by ${emitter}, not the trusted PoolManager`,
      evidence: { trustedAnchor: anchor, emitter },
    };
  }
  if (lc(log.topics?.[0]) !== lc(INIT_TOPIC) || log.topics.length < 4) {
    return {
      ...base,
      pool: '',
      status: 'unverified',
      reason: 'not a well-formed Initialize event',
      evidence: { trustedAnchor: anchor, emitter },
    };
  }

  const poolId = lc(log.topics[1]);
  const currency0 = toAddr(log.topics[2] ?? null);
  const currency1 = toAddr(log.topics[3] ?? null);
  let fee: number | null = null;
  let tickSpacing: number | null = null;
  let hooks: string | null = null;
  try {
    const [f, ts, hk] = AbiCoder.defaultAbiCoder().decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data,
    );
    fee = Number(f);
    tickSpacing = Number(ts);
    hooks = lc(String(hk));
  } catch {
    return {
      ...base,
      pool: poolId,
      status: 'unverified',
      reason: 'Initialize payload did not decode',
      evidence: { trustedAnchor: anchor, emitter, poolId, currency0, currency1 },
    };
  }

  return {
    ...base,
    pool: poolId,
    status: 'verified',
    reason: 'Initialize emitted by the trusted PoolManager',
    evidence: {
      trustedAnchor: anchor,
      emitter,
      poolId,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      blockNumber: log.blockNumber ?? null,
      logIndex: log.logIndex ?? null,
      txHash: log.transactionHash ?? null,
    },
  };
}

/**
 * Cache of verification outcomes.
 *
 * `verified` and `unverified` are cached: both are deterministic answers about
 * an immutable fact. `pending` is NEVER cached — caching a 429 would disqualify
 * a legitimate pool permanently on the strength of a throttle.
 */
export class PoolVerifier {
  private readonly cache = new Map<string, PoolVerification>();
  /** Pools we failed to reach, with their last failure. Retried, not concluded. */
  private readonly pendingPools = new Map<string, PoolVerification>();
  /**
   * SINGLE FLIGHT. One in-progress verification per pool address, shared by
   * every concurrent caller.
   *
   * Without this, a popular pool appearing in 40 candidate transactions in one
   * batch issues 40 identical verification runs — 200 RPC calls for one
   * immutable fact — and they arrive as a burst, which is precisely what earns
   * a 429. The cache alone does not prevent it: nothing is cached until the
   * first run RETURNS, so every caller that starts before then misses.
   */
  private readonly inflight = new Map<string, Promise<PoolVerification>>();

  private cacheHits = 0;
  private cacheMisses = 0;
  private coalesced = 0;

  constructor(private readonly call: EthCall) {}

  get(pool: string): PoolVerification | null {
    return this.cache.get(lc(pool)) ?? null;
  }

  async verifyV3(pool: string, trustedFactory = V3_FACTORY): Promise<PoolVerification> {
    const p = lc(pool);
    const hit = this.cache.get(p);
    if (hit) {
      this.cacheHits += 1;
      return hit;
    }
    const flight = this.inflight.get(p);
    if (flight) {
      this.coalesced += 1;
      return flight;
    }

    this.cacheMisses += 1;
    const run = (async (): Promise<PoolVerification> => {
      const v = await verifyV3Pool(p, this.call, trustedFactory);
      if (v.status === 'pending') {
        this.pendingPools.set(p, v);
        logger.debug({ pool: p, failure: v.evidence.failure }, 'pool verify: pending, will retry');
        return v;
      }
      this.pendingPools.delete(p);
      this.cache.set(p, v);
      return v;
    })();
    this.inflight.set(p, run);
    try {
      return await run;
    } finally {
      // Cleared unconditionally: leaving a settled (or rejected) promise here
      // would make a transient failure permanent for the process lifetime.
      this.inflight.delete(p);
    }
  }

  recordV4(log: InitializeLog, trustedManager = POOL_MANAGER): PoolVerification {
    const v = verifyV4Pool(log, trustedManager);
    if (v.status === 'verified') this.cache.set(lc(v.pool), v);
    return v;
  }

  /** Addresses safe to hand the classifier as `verifiedContracts`. */
  verifiedSet(): Set<string> {
    const s = new Set<string>();
    for (const [k, v] of this.cache) if (v.status === 'verified') s.add(k);
    return s;
  }

  pending(): PoolVerification[] {
    return [...this.pendingPools.values()];
  }

  /**
   * Pools awaiting verification, for `TxContext.pendingContracts`.
   *
   * A swap from one of these is `verification_pending`, not
   * `unsupported_protocol` — we have not finished asking.
   */
  pendingSet(): Set<string> {
    return new Set(this.pendingPools.keys());
  }

  stats(): PoolVerifierStats {
    let verified = 0;
    let unverified = 0;
    for (const v of this.cache.values()) {
      if (v.status === 'verified') verified += 1;
      else unverified += 1;
    }
    const lookups = this.cacheHits + this.cacheMisses + this.coalesced;
    return {
      verified,
      unverified,
      pending: this.pendingPools.size,
      uniqueAwaitingVerification: this.pendingPools.size,
      inflight: this.inflight.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      coalesced: this.coalesced,
      // Coalesced calls count as hits: like a cache hit, they cost no RPC.
      hitRate: lookups > 0 ? (this.cacheHits + this.coalesced) / lookups : 0,
    };
  }
}

export interface PoolVerifierStats {
  verified: number;
  unverified: number;
  pending: number;
  /** Distinct pools with no settled verdict yet. */
  uniqueAwaitingVerification: number;
  /** Verifications running right now. */
  inflight: number;
  cacheHits: number;
  cacheMisses: number;
  /** Callers that joined an in-flight verification instead of starting one. */
  coalesced: number;
  /** (hits + coalesced) / lookups — the share of lookups that cost no RPC. */
  hitRate: number;
}

/** Host-safe summary for a report. */
export const verifierSource = (rpcUrl: string): string => rpcHost(rpcUrl);

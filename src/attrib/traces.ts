import { logger } from '../logger.js';
import { logHttpFailure, logRpcThrow, redact, rpcHost } from '../chain/rpcLog.js';
import type { WalletDelta } from './taxonomy.js';

/**
 * Trace capability, as a per-source MATRIX rather than a boolean.
 *
 * Whether execution traces are available decides whether a whole class of
 * transactions is answerable at all: native ETH moving through internal calls
 * is invisible in receipt logs, and `tx.value` covers only the top-level leg.
 * So `insufficient_trace_data` is either a transient gap or a permanent floor,
 * and which one it is changes how every downstream number should be read.
 *
 * Three statuses, and the distinction between the last two is the entire point:
 *
 *   available      a structurally valid trace came back for a known finalized tx
 *   unavailable    the provider EXPLICITLY says the method does not exist
 *   indeterminate  auth, rate limit, timeout, transport, or an unparseable reply
 *
 * A 429 IS NOT "traces unavailable". Collapsing them would let a throttled
 * provider be recorded as a chain without tracing, permanently and wrongly —
 * exactly the absence-read-as-data failure this codebase keeps paying for. The
 * public RPC already 429s under sustained polling, so this is not hypothetical.
 *
 * MEASURED on chain 4663 via rpc.mainnet.chain.robinhood.com (2026-08-05):
 * debug_traceTransaction, trace_transaction and trace_block all return HTTP 200
 * with JSON-RPC code -32601 "does not exist/is not available", while
 * eth_getTransactionReceipt on the same host and transaction succeeds. That is
 * an unambiguous `unavailable`, with a working control to prove the endpoint and
 * the probe transaction were both fine.
 */

export type TraceMethod = 'debug_traceTransaction' | 'trace_block';
export type TraceStatus = 'available' | 'unavailable' | 'indeterminate';

export interface TraceCapability {
  chainId: string;
  /** Host only — an endpoint URL may embed an API key. */
  sourceHost: string;
  method: TraceMethod;
  status: TraceStatus;
  /** Why, in a form safe to display. */
  detail: string;
  /** JSON-RPC error code, when the provider supplied one. */
  errorCode?: number;
  checkedAt: number;
}

/** JSON-RPC "method not found". The one code that means genuinely unsupported. */
const METHOD_NOT_FOUND = -32601;

/** HTTP statuses that say nothing about the method itself. */
const INDETERMINATE_HTTP = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

const key = (chainId: string, host: string, method: TraceMethod): string =>
  `${chainId}|${host}|${method}`;

/**
 * Does this look like a usable trace, rather than merely a 200?
 *
 * A provider can answer successfully with `null`, `{}`, or an error object
 * nested in a result. Recording that as `available` would promise downstream
 * code a capability it does not have.
 */
export function isValidCallTrace(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  // callTracer frames carry at minimum a type and a from; nested calls are optional
  // (a simple transfer has none), so their absence must not fail the check.
  const hasType = typeof r.type === 'string' && r.type.length > 0;
  const hasFrom = typeof r.from === 'string' && r.from.startsWith('0x');
  if (!hasType || !hasFrom) return false;
  if (r.calls !== undefined && !Array.isArray(r.calls)) return false;
  return true;
}

/**
 * Reduce a `callTracer` tree to the watched wallet's net native-ETH movement.
 *
 * The trace contains every internal call, so we deliberately count only frames
 * incident to the wallet. Counting the router → pool legs would double-count
 * a single user payment. A reverted subcall moved no value and is ignored.
 */
export function nativeDeltasFromCallTrace(trace: unknown, wallet: string): WalletDelta[] {
  if (!isValidCallTrace(trace)) return [];
  const watched = wallet.toLowerCase();
  let net = 0n;

  const quantity = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return 0n;
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  };
  const walk = (frame: unknown): void => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
    const f = frame as Record<string, unknown>;
    // A failed nested call is rolled back. Its value is not a settled native leg.
    if (f.error != null) return;
    const value = quantity(f.value);
    const from = typeof f.from === 'string' ? f.from.toLowerCase() : '';
    const to = typeof f.to === 'string' ? f.to.toLowerCase() : '';
    if (value > 0n && from !== to) {
      if (from === watched) net -= value;
      if (to === watched) net += value;
    }
    if (Array.isArray(f.calls)) for (const child of f.calls) walk(child);
  };
  walk(trace);
  return net === 0n
    ? []
    : [{ token: 'native', rawDelta: net.toString(), decimals: 18, source: 'trace_native' }];
}

/** trace_block returns an ARRAY of frames, each with an action and a type. */
export function isValidBlockTrace(result: unknown): boolean {
  if (!Array.isArray(result)) return false;
  if (result.length === 0) return true; // an empty block is structurally fine
  const f = result[0] as Record<string, unknown>;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.type === 'string' &&
    (typeof f.action === 'object' || typeof f.result === 'object')
  );
}

export interface ProbeTarget {
  chainId: string;
  rpcUrl: string;
  /** A known FINALIZED transaction on this chain. */
  probeTxHash: string;
  /** A block known to exist, for trace_block. */
  probeBlockHex: string;
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<
  | { kind: 'ok'; result: unknown }
  | { kind: 'rpcError'; code: number; message: string }
  | { kind: 'http'; status: number }
  | { kind: 'transport'; detail: string }
> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      logHttpFailure({ op: 'trace-probe', url, method }, res.status, res.statusText);
      return { kind: 'http', status: res.status };
    }
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (body.error) {
      return {
        kind: 'rpcError',
        code: typeof body.error.code === 'number' ? body.error.code : 0,
        message: String(body.error.message ?? ''),
      };
    }
    return { kind: 'ok', result: body.result };
  } catch (err) {
    logRpcThrow({ op: 'trace-probe', url, method }, err);
    return { kind: 'transport', detail: String(err) };
  }
}

/**
 * Probe ONE method. Each is reported separately — one can work while the other
 * does not, and a provider that supports `debug_*` but not `trace_*` (or the
 * reverse) is common.
 */
export async function probeMethod(
  target: ProbeTarget,
  method: TraceMethod,
): Promise<TraceCapability> {
  const host = rpcHost(target.rpcUrl);
  const base = { chainId: target.chainId, sourceHost: host, method, checkedAt: Date.now() };

  const params: unknown[] =
    method === 'debug_traceTransaction'
      ? [target.probeTxHash, { tracer: 'callTracer' }]
      : [target.probeBlockHex];

  const r = await rpcCall(target.rpcUrl, method, params);

  if (r.kind === 'http') {
    // Auth/rate-limit/server errors say nothing about the METHOD.
    return {
      ...base,
      status: 'indeterminate',
      detail: INDETERMINATE_HTTP.has(r.status)
        ? `http ${r.status} — provider unavailable, not the method`
        : `http ${r.status}`,
    };
  }
  if (r.kind === 'transport') {
    return { ...base, status: 'indeterminate', detail: redact(r.detail).slice(0, 160) };
  }
  if (r.kind === 'rpcError') {
    if (r.code === METHOD_NOT_FOUND) {
      return {
        ...base,
        status: 'unavailable',
        errorCode: r.code,
        detail: redact(r.message).slice(0, 160),
      };
    }
    // Any other JSON-RPC error — a bad param, a pruned block, a node hiccup —
    // is not evidence the method is missing.
    return {
      ...base,
      status: 'indeterminate',
      errorCode: r.code,
      detail: redact(r.message).slice(0, 160),
    };
  }

  const valid =
    method === 'debug_traceTransaction' ? isValidCallTrace(r.result) : isValidBlockTrace(r.result);
  return valid
    ? { ...base, status: 'available', detail: 'structurally valid trace returned' }
    : {
        ...base,
        status: 'indeterminate',
        detail: 'HTTP 200 but the payload is not a usable trace',
      };
}

/**
 * Capability matrix with per-host caching.
 *
 * Cached by `(chain_id, source_host, method)` so switching providers cannot
 * inherit the previous one's answer, and TTL'd so an `indeterminate` caused by
 * a transient 429 is retried rather than frozen in place.
 */
export class TraceCapabilityMatrix {
  private readonly cache = new Map<string, TraceCapability>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  get(chainId: string, rpcUrl: string, method: TraceMethod): TraceCapability | null {
    const c = this.cache.get(key(chainId, rpcHost(rpcUrl), method));
    if (!c) return null;
    // Never let a transient failure harden into a permanent answer. `>=` so a
    // TTL of 0 means "always re-probe" rather than "cache forever within the
    // same millisecond".
    if (Date.now() - c.checkedAt >= this.ttlMs) return null;
    return c;
  }

  async probe(target: ProbeTarget, method: TraceMethod): Promise<TraceCapability> {
    const cached = this.get(target.chainId, target.rpcUrl, method);
    if (cached) return cached;
    const cap = await probeMethod(target, method);
    this.cache.set(key(cap.chainId, cap.sourceHost, method), cap);
    logger.info(
      { chainId: cap.chainId, host: cap.sourceHost, method, status: cap.status, detail: cap.detail },
      'trace capability probed',
    );
    return cap;
  }

  /** Probe every method and return the full matrix for this source. */
  async probeAll(target: ProbeTarget): Promise<TraceCapability[]> {
    return Promise.all(
      (['debug_traceTransaction', 'trace_block'] as TraceMethod[]).map((m) =>
        this.probe(target, m),
      ),
    );
  }

  /** Drop everything for a host — call when the configured source changes. */
  invalidateHost(rpcUrl: string): void {
    const host = rpcHost(rpcUrl);
    for (const k of [...this.cache.keys()]) {
      if (k.split('|')[1] === host) this.cache.delete(k);
    }
  }

  entries(): TraceCapability[] {
    return [...this.cache.values()];
  }
}

/**
 * Can native/internal flow be proven on this source?
 *
 * True only when a method is positively `available`. `indeterminate` is NOT
 * treated as capable — we would be promising evidence we have never seen — and
 * it is equally not recorded as incapable, so the report can say "we do not
 * know yet" instead of inventing either answer.
 */
export function tracesUsable(caps: TraceCapability[]): boolean {
  return caps.some((c) => c.status === 'available');
}

/** A one-line summary safe to put in a report header. */
export function traceCoverageLabel(caps: TraceCapability[]): string {
  if (caps.length === 0) return 'trace capability: not probed';
  if (tracesUsable(caps)) return 'trace capability: available';
  if (caps.every((c) => c.status === 'unavailable')) {
    return 'trace capability: UNAVAILABLE on this source — native/internal flow is permanently unprovable here';
  }
  return 'trace capability: INDETERMINATE — provider errors prevented a conclusion; do not read this as unavailable';
}

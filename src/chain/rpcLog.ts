import { logger } from '../logger.js';

/**
 * Structured, redacted logging for RPC/HTTP failures.
 *
 * Every call site in this directory used to swallow a failure the same way:
 *
 *     if (!res.ok) return null;
 *
 * No status, no operation, no range — nothing. That single line cost four
 * separate investigations. It hid the public RPC returning **429 Rate Limit**
 * under sustained polling, so the listener looked like a chain with no activity
 * on it; and it hid HyperSync answering **401 (API token required)**, so a
 * probe against it reported "0 logs" rather than "you are not authenticated".
 * Both read as absence of data. Neither was.
 *
 * A JSON-RPC error is just as silent and arrives differently — HTTP **200**
 * with an `error` object in the body — so an endpoint can be "reachable" and
 * "OK" while answering nothing useful. Both shapes are logged here.
 *
 * NEVER log the URL. Listener and executor URLs carry API keys in the path or
 * query; the host alone identifies which provider failed, which is the whole
 * diagnostic value.
 */

/** Host only — an endpoint URL may embed an API key. */
export function rpcHost(url: string): string {
  try {
    // .hostname deliberately, not .host or .href: it drops userinfo, port,
    // path and query, which is where every credential form lives.
    return new URL(url).hostname;
  } catch {
    return '<unparseable>';
  }
}

/**
 * Scrub anything credential-shaped out of a message we did not author.
 *
 * Node's fetch errors and a node's own JSON-RPC `message` can both echo the
 * request back, so logging them verbatim can reprint the very URL `rpcHost`
 * exists to avoid. Any URL collapses to its host; long opaque tokens are
 * masked. Cheap insurance on a path whose entire job is being safe to read.
 */
export function redact(input: string): string {
  return (
    input
      // Any URL -> scheme + host, dropping userinfo, path, query and fragment.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (m) => {
        try {
          const u = new URL(m);
          return `${u.protocol}//${u.hostname}/<redacted>`;
        } catch {
          return '<redacted-url>';
        }
      })
      // Bearer tokens and long opaque hex/base64 runs (API keys, JWTs).
      .replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer <redacted>')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted-token>')
  );
}

export interface RpcFailureContext {
  /** What was being fetched: 'logs' | 'receipt' | 'metadata' | 'price' | … */
  op: string;
  /** Endpoint URL — redacted to its host before logging. */
  url: string;
  /** JSON-RPC method, when there is one. */
  method?: string;
  /** Inclusive block range for range queries, e.g. "28744000-28744040". */
  range?: string;
}

/** HTTP-level failure: a non-2xx response. */
export function logHttpFailure(ctx: RpcFailureContext, status: number, statusText?: string): void {
  logger.warn(
    {
      op: ctx.op,
      host: rpcHost(ctx.url),
      ...(ctx.method ? { method: ctx.method } : {}),
      ...(ctx.range ? { range: ctx.range } : {}),
      status,
      ...(statusText ? { statusText } : {}),
      // The two that have actually bitten, called out so they are greppable.
      hint: status === 429 ? 'rate limited' : status === 401 || status === 403 ? 'auth' : undefined,
    },
    'rpc http error',
  );
}

/** JSON-RPC error delivered inside an HTTP 200. */
export function logRpcError(ctx: RpcFailureContext, error: unknown): void {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  logger.warn(
    {
      op: ctx.op,
      host: rpcHost(ctx.url),
      ...(ctx.method ? { method: ctx.method } : {}),
      ...(ctx.range ? { range: ctx.range } : {}),
      code: typeof e.code === 'number' ? e.code : undefined,
      // Bounded: some nodes return multi-KB messages on a range that is too wide.
      message: typeof e.message === 'string' ? redact(e.message).slice(0, 200) : undefined,
    },
    'rpc jsonrpc error',
  );
}

/** Transport failure: timeout, abort, DNS, connection reset. */
export function logRpcThrow(ctx: RpcFailureContext, err: unknown): void {
  logger.warn(
    {
      op: ctx.op,
      host: rpcHost(ctx.url),
      ...(ctx.method ? { method: ctx.method } : {}),
      ...(ctx.range ? { range: ctx.range } : {}),
      err: redact(String(err)).slice(0, 200),
    },
    'rpc transport error',
  );
}

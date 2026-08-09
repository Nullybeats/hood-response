import type { TrackedToken } from '../types.js';
import { logHttpFailure, logRpcError, logRpcThrow } from './rpcLog.js';
import { schedulerFor, type SchedulerPriority } from '../attrib/scheduler.js';

/**
 * Best-effort ERC-20 metadata reader over HTTP JSON-RPC (`eth_call`).
 *
 * Used to enrich tokens discovered at runtime with their real symbol, decimals
 * and total supply. Every step is defensive: any RPC hiccup or non-standard
 * token just leaves the placeholder metadata in place, so this never throws
 * into the hot path.
 */

// keccak256 selectors.
const SEL_SYMBOL = '0x95d89b41'; // symbol()
const SEL_DECIMALS = '0x313ce567'; // decimals()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()

async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
  priority: SchedulerPriority,
): Promise<string | null> {
  const sched = schedulerFor(rpcUrl);
  try {
    return await sched.run(async () => {
      // Queue time is deliberate back-pressure, not a network timeout.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
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
          signal: ctrl.signal,
        });
        const ctx = { op: 'metadata', url: rpcUrl, method: 'eth_call' };
        if (!res.ok) {
          logHttpFailure(ctx, res.status, res.statusText);
          if (res.status === 429 || res.status === 503) sched.penalise(1_000);
          return null;
        }
        const json = (await res.json()) as { result?: string; error?: unknown };
        if (json.error) {
          logRpcError(ctx, json.error);
          return null;
        }
        return json.result ?? null;
      } finally {
        clearTimeout(t);
      }
    }, priority, undefined, 'token-metadata');
  } catch (err) {
    logRpcThrow({ op: 'metadata', url: rpcUrl, method: 'eth_call' }, err);
    return null;
  }
}

/** Decode an ABI-encoded `string` return; falls back to a bytes32 symbol. */
function decodeString(hex: string | null): string | null {
  if (!hex || hex === '0x') return null;
  const body = hex.replace(/^0x/, '');
  try {
    // Standard dynamic string: [offset][length][data].
    if (body.length >= 128) {
      const len = parseInt(body.slice(64, 128), 16);
      if (len > 0 && len <= 64) {
        const raw = body.slice(128, 128 + len * 2);
        const s = Buffer.from(raw, 'hex').toString('utf8').replace(/\0+$/, '').trim();
        if (s) return s;
      }
    }
    // Some tokens return a fixed bytes32 symbol instead.
    const s = Buffer.from(body.slice(0, 64), 'hex').toString('utf8').replace(/\0+$/, '').trim();
    return s || null;
  } catch {
    return null;
  }
}

function decodeUint(hex: string | null): number | null {
  if (!hex || hex === '0x') return null;
  try {
    return Number(BigInt(hex));
  } catch {
    return null;
  }
}

export async function fetchTokenMetadata(
  rpcUrl: string,
  tokenAddr: string,
  priority: SchedulerPriority = 'normal',
): Promise<Partial<TrackedToken> | null> {
  const [symbolHex, decimalsHex, supplyHex] = await Promise.all([
    ethCall(rpcUrl, tokenAddr, SEL_SYMBOL, priority),
    ethCall(rpcUrl, tokenAddr, SEL_DECIMALS, priority),
    ethCall(rpcUrl, tokenAddr, SEL_TOTAL_SUPPLY, priority),
  ]);

  const symbol = decodeString(symbolHex);
  const decimals = decodeUint(decimalsHex);
  const rawSupply = decodeUint(supplyHex);

  const meta: Partial<TrackedToken> = {};
  if (symbol) {
    meta.symbol = symbol;
    meta.name = symbol;
  }

  // DECIMALS AND SUPPLY ARE INDEPENDENT FACTS, and used to be written as one.
  //
  // They were set together under `rawSupply != null && decimals != null`, so a
  // transient failure on the totalSupply() call alone discarded the decimals
  // too. buildSwapFromLog drops any swap whose token has no decimals — so one
  // flaky eth_call did not merely leave the cap unknown, it made the token
  // invisible to detection entirely, and brand-new coins are both the ones we
  // care about and the ones being read under the least favourable conditions.
  const decimalsOk = decimals != null && decimals >= 0 && decimals <= 36;
  if (decimalsOk) meta.decimals = decimals;

  // The supply is only a supply when the contract gave us one. Absent that,
  // `supplyVerified` stays false and the oracle refuses to derive a cap — the
  // ANOA guard, unchanged.
  if (rawSupply != null && decimalsOk) {
    meta.totalSupply = rawSupply / 10 ** decimals;
    meta.supplyVerified = true;
  }
  return Object.keys(meta).length ? meta : null;
}

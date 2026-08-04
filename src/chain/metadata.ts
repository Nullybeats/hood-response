import type { TrackedToken } from '../types.js';

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

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string | null> {
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
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    return json.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
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
): Promise<Partial<TrackedToken> | null> {
  const [symbolHex, decimalsHex, supplyHex] = await Promise.all([
    ethCall(rpcUrl, tokenAddr, SEL_SYMBOL),
    ethCall(rpcUrl, tokenAddr, SEL_DECIMALS),
    ethCall(rpcUrl, tokenAddr, SEL_TOTAL_SUPPLY),
  ]);

  const symbol = decodeString(symbolHex);
  const decimals = decodeUint(decimalsHex);
  const rawSupply = decodeUint(supplyHex);

  const meta: Partial<TrackedToken> = {};
  if (symbol) {
    meta.symbol = symbol;
    meta.name = symbol;
  }
  if (rawSupply != null && decimals != null && decimals >= 0 && decimals <= 36) {
    meta.totalSupply = rawSupply / 10 ** decimals;
    meta.decimals = decimals;
    // The supply is now the contract's own, not ensureToken's 1e9 placeholder —
    // which is the only condition under which price * supply is a market cap.
    meta.supplyVerified = true;
  }
  return Object.keys(meta).length ? meta : null;
}

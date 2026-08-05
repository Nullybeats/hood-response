import { id } from 'ethers';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { DecodedTransfer, EthLog } from './decoder.js';
import { logHttpFailure, logRpcError, logRpcThrow } from './rpcLog.js';

// Both official Uniswap swap event signatures. Receipt evidence is required in
// addition to a tracked-wallet transfer so airdrops/direct payments never turn
// into buy signals.
const V3_SWAP_TOPIC = id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase();
const V4_SWAP_TOPIC = id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').toLowerCase();

interface ReceiptLog { topics?: string[]; address?: string; }
interface Receipt { status?: string; logs?: ReceiptLog[]; }
interface Transaction { to?: string | null; }

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  if (!config.CHAIN_HTTP_URL) return null;
  try {
    const response = await fetch(config.CHAIN_HTTP_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6_000),
    });
    const ctx = { op: 'receipt', url: config.CHAIN_HTTP_URL, method };
    // The receipt pair is 2 RPC calls per candidate transfer, so it is the first
    // thing to be rate-limited under load — and a null here silently downgrades
    // a real swap to "no swap". It must never fail quietly again.
    if (!response.ok) {
      logHttpFailure(ctx, response.status, response.statusText);
      return null;
    }
    const body = await response.json() as { result?: T; error?: unknown };
    if (body.error) {
      logRpcError(ctx, body.error);
      return null;
    }
    return body.result ?? null;
  } catch (err) {
    logRpcThrow({ op: 'receipt', url: config.CHAIN_HTTP_URL, method }, err);
    return null;
  }
}

/** Returns true only when this exact transfer belongs to a successful DEX swap. */
export async function receiptConfirmsSwap(log: EthLog, transfer: DecodedTransfer): Promise<boolean> {
  if (!transfer.txHash) return false;
  const [receipt, tx] = await Promise.all([
    rpc<Receipt>('eth_getTransactionReceipt', [transfer.txHash]),
    rpc<Transaction>('eth_getTransactionByHash', [transfer.txHash]),
  ]);
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return false;
  const containsTransfer = receipt.logs.some((l) =>
    l.address?.toLowerCase() === log.address.toLowerCase() &&
    l.topics?.[0]?.toLowerCase() === log.topics[0]?.toLowerCase() &&
    l.topics?.[1]?.toLowerCase() === log.topics[1]?.toLowerCase() &&
    l.topics?.[2]?.toLowerCase() === log.topics[2]?.toLowerCase(),
  );
  if (!containsTransfer) return false;
  const hasSwapEvent = receipt.logs.some((l) => {
    const topic = l.topics?.[0]?.toLowerCase();
    return topic === V3_SWAP_TOPIC || topic === V4_SWAP_TOPIC;
  });
  if (!hasSwapEvent) return false;
  // A receipt event by itself is still ambiguous (a wallet can receive an
  // unrelated token in a multi-call); require the transaction to target a
  // configured execution router or a contract that emitted the swap event.
  const to = tx?.to?.toLowerCase() ?? '';
  const emittedBy = receipt.logs.some((l) => {
    const topic = l.topics?.[0]?.toLowerCase();
    return (topic === V3_SWAP_TOPIC || topic === V4_SWAP_TOPIC) && !!l.address;
  });
  if (!to && !emittedBy) return false;
  return true;
}

export function receiptDiagnostic(log: EthLog): void {
  logger.debug({ txHash: log.transactionHash }, 'chain transfer rejected: no receipt-confirmed swap evidence');
}

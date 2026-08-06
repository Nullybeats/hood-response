import type { Direction } from '../types.js';

/** keccak256("Transfer(address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
}

/** A 32-byte topic word encodes an address in its low 20 bytes. */
export function topicToAddress(topic: string): string {
  const hex = topic.replace(/^0x/, '');
  return ('0x' + hex.slice(-40)).toLowerCase();
}

/** Left-pad an address into a 32-byte topic word for log topic filters. */
export function addressToTopic(address: string): string {
  const hex = address.replace(/^0x/, '').toLowerCase();
  return '0x' + hex.padStart(64, '0');
}

export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

export interface DecodedTransfer {
  token: string;
  from: string;
  to: string;
  rawValue: bigint;
  txHash: string;
  blockNumber: number;
  /** Receipt-log identity for attribution reconciliation. */
  logIndex: number;
}

/**
 * Decode an ERC-20 Transfer log. Returns null for anything that isn't a
 * standard 3-topic Transfer so the listener can cheaply skip noise.
 */
export function decodeTransfer(log: EthLog): DecodedTransfer | null {
  if (!log.topics || log.topics.length < 3) return null;
  if ((log.topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) return null;
  return {
    token: log.address.toLowerCase(),
    from: topicToAddress(log.topics[1] ?? ''),
    to: topicToAddress(log.topics[2] ?? ''),
    rawValue: hexToBigInt(log.data),
    txHash: log.transactionHash ?? '',
    blockNumber: log.blockNumber ? Number(hexToBigInt(log.blockNumber)) : 0,
    logIndex: log.logIndex ? Number(hexToBigInt(log.logIndex)) : -1,
  };
}

/**
 * Classify a transfer relative to a tracked wallet. A tracked wallet on the
 * receiving end is accumulating (BUY); on the sending end it is distributing
 * (SELL). Callers pass which side matched.
 */
export function directionFor(
  transfer: DecodedTransfer,
  isTracked: (addr: string) => boolean,
): { wallet: string; direction: Direction } | null {
  if (isTracked(transfer.to)) return { wallet: transfer.to, direction: 'BUY' };
  if (isTracked(transfer.from)) return { wallet: transfer.from, direction: 'SELL' };
  return null;
}

/** Convert a raw uint256 token value to human units given decimals. */
export function toHuman(raw: bigint, decimals = 18): number {
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  return Number(whole) + Number(frac) / Number(denom);
}

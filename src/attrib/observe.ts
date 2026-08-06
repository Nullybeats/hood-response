import { logger } from '../logger.js';
import { addressToTopic, TRANSFER_TOPIC } from '../chain/decoder.js';
import type { HsLog, HsTransaction, HyperSyncClient } from '../chain/hypersync.js';
import type { AttributionLedger } from './ledger.js';
import { checkContinuity } from './finality.js';

/**
 * The observation layer: establish the COVERAGE UNIVERSE.
 *
 * Nothing here classifies. It answers one question — which `(tx, wallet)` pairs
 * exist in this block range — and records them. Verdicts come later, and a pair
 * that is never observed can never be classified, so an omission here is
 * invisible everywhere downstream. That is why this is its own phase.
 *
 * THREE INDEPENDENT STREAMS, deliberately not one:
 *
 *   wallet-tx-sender     transactions the wallet SENT
 *   wallet-tx-recipient  transactions sent TO the wallet
 *   wallet-transfers     ERC-20 Transfer logs naming the wallet
 *
 * Transfer logs alone are a DISCOVERY INDEX, not the universe: a native-ETH
 * send, an approval, a failed call and a token contract that does not emit
 * standard Transfers are all invisible to them.
 *
 * And the streams are separate because a combined filter is a trap. MEASURED on
 * this chain 2026-08-05, over a 20,000-block window:
 *
 *   transactions: [{ from: [wallets] }]                  ->  48
 *   transactions: [{ to:   [wallets] }]                  ->   0
 *   transactions: [{ from: [wallets], to: [wallets] }]   ->   0   <- AND!
 *   transactions: [{ from: [wallets] }, { to: [wallets] }] -> 48  <- OR
 *
 * Filters INSIDE one object are ANDed. A single `{from, to}` object would have
 * returned nothing at all while presenting as sender-or-recipient coverage —
 * silent zero coverage that looks like a quiet chain. Separate streams also
 * mean each carries its own cursor, so one sweep truncating cannot let the
 * other's progress imply blocks it never covered.
 */

export const STREAM_SENDER = 'wallet-tx-sender';
export const STREAM_RECIPIENT = 'wallet-tx-recipient';
export const STREAM_TRANSFERS = 'wallet-transfers';

export interface ObserveResult {
  /** Observations written (rows, not pairs). */
  written: number;
  /** The block through which this stream is genuinely complete. */
  covered: number;
  truncated: boolean;
}

const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const topicAddr = (t: string | null | undefined): string | null =>
  t && t.length >= 42 ? `0x${t.slice(-40)}`.toLowerCase() : null;

const TX_FIELDS = ['hash', 'from', 'to', 'value', 'input', 'block_number', 'status'];

/**
 * Observe transactions where a watched wallet is the top-level sender or
 * recipient. One sweep per direction — see the note above on AND semantics.
 *
 * Observations are recorded ONLY up to the sweep's own `covered` block. A
 * partial sweep contributes what it returned and never implies the remainder
 * was empty.
 */
async function observeTxSide(
  hs: HyperSyncClient,
  ledger: AttributionLedger,
  watched: Set<string>,
  from: number,
  to: number,
  side: 'from' | 'to',
): Promise<ObserveResult | null> {
  const streamId = side === 'from' ? STREAM_SENDER : STREAM_RECIPIENT;
  const filter = side === 'from' ? { from: [...watched] } : { to: [...watched] };
  const r = await hs.sweep(
    from,
    to,
    { transactions: [filter], field_selection: { transaction: TX_FIELDS } },
    (res) => (res.data ?? []).flatMap((d) => d.transactions ?? []),
  );
  if (!r) return null;
  const continuity = checkContinuity(ledger, streamId, r.firstGuard);
  if (!continuity.ok) {
    ledger.rollbackTo(
      streamId,
      continuity.brokenAt!,
      continuity.expectedHash ?? null,
      continuity.actualParentHash ?? null,
    );
    logger.warn({ streamId, brokenAt: continuity.brokenAt }, 'observe: reorg detected — rolled back before writing');
    return null;
  }

  let written = 0;
  for (const t of r.items as HsTransaction[]) {
    const block = t.block_number ?? 0;
    // The load-bearing line: never record beyond what this sweep covered.
    if (block >= r.covered) continue;
    if (!t.hash) continue;
    const wallet = side === 'from' ? lc(t.from) : lc(t.to);
    if (!watched.has(wallet)) continue;
    // log_index -1: this involvement is not a log.
    if (
      ledger.recordObservation(
        t.hash,
        -1,
        wallet,
        block,
        side === 'from' ? 'tx_sender' : 'tx_recipient',
        null,
        null,
        t.value ?? null,
      )
    ) {
      written += 1;
    }
  }
  ledger.advanceCursor(streamId, r.covered);
  if (r.guard?.block_number != null && r.guard.hash) {
    ledger.recordCheckpoint(streamId, r.guard.block_number, r.guard.hash);
  }
  return { written, covered: r.covered, truncated: r.truncated };
}

export function observeSenderTransactions(
  hs: HyperSyncClient,
  ledger: AttributionLedger,
  watched: Set<string>,
  from: number,
  to: number,
): Promise<ObserveResult | null> {
  return observeTxSide(hs, ledger, watched, from, to, 'from');
}

export function observeRecipientTransactions(
  hs: HyperSyncClient,
  ledger: AttributionLedger,
  watched: Set<string>,
  from: number,
  to: number,
): Promise<ObserveResult | null> {
  return observeTxSide(hs, ledger, watched, from, to, 'to');
}

/**
 * Observe ERC-20 Transfer logs naming a watched wallet, in either direction.
 *
 * Both directions go in ONE sweep here because HyperSync ORs across the `logs`
 * array (the same array-of-objects form proven above), and topic positions are
 * independent filters rather than a single ANDed object.
 */
export async function observeTransferLogs(
  hs: HyperSyncClient,
  ledger: AttributionLedger,
  watched: Set<string>,
  from: number,
  to: number,
): Promise<ObserveResult | null> {
  const topics = [...watched].map((w) => addressToTopic(w).toLowerCase());
  const r = await hs.sweepLogs(
    from,
    to,
    [
      { topics: [[TRANSFER_TOPIC], [], topics] }, // wallet is `to`
      { topics: [[TRANSFER_TOPIC], topics, []] }, // wallet is `from`
    ],
    ['topic0', 'topic1', 'topic2', 'block_number', 'transaction_hash', 'address', 'log_index'],
  );
  if (!r) return null;
  const continuity = checkContinuity(ledger, STREAM_TRANSFERS, r.firstGuard);
  if (!continuity.ok) {
    ledger.rollbackTo(
      STREAM_TRANSFERS,
      continuity.brokenAt!,
      continuity.expectedHash ?? null,
      continuity.actualParentHash ?? null,
    );
    logger.warn({ streamId: STREAM_TRANSFERS, brokenAt: continuity.brokenAt }, 'observe: reorg detected — rolled back before writing');
    return null;
  }

  let written = 0;
  for (const l of r.items as HsLog[]) {
    const block = l.block_number ?? 0;
    if (block >= r.covered) continue;
    if (!l.transaction_hash) continue;
    const to2 = topicAddr(l.topic2);
    const from2 = topicAddr(l.topic1);
    // A wallet-to-wallet transfer between two WATCHED wallets is two pairs, one
    // per wallet — each has its own economic story to answer for.
    for (const [addr, hint] of [
      [to2, 'IN'],
      [from2, 'OUT'],
    ] as const) {
      if (!addr || !watched.has(addr)) continue;
      if (
        ledger.recordObservation(
          l.transaction_hash,
          l.log_index ?? 0,
          addr,
          block,
          'transfer_log',
          l.address ?? null,
          hint,
          null,
        )
      ) {
        written += 1;
      }
    }
  }
  ledger.advanceCursor(STREAM_TRANSFERS, r.covered);
  if (r.guard?.block_number != null && r.guard.hash) {
    ledger.recordCheckpoint(STREAM_TRANSFERS, r.guard.block_number, r.guard.hash);
  }
  return { written, covered: r.covered, truncated: r.truncated };
}

export interface UniverseResult {
  sender: ObserveResult | null;
  recipient: ObserveResult | null;
  transfers: ObserveResult | null;
  /** The block through which ALL required streams are complete. */
  safeCovered: number;
  /** True when any stream fell short — the window is incomplete, not empty. */
  anyTruncated: boolean;
}

/**
 * Run all three streams over a range and report the block through which the
 * universe is genuinely established.
 *
 * `safeCovered` is the MINIMUM across the three. A caller that treats a higher
 * block as covered would claim a universe built from streams that never reached
 * it — the failure the per-sweep `covered` value exists to prevent.
 *
 * A stream returning null (total failure) contributes `from - 1`: nothing was
 * established, so nothing may be claimed.
 */
export async function observeUniverse(
  hs: HyperSyncClient,
  ledger: AttributionLedger,
  watched: Set<string>,
  from: number,
  to: number,
): Promise<UniverseResult> {
  // Keep these sequential.  A continuity check may roll back every stream;
  // concurrent writers could otherwise commit fresh observations after another
  // stream has detected and rolled back a reorg.
  const sender = await observeSenderTransactions(hs, ledger, watched, from, to);
  const recipient = await observeRecipientTransactions(hs, ledger, watched, from, to);
  const transfers = await observeTransferLogs(hs, ledger, watched, from, to);
  const covereds = [sender, recipient, transfers].map((r) => r?.covered ?? from - 1);
  const safeCovered = Math.min(...covereds);
  const anyTruncated = [sender, recipient, transfers].some((r) => r === null || r.truncated);
  if (anyTruncated) {
    logger.warn(
      {
        from,
        to,
        safeCovered,
        sender: sender?.covered ?? null,
        recipient: recipient?.covered ?? null,
        transfers: transfers?.covered ?? null,
      },
      'observe: a stream fell short — window is INCOMPLETE, not empty',
    );
  }
  return { sender, recipient, transfers, safeCovered, anyTruncated };
}

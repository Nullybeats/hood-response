import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionLedger } from '../attrib/ledger.js';
import { CLASSIFIER_VERSION, emptyEvidence, result } from '../attrib/taxonomy.js';

describe('attribution ledger', () => {
  let dir: string;
  let led: AttributionLedger;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attrib-'));
    led = new AttributionLedger(join(dir, 'ledger.sqlite'));
  });
  afterEach(async () => {
    led.close();
    await rm(dir, { recursive: true, force: true });
  });

  const key = { txHash: '0xAAA', wallet: '0xwallet' };

  it('claims an observation exactly once — replay cannot double-count', () => {
    expect(led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log', '0xtok', 'BUY', '5')).toBe(true);
    expect(led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log', '0xtok', 'BUY', '5')).toBe(false);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('many logs in one tx collapse to ONE (tx, wallet) pair', () => {
    // A log index identifies an emission, not an economic action. Three transfer
    // logs for the same wallet in one tx are one thing that happened.
    led.recordObservation('0xAAA', 0, '0xw', 100, 'transfer_log');
    led.recordObservation('0xAAA', 1, '0xw', 100, 'transfer_log');
    led.recordObservation('0xAAA', 2, '0xw', 100, 'transfer_log');
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('two watched wallets in one tx are TWO pairs, each needing its own verdict', () => {
    led.recordObservation('0xAAA', 0, '0xw1', 100, 'transfer_log');
    led.recordObservation('0xAAA', 1, '0xw2', 100, 'transfer_log');
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(2);
  });

  it('records non-log involvement, so coverage is not defined by Transfer logs', () => {
    // A pure native-ETH send emits no Transfer at all. Defining the universe by
    // transfer logs would make it permanently invisible.
    expect(led.recordObservation('0xBBB', -1, '0xw', 101, 'tx_sender')).toBe(true);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('is case-insensitive on the tx hash, so casing cannot split a row', () => {
    led.recordObservation('0xAbC', 0, '0xW', 1, 'transfer_log');
    expect(led.recordObservation('0xabc', 0, '0xw', 1, 'transfer_log')).toBe(false);
  });

  it('NO SILENT DROPS: drift is non-zero until every pair has a verdict', () => {
    led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log');
    expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(1);
    led.recordAttribution(key, result('airdrop_receive', emptyEvidence()));
    expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(0);
  });

  it('a retriable failure is PENDING, not drift and not a verdict', () => {
    // The invariant must never create pressure to terminalise an infrastructure
    // failure into a permanent classification just to zero the drift count.
    led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log');
    led.markPending(key, 'rpc_http_error');
    const a = led.accountedFor(CLASSIFIER_VERSION);
    expect(a.pending).toBe(1);
    expect(a.drift).toBe(0);
    expect(a.attributed).toBe(0);
    expect(led.coverage(CLASSIFIER_VERSION)).toHaveLength(0);
  });

  it('resolving a pending pair clears the queue but KEEPS the failure history', () => {
    led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log');
    led.recordFailure({
      operation: 'receipt', fromBlock: 100, toBlock: 100,
      sourceUrl: 'https://h.example.com', kind: 'rpc_http_error', detail: 'HTTP 429',
    });
    led.markPending(key, 'rpc_http_error');
    led.recordAttribution(key, result('plain_transfer', emptyEvidence()));
    expect(led.accountedFor(CLASSIFIER_VERSION).pending).toBe(0);
    // Both survive: the eventual classification AND the record of what it cost.
    expect(led.failureRates()).toHaveLength(1);
  });

  it('pending work holds the safe cursor back to its block', () => {
    // Advancing past a tx whose receipt was never fetched would strand it
    // forever, because nothing would revisit that range.
    led.advanceCursor('wallet-transfers', 1000);
    led.advanceCursor('tx-context', 1000);
    expect(led.safeCursor()).toBe(1000);
    led.recordObservation('0xCCC', 0, '0xw', 400, 'transfer_log');
    led.markPending({ txHash: '0xCCC', wallet: '0xw' }, 'receipt_missing');
    expect(led.safeCursor()).toBe(399);
  });

  it('retry attempts accumulate rather than duplicating the row', () => {
    led.markPending(key, 'rpc_http_error');
    led.markPending(key, 'rpc_http_error');
    const w = led.pendingWork();
    expect(w).toHaveLength(1);
    expect(w[0]!.attempts).toBe(2);
  });

  it('keeps prior verdicts when the classifier version changes', () => {
    led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log');
    led.recordAttribution(key, { ...result('plain_transfer', emptyEvidence()), classifierVersion: 1 });
    led.recordAttribution(key, { ...result('airdrop_receive', emptyEvidence()), classifierVersion: 2 });
    // Both survive: re-classification adds a row, never overwrites history.
    expect(led.coverage(1).find((r) => r.category === 'plain_transfer')?.n).toBe(1);
    expect(led.coverage(2).find((r) => r.category === 'airdrop_receive')?.n).toBe(1);
  });

  it('outcome is derived from the category and cannot drift', () => {
    led.recordObservation('0xAAA', 3, '0xwallet', 100, 'transfer_log');
    led.recordAttribution(key, result('liquidity_add', emptyEvidence()));
    const row = led.coverage(CLASSIFIER_VERSION)[0]!;
    expect(row.category).toBe('liquidity_add');
    expect(row.outcome).toBe('confirmed_non_trade');
  });

  describe('cursors', () => {
    it('safeCursor is the MINIMUM across streams, never the furthest', () => {
      // The measured failure this exists for: a transfer query covered 1000
      // blocks while the swap query truncated at 261. Advancing on the transfer
      // cursor would mark 739 blocks scanned whose classification context was
      // never fetched.
      led.advanceCursor('wallet-transfers', 1000);
      led.advanceCursor('tx-context', 261);
      expect(led.safeCursor()).toBe(261);
      led.advanceCursor('tx-context', 1000);
      expect(led.safeCursor()).toBe(1000);
    });

    it('a cursor never moves backwards', () => {
      led.advanceCursor('s', 500);
      led.advanceCursor('s', 100);
      expect(led.cursors().s).toBe(500);
    });

    it('returns null when no stream has reported', () => {
      expect(led.safeCursor()).toBeNull();
    });
  });

  describe('failures', () => {
    it('stores the host only, never the URL or its API key', () => {
      led.recordFailure({
        operation: 'logs',
        fromBlock: 1,
        toBlock: 2,
        sourceUrl: 'https://eth.example.com/v2/SuperSecretKey123',
        kind: 'rpc_http_error',
        detail: 'HTTP 429',
      });
      const rows = led.failureRates();
      expect(rows[0]!.source_host).toBe('eth.example.com');
      expect(JSON.stringify(rows)).not.toContain('SuperSecretKey123');
    });

    it('redacts a URL echoed back inside the error detail', () => {
      led.recordFailure({
        operation: 'receipt',
        fromBlock: null,
        toBlock: null,
        sourceUrl: 'https://rpc.example.com',
        kind: 'rpc_transport_error',
        detail: 'request to https://rpc.example.com/v2/LeakedKey987654321 failed',
      });
      expect(JSON.stringify(led.failureRates())).not.toContain('LeakedKey987654321');
    });
  });

  it('surfaces the unknown-topic work queue ranked by frequency', () => {
    led.recordProtocolHits('0x1', [
      { contract: '0xC', eventSig: '0xUNKNOWN', protocolId: null, adapterVersion: null },
    ]);
    led.recordProtocolHits('0x2', [
      { contract: '0xC', eventSig: '0xUNKNOWN', protocolId: null, adapterVersion: null },
      { contract: '0xD', eventSig: '0xKNOWN', protocolId: 'uniswap-v3', adapterVersion: 1, verified: true },
    ]);
    const unknowns = led.unknownTopics();
    expect(unknowns).toHaveLength(1); // the verified+classified one is excluded
    expect(unknowns[0]!.n).toBe(2);
  });

  it('a disabled ledger reports degraded rather than silently recording nothing', () => {
    // An empty ledger and an idle chain must never be indistinguishable.
    const off = new AttributionLedger('');
    expect(off.degraded).toBe(true);
    expect(off.recordObservation('0xAAA', 0, '0xw', 1, 'transfer_log')).toBe(false);
    expect(off.coverage(CLASSIFIER_VERSION)).toEqual([]);
    expect(off.safeCursor()).toBeNull();
  });

  it('never prunes failures — they are the record of what we could not see', () => {
    led.recordObservation('0xold', 0, '0xw', 10, 'transfer_log');
    led.recordFailure({
      operation: 'logs',
      fromBlock: 10,
      toBlock: 11,
      sourceUrl: 'https://h.example.com',
      kind: 'pagination_truncated',
      detail: 'truncated',
    });
    led.pruneBefore(100);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(0);
    expect(led.failureRates()).toHaveLength(1);
  });
});

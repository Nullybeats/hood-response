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

  const key = { txHash: '0xAAA', logIndex: 3 };

  it('claims a candidate exactly once — replay cannot double-count', () => {
    expect(led.recordCandidate(key, 100, '0xwallet', '0xtok', 'BUY', '5')).toBe(true);
    // Same (txHash, logIndex) again, e.g. a replay over an overlapping range.
    expect(led.recordCandidate(key, 100, '0xwallet', '0xtok', 'BUY', '5')).toBe(false);
    expect(led.accountedFor(CLASSIFIER_VERSION).candidates).toBe(1);
  });

  it('is case-insensitive on the tx hash, so casing cannot split a row', () => {
    led.recordCandidate({ txHash: '0xAbC', logIndex: 0 }, 1, '0xw', null, null, null);
    expect(led.recordCandidate({ txHash: '0xabc', logIndex: 0 }, 1, '0xw', null, null, null)).toBe(
      false,
    );
  });

  it('NO SILENT DROPS: drift is non-zero until every candidate has a verdict', () => {
    led.recordCandidate(key, 100, '0xw', null, null, null);
    // Observed but unaccounted for — this is the alarm state.
    expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(1);
    led.recordResult(key, result('airdrop_receive', emptyEvidence()));
    expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(0);
  });

  it('keeps prior verdicts when the classifier version changes', () => {
    led.recordCandidate(key, 100, '0xw', null, null, null);
    led.recordResult(key, { ...result('plain_transfer', emptyEvidence()), classifierVersion: 1 });
    led.recordResult(key, { ...result('airdrop_receive', emptyEvidence()), classifierVersion: 2 });
    // Both survive: re-classification adds a row, never overwrites history.
    expect(led.coverage(1).find((r) => r.category === 'plain_transfer')?.n).toBe(1);
    expect(led.coverage(2).find((r) => r.category === 'airdrop_receive')?.n).toBe(1);
  });

  it('outcome is derived from the category and cannot drift', () => {
    led.recordCandidate(key, 100, '0xw', null, null, null);
    led.recordResult(key, result('liquidity_add', emptyEvidence()));
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
      { contract: '0xD', eventSig: '0xKNOWN', protocolId: 'uniswap-v3', adapterVersion: 1 },
    ]);
    const unknowns = led.unknownTopics();
    expect(unknowns).toHaveLength(1); // the classified one is excluded
    expect(unknowns[0]!.n).toBe(2);
  });

  it('a disabled ledger reports degraded rather than silently recording nothing', () => {
    // An empty ledger and an idle chain must never be indistinguishable.
    const off = new AttributionLedger('');
    expect(off.degraded).toBe(true);
    expect(off.recordCandidate(key, 1, '0xw', null, null, null)).toBe(false);
    expect(off.coverage(CLASSIFIER_VERSION)).toEqual([]);
    expect(off.safeCursor()).toBeNull();
  });

  it('never prunes failures — they are the record of what we could not see', () => {
    led.recordCandidate({ txHash: '0xold', logIndex: 0 }, 10, '0xw', null, null, null);
    led.recordFailure({
      operation: 'logs',
      fromBlock: 10,
      toBlock: 11,
      sourceUrl: 'https://h.example.com',
      kind: 'pagination_truncated',
      detail: 'truncated',
    });
    led.pruneBefore(100);
    expect(led.accountedFor(CLASSIFIER_VERSION).candidates).toBe(0);
    expect(led.failureRates()).toHaveLength(1);
  });
});

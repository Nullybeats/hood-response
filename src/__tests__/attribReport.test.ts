import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionLedger } from '../attrib/ledger.js';
import { buildReport, traceDecision, type TraceGapRow } from '../attrib/report.js';
import { finalityStatus } from '../attrib/finality.js';
import { CLASSIFIER_VERSION, emptyEvidence, result, type Evidence } from '../attrib/taxonomy.js';
import type { TraceCapability } from '../attrib/traces.js';

const cap = (status: TraceCapability['status']): TraceCapability => ({
  chainId: '4663',
  sourceHost: 'rpc.example.com',
  method: 'debug_traceTransaction',
  status,
  detail: '',
  checkedAt: Date.now(),
});

const gapRow = (
  over: Partial<NonNullable<Evidence['traceGap']>>,
  liveEmitted = false,
): TraceGapRow => ({
  evidence: {
    ...emptyEvidence(),
    traceGap: {
      oneSidedDelta: true,
      hadTopLevelValue: false,
      hadVerifiedSwap: true,
      ...over,
    },
  },
  liveEmitted,
});

describe('accounting report', () => {
  let dir: string;
  let led: AttributionLedger;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attrib-rep-'));
    led = new AttributionLedger(join(dir, 'l.sqlite'));
  });
  afterEach(async () => {
    led.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('the trace-provider decision is arithmetic, not taste', () => {
    it('recommends nothing when there are no trace-blocked cases', () => {
      const d = traceDecision([], 100);
      expect(d.insufficientTraceCount).toBe(0);
      expect(d.recommendation).toContain('would add nothing');
    });

    it('separates plausible trades from clearly unrelated cases', () => {
      const rows = [
        gapRow({ hadVerifiedSwap: true }), // plausible
        gapRow({ hadVerifiedSwap: true }),
        gapRow({ hadVerifiedSwap: false }), // no verified swap -> unrelated
      ];
      const d = traceDecision(rows, 100);
      expect(d.plausibleSwaps).toBe(2);
      expect(d.clearlyUnrelated).toBe(1);
      expect(d.oneSidedNoTopLevelValue).toBe(3);
    });

    it('does NOT count a case whose native leg was visible at top level', () => {
      // If tx.value was non-zero the counter-leg may already be provable; a
      // trace provider would not be what unlocks it.
      const d = traceDecision([gapRow({ hadTopLevelValue: true })], 100);
      expect(d.oneSidedNoTopLevelValue).toBe(0);
      expect(d.plausibleSwaps).toBe(0);
    });

    it('counts how many LIVE SIGNALS would change — the deciding number', () => {
      const rows = [
        gapRow({}, true), // live emitted AND plausible
        gapRow({}, true),
        gapRow({}, false), // plausible but nothing live depends on it
        gapRow({ hadVerifiedSwap: false }, true), // live, but not plausible
      ];
      const d = traceDecision(rows, 50);
      expect(d.liveSignalsAffected).toBe(2);
    });

    it('says "not worth it" for a tiny floor', () => {
      const d = traceDecision([gapRow({})], 1000);
      expect(d.insufficientTracePct).toBeLessThan(2);
      expect(d.recommendation).toContain('complexity for little gain');
    });

    it('says "worth sourcing, ASYNC ONLY" for a meaningful floor', () => {
      const rows = Array.from({ length: 20 }, () => gapRow({}));
      const d = traceDecision(rows, 100);
      expect(d.insufficientTracePct).toBe(20);
      expect(d.recommendation).toContain('ASYNCHRONOUS attribution only');
      expect(d.recommendation).toContain('never the live detection hot path');
    });

    it('does not recommend a provider when nothing trace-blocked looks like a trade', () => {
      const rows = Array.from({ length: 20 }, () => gapRow({ hadVerifiedSwap: false }));
      const d = traceDecision(rows, 100);
      expect(d.plausibleSwaps).toBe(0);
      expect(d.recommendation).toContain('would likely not recover trades');
    });
  });

  describe('the five states stay separate', () => {
    it('reports observed, attributed, eligible, live and unproven independently', () => {
      // A window that is fully ingested but contains almost no trades — the
      // shape most likely to be misread as a broken feed.
      led.recordObservation('0x1', 0, '0xw', 10, 'transfer_log');
      led.recordAttribution({ txHash: '0x1', wallet: '0xw' }, result('airdrop_receive', emptyEvidence()));
      led.recordObservation('0x2', 0, '0xw', 11, 'transfer_log');
      led.recordAttribution({ txHash: '0x2', wallet: '0xw' }, result('swap_v3_router', emptyEvidence()));
      led.recordEmission('0x2', 0, '0xw', 'BUY', '0xtok');
      led.recordObservation('0x3', 0, '0xw', 12, 'transfer_log');
      led.recordAttribution(
        { txHash: '0x3', wallet: '0xw' },
        result('insufficient_trace_data', emptyEvidence()),
      );

      const rep = buildReport({
        ledger: led,
        finality: finalityStatus(led, 1000),
        traceMatrix: [cap('unavailable')],
        traceRows: [],
        fromBlock: 0,
        toBlock: 100,
        liveEmitted: led.liveEmittedCount(),
      });

      expect(rep.observed).toBe(3);
      expect(rep.attributed).toBe(3);
      expect(rep.eligibleTrade).toBe(1);
      expect(rep.liveEmitted).toBe(1);
      expect(rep.unprovenNoTrace).toBe(1);
      // Full accounting despite only one trade — the point of the five states.
      expect(rep.accountedRatio).toBe(1);
      expect(rep.drift).toBe(0);
    });

    it('a pending pair lowers accountedRatio without becoming drift', () => {
      led.recordObservation('0x1', 0, '0xw', 10, 'transfer_log');
      led.recordAttribution({ txHash: '0x1', wallet: '0xw' }, result('plain_transfer', emptyEvidence()));
      led.recordObservation('0x2', 0, '0xw', 11, 'transfer_log');
      led.markPending({ txHash: '0x2', wallet: '0xw' }, 'rpc_http_error');

      const rep = buildReport({
        ledger: led,
        finality: finalityStatus(led, 1000),
        traceMatrix: [cap('unavailable')],
        traceRows: [],
        fromBlock: 0,
        toBlock: 100,
        liveEmitted: 0,
      });
      expect(rep.accountedRatio).toBeCloseTo(0.5, 5);
      expect(rep.drift).toBe(0);
      expect(rep.source.pendingPairs).toBe(1);
      expect(rep.caveats.join(' ')).toContain('awaiting a retriable fetch');
    });
  });

  describe('scope and caveats are stated, not implied', () => {
    const base = () => ({
      ledger: led,
      finality: finalityStatus(led, 1000),
      traceRows: [],
      fromBlock: 0,
      toBlock: 100,
      liveEmitted: 0,
    });

    it('never claims full coverage', () => {
      const rep = buildReport({ ...base(), traceMatrix: [cap('unavailable')] });
      expect(rep.scope).toContain('top-level transaction coverage');
      expect(rep.scope).not.toContain('full coverage');
      expect(rep.caveats[0]).toContain('Not "full coverage"');
    });

    it('states that traces are a STRUCTURAL FLOOR when unavailable', () => {
      const rep = buildReport({ ...base(), traceMatrix: [cap('unavailable')] });
      expect(rep.caveats.join(' ')).toContain('structural floor, not a backlog');
      expect(rep.traceCapability.usable).toBe(false);
    });

    it('does not call indeterminate traces unavailable', () => {
      const rep = buildReport({ ...base(), traceMatrix: [cap('indeterminate')] });
      expect(rep.traceCapability.label).toContain('INDETERMINATE');
      expect(rep.traceCapability.label).toContain('do not read this as unavailable');
    });

    it('refuses the words recall and precision', () => {
      const rep = buildReport({ ...base(), traceMatrix: [cap('available')] });
      const c = rep.caveats.join(' ');
      expect(c).toContain('not trade recall and not precision');
      expect(c).toContain('independently adjudicated');
    });

    it('flags a provisional window explicitly', () => {
      led.advanceCursor('s', 10_000);
      const rep = buildReport({
        ...base(),
        finality: finalityStatus(led, 10_050),
        traceMatrix: [cap('unavailable')],
      });
      expect(rep.finality.provisional).toBe(true);
      expect(rep.caveats.join(' ')).toContain('PROVISIONAL');
    });

    it('flags drift as a bug when it appears', () => {
      led.recordObservation('0xorphan', 0, '0xw', 10, 'transfer_log');
      const rep = buildReport({ ...base(), traceMatrix: [cap('unavailable')] });
      expect(rep.drift).toBe(1);
      expect(rep.caveats.join(' ')).toContain('This is a bug');
    });
  });

  it('separates retriable from terminal source failures', () => {
    led.recordFailure({
      operation: 'receipt', fromBlock: 1, toBlock: 2,
      sourceUrl: 'https://h.example.com', kind: 'rpc_http_error', detail: '429',
    });
    led.recordFailure({
      operation: 'decode', fromBlock: 1, toBlock: 2,
      sourceUrl: 'https://h.example.com', kind: 'decode_error', detail: 'bad payload',
    });
    const rep = buildReport({
      ledger: led,
      finality: finalityStatus(led, 1000),
      traceMatrix: [cap('unavailable')],
      traceRows: [],
      fromBlock: 0,
      toBlock: 100,
      liveEmitted: 0,
    });
    expect(rep.source.retriableFailures).toBe(1);
    expect(rep.source.terminalFailures).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionLedger } from '../attrib/ledger.js';
import { checkContinuity, coverageWindow, finalityStatus } from '../attrib/finality.js';
import { CLASSIFIER_VERSION, emptyEvidence, result } from '../attrib/taxonomy.js';

const STREAM = 'wallet-transfers';

describe('finality, continuity and reorg rollback', () => {
  let dir: string;
  let led: AttributionLedger;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attrib-fin-'));
    led = new AttributionLedger(join(dir, 'l.sqlite'));
  });
  afterEach(async () => {
    led.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('continuity', () => {
    it('accepts a sweep whose first parent matches our checkpoint', () => {
      led.recordCheckpoint(STREAM, 999, '0xparent');
      const c = checkContinuity(led, STREAM, {
        first_block_number: 1000,
        first_parent_hash: '0xPARENT',
      });
      expect(c.ok).toBe(true); // case-insensitive
    });

    it('DETECTS a reorg when the first parent contradicts our checkpoint', () => {
      led.recordCheckpoint(STREAM, 999, '0xoldparent');
      const c = checkContinuity(led, STREAM, {
        first_block_number: 1000,
        first_parent_hash: '0xnewparent',
      });
      expect(c.ok).toBe(false);
      expect(c.brokenAt).toBe(1000);
      expect(c.expectedHash).toBe('0xoldparent');
      expect(c.actualParentHash).toBe('0xnewparent');
    });

    it('has nothing to contradict when no checkpoint is held', () => {
      const c = checkContinuity(led, STREAM, {
        first_block_number: 1000,
        first_parent_hash: '0xanything',
      });
      expect(c.ok).toBe(true);
    });

    it('treats a missing guard as no evidence, not as proof of continuity', () => {
      // A source that stops supplying guards must not look like a source that
      // never reorgs. This returns ok, but the CALLER is responsible for
      // reporting that continuity was unverifiable — see finalityStatus.
      led.recordCheckpoint(STREAM, 999, '0xparent');
      expect(checkContinuity(led, STREAM, null).ok).toBe(true);
      expect(checkContinuity(led, STREAM, {}).ok).toBe(true);
    });
  });

  describe('rollback', () => {
    it('removes observations, verdicts and pending work at or after the reorg block', () => {
      // Two blocks of work; the later one is reorged away.
      led.recordObservation('0xkeep', 0, '0xw', 500, 'transfer_log');
      led.recordAttribution({ txHash: '0xkeep', wallet: '0xw' }, result('plain_transfer', emptyEvidence()));
      led.recordObservation('0xgone', 0, '0xw', 1000, 'transfer_log');
      led.recordAttribution({ txHash: '0xgone', wallet: '0xw' }, result('airdrop_receive', emptyEvidence()));
      led.recordObservation('0xalsogone', 0, '0xw2', 1001, 'transfer_log');
      led.markPending({ txHash: '0xalsogone', wallet: '0xw2' }, 'receipt_missing');

      expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(3);

      const r = led.rollbackTo(STREAM, 1000, '0xold', '0xnew');

      expect(r.observationsRemoved).toBe(2);
      expect(r.attributionsRemoved).toBe(1);
      const a = led.accountedFor(CLASSIFIER_VERSION);
      expect(a.pairs).toBe(1); // only the pre-reorg block survives
      expect(a.pending).toBe(0); // pending work for reorged blocks is dropped too
      expect(led.coverage(CLASSIFIER_VERSION).find((c) => c.category === 'plain_transfer')?.n).toBe(1);
    });

    it('rewinds every stream cursor, since a reorg invalidates the range for all', () => {
      led.advanceCursor('wallet-transfers', 2000);
      led.advanceCursor('tx-context', 2000);
      led.rollbackTo(STREAM, 1500, null, null);
      expect(led.cursors()['wallet-transfers']).toBe(1499);
      expect(led.cursors()['tx-context']).toBe(1499);
    });

    it('records the reorg permanently, so rollbacks are countable', () => {
      expect(led.reorgCount()).toBe(0);
      led.rollbackTo(STREAM, 1000, '0xa', '0xb');
      led.rollbackTo(STREAM, 2000, '0xc', '0xd');
      expect(led.reorgCount()).toBe(2);
    });

    it('drops checkpoints at or after the reorg so they cannot re-confirm bad state', () => {
      led.recordCheckpoint(STREAM, 999, '0xok');
      led.recordCheckpoint(STREAM, 1000, '0xbad');
      led.rollbackTo(STREAM, 1000, null, null);
      expect(led.checkpointAt(STREAM, 1000)).toBeNull();
      expect(led.checkpointAt(STREAM, 999)).toBe('0xok');
    });
  });

  describe('finality reporting', () => {
    it('marks the window provisional when the cursor is above the safe head', () => {
      led.advanceCursor(STREAM, 10_000);
      led.recordCheckpoint(STREAM, 10_000, '0xhash');
      const s = finalityStatus(led, 10_050, STREAM);
      // safeHead = 10050 - 300 = 9750; cursor 10000 is above it.
      expect(s.safeHead).toBe(9750);
      expect(s.provisional).toBe(true);
      expect(s.provisionalBlocks).toBe(250);
      expect(s.cursorHash).toBe('0xhash');
    });

    it('is settled when the cursor sits below the safe head', () => {
      led.advanceCursor(STREAM, 5_000);
      const s = finalityStatus(led, 10_000, STREAM);
      expect(s.provisional).toBe(false);
      expect(s.provisionalBlocks).toBe(0);
    });

    it('reports rollbacks alongside the head numbers', () => {
      led.rollbackTo(STREAM, 100, null, null);
      expect(finalityStatus(led, 1000, STREAM).reorgRollbacks).toBe(1);
    });
  });

  describe('coverage denominator', () => {
    it('INCLUDES pending fetches, so failing sources cannot inflate coverage', () => {
      // Three observed pairs: one attributed, one pending, one drifted.
      led.recordObservation('0x1', 0, '0xw', 10, 'transfer_log');
      led.recordAttribution({ txHash: '0x1', wallet: '0xw' }, result('plain_transfer', emptyEvidence()));
      led.recordObservation('0x2', 0, '0xw', 10, 'transfer_log');
      led.markPending({ txHash: '0x2', wallet: '0xw' }, 'rpc_http_error');
      led.recordObservation('0x3', 0, '0xw', 10, 'transfer_log');

      const w = coverageWindow(led, CLASSIFIER_VERSION, 0, 100, false);
      expect(w.attributed).toBe(1);
      expect(w.pending).toBe(1);
      expect(w.drift).toBe(1);
      // 1/3 — NOT 1/1. Excluding pending would let a source report perfect
      // coverage by observing less as it failed more.
      expect(w.accountedRatio).toBeCloseTo(1 / 3, 5);
    });

    it('carries the provisional flag into the window', () => {
      expect(coverageWindow(led, CLASSIFIER_VERSION, 0, 100, true).provisional).toBe(true);
    });
  });
});

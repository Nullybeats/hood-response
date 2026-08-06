import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionLedger } from '../attrib/ledger.js';
import { Ingester, type Enricher, type PairObservation } from '../attrib/ingest.js';
import { PoolVerifier, type EthCall } from '../attrib/poolVerify.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC } from '../chain/receipt.js';
import { V3_FACTORY } from '../chain/uniswap.js';
import { CLASSIFIER_VERSION } from '../attrib/taxonomy.js';

const POOL = '0x2dc56aa90f90a328e0fad9660bf01115bac2d628';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const PORT = '0x14112893f576c12f65b9f0f88e9a9a12723239b5';
const WALLET = '0x07b08ed47d69aaaad635944f55b3e4f35ebf04e4';
const OTHER = '0x2222222222222222222222222222222222222222';
const FACTORY = V3_FACTORY.toLowerCase();

const word = (v: string) => '0x' + v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const numWord = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function goodNode(counter?: { n: number }): EthCall {
  return async (to, data) => {
    if (counter) counter.n += 1;
    const t = to.toLowerCase();
    if (t === POOL) {
      if (data === '0xc45a0155') return { ok: true, result: word(FACTORY) };
      if (data === '0x0dfe1681') return { ok: true, result: word(WETH) };
      if (data === '0xd21220a7') return { ok: true, result: word(PORT) };
      if (data === '0xddca3f43') return { ok: true, result: numWord(10000) };
    }
    if (t === FACTORY) return { ok: true, result: word(POOL) };
    return { ok: true, result: '0x' };
  };
}

const obs = (txHash: string, blockNumber: number): PairObservation => ({
  txHash,
  wallet: WALLET,
  blockNumber,
  logIndex: 0,
  triggerSource: 'transfer_log',
});

/** A swap the classifier will confirm once the pool verifies. */
function swapEnricher(counter?: { n: number }): Enricher {
  return async (txHash) => {
    if (counter) counter.n += 1;
    const amt = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
    let i = 0;
    const log = (address: string, topic0: string, t1: string, t2: string, data = '0x0') => ({
      address, topic0, topic1: t1, topic2: t2, topic3: null, data, logIndex: i++,
    });
    return {
      ok: true,
      value: {
        tx: {
          txHash,
          blockNumber: 10,
          blockTimestamp: 1,
          txFrom: WALLET,
          txTo: null,
          selector: null,
          nativeValueWei: null,
          receiptStatus: '0x1',
          receiptJson: null,
          sourceHost: 'https://rpc.example.com',
        },
        ctx: {
          txHash,
          logs: [
            log(WETH, TRANSFER_TOPIC, addressToTopic(WALLET), addressToTopic(POOL), amt),
            log(PORT, TRANSFER_TOPIC, addressToTopic(POOL), addressToTopic(WALLET), amt),
            log(POOL, V3_SWAP_TOPIC, addressToTopic(OTHER), addressToTopic(WALLET)),
          ],
          wallet: WALLET,
          walletTopic: addressToTopic(WALLET).toLowerCase(),
          txTo: null,
          selector: null,
          nativeValueWei: null,
          receiptStatus: '0x1',
        },
        candidatePools: [POOL],
      },
    };
  };
}

describe('ingester — atomic per pair, idempotent on restart', () => {
  let dir: string;
  let led: AttributionLedger;
  const make = (enrich: Enricher, call: EthCall = goodNode()) =>
    new Ingester({
      ledger: led,
      verifier: new PoolVerifier(call),
      enrich,
      sourceHost: 'https://rpc.example.com',
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attrib-ing-'));
    led = new AttributionLedger(join(dir, 'l.sqlite'));
  });
  afterEach(async () => {
    led.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('every pair lands somewhere — there is no third state', () => {
    it('writes observation, tx, enrichment and attribution in ONE transaction', async () => {
      const r = await make(swapEnricher()).settlePair(obs('0xa', 10));
      expect(r.attribution?.category).toBe('swap_v3_router');
      expect(led.isAttributed({ txHash: '0xa', wallet: WALLET }, CLASSIFIER_VERSION)).toBe(true);
      expect(led.enrichment({ txHash: '0xa', wallet: WALLET })?.receipt_fetched).toBe(1);
      // Observed and attributed together: no drift.
      const acc = led.accountedFor(CLASSIFIER_VERSION);
      expect(acc.drift).toBe(0);
      expect(acc.pending).toBe(0);
    });

    it('a 429 on enrichment becomes PENDING, never a verdict', async () => {
      const failing: Enricher = async () => ({ ok: false, kind: 'rpc_http_error', detail: 'http 429' });
      const r = await make(failing).settlePair(obs('0xb', 10));
      expect(r.pending).toBe('rpc_http_error');
      expect(r.attribution).toBeNull();
      const acc = led.accountedFor(CLASSIFIER_VERSION);
      expect(acc.pending).toBe(1);
      expect(acc.attributed).toBe(0);
      expect(acc.drift).toBe(0); // observed AND accounted for, as pending
    });

    it('a THROWING enricher cannot leave the pair without an outcome', async () => {
      const boom: Enricher = async () => { throw new Error('socket hangup'); };
      const r = await make(boom).settlePair(obs('0xc', 10));
      expect(r.pending).toBe('rpc_transport_error');
      expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(0);
    });

    it('a classifier throw is a DECODE failure, not an unknown verdict', async () => {
      // Claiming "we looked and could not explain it" when we in fact crashed
      // would launder a bug into a finding about the chain.
      const bad: Enricher = async (txHash) => {
        const e = await swapEnricher()(txHash, WALLET);
        if (!e.ok) throw new Error('unreachable');
        // A delta the classifier will fail to BigInt-parse.
        return { ok: true, value: { ...e.value, extraDeltas: [
          { token: WETH, rawDelta: 'not-a-number', decimals: null, source: 'trace_native' as const },
        ] } };
      };
      const r = await make(bad).settlePair(obs('0xd', 10));
      expect(r.pending).toBe('decode_error');
      expect(led.accountedFor(CLASSIFIER_VERSION).drift).toBe(0);
    });
  });

  describe('restart / replay idempotency', () => {
    it('does not re-attribute or re-fetch a settled pair', async () => {
      const calls = { n: 0 };
      const ing = make(swapEnricher(calls));
      await ing.settlePair(obs('0xa', 10));
      const afterFirst = calls.n;

      // A fresh Ingester over a fresh verifier — i.e. a restart.
      const ing2 = make(swapEnricher(calls));
      const r = await ing2.settlePair(obs('0xa', 10));

      expect(r.skipped).toBe(true);
      expect(calls.n).toBe(afterFirst); // no second receipt fetch
      expect(led.coverage(CLASSIFIER_VERSION).reduce((s, c) => s + c.n, 0)).toBe(1);
    });

    it('does not re-request verification for a pool already settled', async () => {
      const rpc = { n: 0 };
      await make(swapEnricher(), goodNode(rpc)).settlePair(obs('0xa', 10));
      const afterFirst = rpc.n;
      expect(afterFirst).toBe(5);

      // Different tx, same pool, and a NEW verifier (restart loses the cache).
      await make(swapEnricher(), goodNode(rpc)).settlePair(obs('0xb', 11));
      // The ledger holds the settled answer, so no RPC at all.
      expect(rpc.n).toBe(afterFirst);
      expect(led.poolVerificationStats().verified).toBe(1);
    });

    it('a pending verification is retried and resolves after the throttle clears', async () => {
      const throttled: EthCall = async () => ({ ok: false, detail: 'http 429' });
      const r = await make(swapEnricher(), throttled).settlePair(obs('0xa', 10));
      expect(r.pending).toBe('verification_pending');
      expect(r.attribution).toBeNull();
      expect(led.pendingPools().has(POOL)).toBe(true);
      expect(led.poolVerificationStats()).toMatchObject({ pending: 1, unverified: 0 });
      expect(led.isAttributed({ txHash: '0xa', wallet: WALLET }, CLASSIFIER_VERSION)).toBe(false);

      // A fresh ingester represents a restart.  The receipt was already
      // observed, but verification pending is not a final answer, so the pair
      // must be attempted again and may now become a confirmed trade.
      const recovered = await make(swapEnricher(), goodNode()).settlePair(obs('0xa', 10));
      expect(recovered.attribution?.category).toBe('swap_v3_router');
      expect(led.accountedFor(CLASSIFIER_VERSION)).toMatchObject({ attributed: 1, pending: 0, drift: 0 });
    });

    it('retries one pending pool once per batch instead of five calls per pair', async () => {
      const rpc = { n: 0 };
      const throttled: EthCall = async () => {
        rpc.n += 1;
        return { ok: false, detail: 'http 429' };
      };
      const s = await make(swapEnricher(), throttled).ingestBatch(
        [obs('0xa', 10), obs('0xb', 11)],
        20,
      );
      expect(rpc.n).toBe(1);
      expect(s.pending).toBe(2);
      expect(s.verificationClaimsSuppressed).toBe(1);
    });

    it('replaying the whole batch twice yields identical coverage', async () => {
      const batch = [obs('0xa', 10), obs('0xb', 11)];
      await make(swapEnricher()).ingestBatch(batch, 20);
      const first = led.coverage(CLASSIFIER_VERSION);
      const s2 = await make(swapEnricher()).ingestBatch(batch, 20);
      expect(led.coverage(CLASSIFIER_VERSION)).toEqual(first);
      expect(s2.skippedAlreadyAttributed).toBe(2);
    });
  });

  describe('the cursor is held by the OLDEST unresolved pair', () => {
    it('never leaps past pending work', async () => {
      // Block 100 fails, block 200 succeeds. Advancing to 200 would mean
      // nothing ever revisits 100 — a 429 turned into permanent invisibility.
      const selective: Enricher = async (txHash, wallet) =>
        txHash === '0xfail'
          ? { ok: false, kind: 'rpc_http_error', detail: 'http 429' }
          : swapEnricher()(txHash, wallet);

      const s = await make(selective).ingestBatch(
        [obs('0xfail', 100), obs('0xok', 200)],
        300,
      );
      expect(s.attributed).toBe(1);
      expect(s.pending).toBe(1);
      expect(s.heldAtBlock).toBe(100);
      expect(s.safeThroughBlock).toBe(99);
    });

    it('advances fully when nothing is unresolved', async () => {
      const s = await make(swapEnricher()).ingestBatch([obs('0xa', 10)], 300);
      expect(s.heldAtBlock).toBeNull();
      expect(s.safeThroughBlock).toBe(300);
    });

    it('work parked by an EARLIER run still holds the cursor', async () => {
      // A restart that only looked at its own batch would advance past a pair
      // it never retried.
      const failing: Enricher = async () => ({ ok: false, kind: 'rpc_http_error', detail: '429' });
      await make(failing).ingestBatch([obs('0xold', 50)], 60);

      const s = await make(swapEnricher()).ingestBatch([obs('0xnew', 200)], 300);
      expect(s.pending).toBe(0); // nothing failed in THIS batch
      expect(s.heldAtBlock).toBe(50); // but the old pair still holds it
      expect(s.safeThroughBlock).toBe(49);
    });

    it('releases the hold once the pending pair resolves', async () => {
      const failing: Enricher = async () => ({ ok: false, kind: 'rpc_http_error', detail: '429' });
      await make(failing).ingestBatch([obs('0xa', 50)], 60);
      expect((await make(failing).ingestBatch([], 300)).safeThroughBlock).toBe(49);

      await make(swapEnricher()).settlePair(obs('0xa', 50)); // retry succeeds
      const s = await make(swapEnricher()).ingestBatch([], 300);
      expect(s.heldAtBlock).toBeNull();
      expect(s.safeThroughBlock).toBe(300);
    });

    it('crash after receipt retrieval rolls back, then recovers exactly once', async () => {
      const key = { txHash: '0xcrash', wallet: WALLET };
      const original = led.recordAttribution.bind(led);
      // Force the failure after enrich/classify but inside the outer ledger
      // transaction.  No half-written tx/enrichment/delta rows may survive it.
      led.recordAttribution = (() => {
        throw new Error('simulated process crash during ledger write');
      }) as typeof led.recordAttribution;

      const first = await make(swapEnricher()).settlePair(obs('0xcrash', 50));
      expect(first.pending).toBe('ledger_write_error');
      expect(led.accountedFor(CLASSIFIER_VERSION)).toMatchObject({ attributed: 0, pending: 1, drift: 0 });
      expect(led.enrichment(key)?.receipt_fetched).toBe(0);

      led.recordAttribution = original;
      const recovered = await make(swapEnricher()).settlePair(obs('0xcrash', 50));
      expect(recovered.attribution?.category).toBe('swap_v3_router');
      expect(led.accountedFor(CLASSIFIER_VERSION)).toMatchObject({ attributed: 1, pending: 0, drift: 0 });
      expect(led.coverage(CLASSIFIER_VERSION).reduce((sum, row) => sum + row.n, 0)).toBe(1);
    });
  });
});

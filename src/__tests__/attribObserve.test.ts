import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionLedger } from '../attrib/ledger.js';
import { HyperSyncClient } from '../chain/hypersync.js';
import {
  observeUniverse,
  observeSenderTransactions,
  observeRecipientTransactions,
  observeTransferLogs,
  STREAM_SENDER,
  STREAM_RECIPIENT,
  STREAM_TRANSFERS,
} from '../attrib/observe.js';
import { CLASSIFIER_VERSION } from '../attrib/taxonomy.js';
import { TRANSFER_TOPIC, addressToTopic } from '../chain/decoder.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x4444444444444444444444444444444444444444';
const watched = new Set([W1, W2]);

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/**
 * Fake endpoint honouring HyperSync's PROVEN semantics: filters inside one
 * object are ANDed, separate objects are ORed. Measured on chain 4663.
 */
function endpoint(opts: {
  txs?: { hash: string; from: string; to: string; block_number: number; value?: string }[];
  logs?: {
    transaction_hash: string;
    topic1: string;
    topic2: string;
    block_number: number;
    log_index: number;
  }[];
  /** Force every sweep to stop here, simulating truncation. */
  stopAt?: number;
}) {
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/height')) {
      return { ok: true, json: async () => ({ height: 10_000 }) } as unknown as Response;
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const fromB: number = body.from_block ?? 0;
    const toB: number = body.to_block ?? 0;
    const stop = opts.stopAt ?? toB;
    const within = (b: number) => b >= fromB && b < stop;

    let transactions: unknown[] = [];
    if (body.transactions) {
      for (const f of body.transactions as { from?: string[]; to?: string[] }[]) {
        for (const t of opts.txs ?? []) {
          if (!within(t.block_number)) continue;
          // AND within one filter object — the proven behaviour.
          if (f.from && !f.from.includes(t.from)) continue;
          if (f.to && !f.to.includes(t.to)) continue;
          transactions.push({ ...t, value: t.value ?? '0x0' });
        }
      }
      transactions = [...new Map(transactions.map((t) => [(t as { hash: string }).hash, t])).values()];
    }

    let logs: unknown[] = [];
    if (body.logs) {
      for (const f of body.logs as { topics?: string[][] }[]) {
        for (const l of opts.logs ?? []) {
          if (!within(l.block_number)) continue;
          const t = f.topics ?? [];
          if (t[0]?.length && !t[0].includes(TRANSFER_TOPIC)) continue;
          if (t[1]?.length && !t[1].includes(l.topic1)) continue;
          if (t[2]?.length && !t[2].includes(l.topic2)) continue;
          logs.push({ ...l, topic0: TRANSFER_TOPIC, address: TOKEN });
        }
      }
      logs = [...new Map(logs.map((l) => [`${(l as { transaction_hash: string }).transaction_hash}:${(l as { log_index: number }).log_index}`, l])).values()];
    }

    return {
      ok: true,
      json: async () => ({
        data: [{ transactions, logs }],
        next_block: stop,
        rollback_guard: { block_number: stop - 1, hash: '0xhash', first_block_number: fromB },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const client = () => new HyperSyncClient({ url: 'https://hs.test', token: 'tok', op: 'obs' });

describe('observation — establishing the coverage universe', () => {
  let dir: string;
  let led: AttributionLedger;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attrib-obs-'));
    led = new AttributionLedger(join(dir, 'l.sqlite'));
  });
  afterEach(async () => {
    led.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('watched wallet -> router is discovered as tx_sender', async () => {
    endpoint({ txs: [{ hash: '0xa', from: W1, to: ROUTER, block_number: 100 }] });
    const r = await observeSenderTransactions(client(), led, watched, 0, 1000);
    expect(r!.written).toBe(1);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('router/EOA -> watched wallet is discovered as tx_recipient', async () => {
    endpoint({ txs: [{ hash: '0xb', from: STRANGER, to: W1, block_number: 100 }] });
    const r = await observeRecipientTransactions(client(), led, watched, 0, 1000);
    expect(r!.written).toBe(1);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('REGRESSION: a combined {from,to} filter would find NOTHING — streams stay separate', async () => {
    // Proven on chain 4663: filters inside ONE object are ANDed, so
    // {from:[watched], to:[watched]} matches only wallet-to-wallet and returned
    // 0 over a 20k-block window while looking like full coverage.
    endpoint({
      txs: [
        { hash: '0xsent', from: W1, to: ROUTER, block_number: 100 },
        { hash: '0xrecv', from: STRANGER, to: W2, block_number: 101 },
      ],
    });
    const hs = client();
    // The trap: one object, both filters.
    const anded = await hs.sweep(
      0,
      1000,
      { transactions: [{ from: [...watched], to: [...watched] }], field_selection: { transaction: ['hash'] } },
      (res) => (res.data ?? []).flatMap((d) => d.transactions ?? []),
    );
    expect(anded!.items).toHaveLength(0); // silently nothing

    // Two streams find both.
    await observeSenderTransactions(hs, led, watched, 0, 1000);
    await observeRecipientTransactions(hs, led, watched, 0, 1000);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(2);
  });

  it('watched -> watched yields ONE pair per involved watched wallet', async () => {
    endpoint({
      txs: [{ hash: '0xww', from: W1, to: W2, block_number: 100 }],
      logs: [
        {
          transaction_hash: '0xww',
          topic1: addressToTopic(W1).toLowerCase(),
          topic2: addressToTopic(W2).toLowerCase(),
          block_number: 100,
          log_index: 0,
        },
      ],
    });
    await observeUniverse(client(), led, watched, 0, 1000);
    // Two distinct pairs — each wallet has its own economic story to answer for.
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(2);
  });

  it('an unrelated transaction never enters the universe', async () => {
    endpoint({
      txs: [{ hash: '0xnope', from: STRANGER, to: ROUTER, block_number: 100 }],
      logs: [
        {
          transaction_hash: '0xnope',
          topic1: addressToTopic(STRANGER).toLowerCase(),
          topic2: addressToTopic(ROUTER).toLowerCase(),
          block_number: 100,
          log_index: 0,
        },
      ],
    });
    await observeUniverse(client(), led, watched, 0, 1000);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(0);
  });

  it('a tx found by BOTH streams is one pair with multiple observations', async () => {
    endpoint({
      txs: [{ hash: '0xboth', from: W1, to: ROUTER, block_number: 100 }],
      logs: [
        {
          transaction_hash: '0xboth',
          topic1: addressToTopic(ROUTER).toLowerCase(),
          topic2: addressToTopic(W1).toLowerCase(),
          block_number: 100,
          log_index: 7,
        },
      ],
    });
    const u = await observeUniverse(client(), led, watched, 0, 1000);
    // Two observation ROWS (log_index -1 and 7) …
    expect((u.sender!.written ?? 0) + (u.transfers!.written ?? 0)).toBe(2);
    // … collapsing to ONE canonical pair.
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });

  it('REGRESSION: a partial sweep contributes nothing beyond its own covered block', async () => {
    // The endpoint stops at 500 though 1000 was requested.
    endpoint({
      txs: [
        { hash: '0xin', from: W1, to: ROUTER, block_number: 100 },
        { hash: '0xout', from: W1, to: ROUTER, block_number: 900 },
      ],
      stopAt: 500,
    });
    const r = await observeSenderTransactions(client(), led, watched, 0, 1000);
    expect(r!.covered).toBe(500);
    expect(r!.truncated).toBe(true);
    expect(r!.written).toBe(1); // only the block-100 tx
    expect(led.cursors()[STREAM_SENDER]).toBe(500); // cursor never claims 1000
  });

  it('safeCovered is the MINIMUM across streams, never the furthest', async () => {
    endpoint({ txs: [{ hash: '0xa', from: W1, to: ROUTER, block_number: 10 }], stopAt: 400 });
    const u = await observeUniverse(client(), led, watched, 0, 1000);
    expect(u.safeCovered).toBe(400);
    expect(u.anyTruncated).toBe(true);
  });

  it('a totally failed stream drops safeCovered to before the window', async () => {
    // Nothing was established, so nothing may be claimed.
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/height')) {
        return { ok: true, json: async () => ({ height: 10_000 }) } as unknown as Response;
      }
      return { ok: false, status: 429, statusText: 'rate limited' } as unknown as Response;
    }) as unknown as typeof fetch;
    const u = await observeUniverse(client(), led, watched, 100, 1000);
    expect(u.safeCovered).toBe(99);
    expect(u.anyTruncated).toBe(true);
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(0);
  });

  it('records a checkpoint hash per stream for continuity', async () => {
    endpoint({ txs: [{ hash: '0xa', from: W1, to: ROUTER, block_number: 10 }] });
    await observeUniverse(client(), led, watched, 0, 1000);
    for (const s of [STREAM_SENDER, STREAM_RECIPIENT, STREAM_TRANSFERS]) {
      expect(led.latestCheckpoint(s)?.block_hash).toBe('0xhash');
    }
  });

  it('re-observing the same range is idempotent', async () => {
    endpoint({ txs: [{ hash: '0xa', from: W1, to: ROUTER, block_number: 100 }] });
    const hs = client();
    await observeSenderTransactions(hs, led, watched, 0, 1000);
    const second = await observeSenderTransactions(hs, led, watched, 0, 1000);
    expect(second!.written).toBe(0); // already claimed
    expect(led.accountedFor(CLASSIFIER_VERSION).pairs).toBe(1);
  });
});

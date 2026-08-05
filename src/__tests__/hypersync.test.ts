import { describe, it, expect, afterEach } from 'vitest';
import { HyperSyncClient } from '../chain/hypersync.js';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/** Scripted endpoint: each entry is one page's response. */
function stub(pages: ({ next_block?: number; logs?: unknown[] } | { status: number })[]) {
  let i = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith('/height')) {
      return { ok: true, json: async () => ({ height: 5000 }) } as unknown as Response;
    }
    const p = pages[Math.min(i++, pages.length - 1)]!;
    if ('status' in p) {
      return { ok: false, status: p.status, statusText: 'err' } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ data: [{ logs: p.logs ?? [] }], next_block: p.next_block }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const client = (onFailure?: Parameters<typeof HyperSyncClient.prototype.constructor>[0]) =>
  new HyperSyncClient({ url: 'https://hs.example.com', token: 'tok', op: 'test' });

describe('HyperSyncClient — the pagination contract', () => {
  it('follows next_block to completion and reports full coverage', () => {
    stub([
      { next_block: 300, logs: [{ topic0: '0xa' }] },
      { next_block: 700, logs: [{ topic0: '0xb' }] },
      { next_block: 1000, logs: [{ topic0: '0xc' }] },
    ]);
    return client()
      .sweepLogs(0, 1000, [{}])
      .then((r) => {
        expect(r).not.toBeNull();
        expect(r!.covered).toBe(1000);
        expect(r!.truncated).toBe(false);
        expect(r!.items).toHaveLength(3);
        expect(r!.pages).toBe(3);
      });
  });

  it('REGRESSION: reports the SHORTFALL when the endpoint stops advancing', async () => {
    // The measured failure: a swap-log query over 1000 blocks stopped at 261
    // while a transfer query over the same range covered all 1000. A caller that
    // reads the shortfall as "no logs here" silently loses 739 blocks.
    stub([{ next_block: 261, logs: [{ topic0: '0xa' }] }, { next_block: 261 }]);
    const r = await client().sweepLogs(0, 1000, [{}]);
    expect(r!.covered).toBe(261);
    expect(r!.truncated).toBe(true);
  });

  it('treats a missing next_block as the end of what was covered', async () => {
    stub([{ logs: [{ topic0: '0xa' }] }]);
    const r = await client().sweepLogs(0, 1000, [{}]);
    expect(r!.covered).toBe(0);
    expect(r!.truncated).toBe(true);
  });

  it('returns partial coverage when a mid-sweep page fails', async () => {
    stub([{ next_block: 400, logs: [{ topic0: '0xa' }] }, { status: 429 }]);
    const r = await client().sweepLogs(0, 1000, [{}]);
    expect(r!.covered).toBe(400); // exactly what page 1 achieved
    expect(r!.truncated).toBe(true);
    expect(r!.items).toHaveLength(1);
  });

  it('returns null — not empty — when the FIRST page fails', async () => {
    // Zero logs and "we never got an answer" must never look the same.
    stub([{ status: 429 }]);
    expect(await client().sweepLogs(0, 1000, [{}])).toBeNull();
  });

  it('reports failures to the sink as well as the log', async () => {
    stub([{ status: 429 }]);
    const seen: string[] = [];
    const c = new HyperSyncClient({
      url: 'https://hs.example.com',
      token: 'tok',
      op: 'test',
      onFailure: (f) => seen.push(`${f.kind}:${f.status}`),
    });
    await c.sweepLogs(0, 1000, [{}]);
    expect(seen).toContain('http:429');
  });

  it('a throwing failure sink cannot break the fetch path', async () => {
    stub([{ status: 500 }]);
    const c = new HyperSyncClient({
      url: 'https://hs.example.com',
      token: 'tok',
      op: 'test',
      onFailure: () => {
        throw new Error('sink exploded');
      },
    });
    await expect(c.sweepLogs(0, 1000, [{}])).resolves.toBeNull();
  });

  it('is INERT without a token, because HyperSync answers 401', async () => {
    // Unauthenticated, the old `!res.ok -> null` handling reported "0 logs"
    // rather than "unauthorized" — a confident zero manufactured from an auth
    // error. Refusing to query at all is the honest failure.
    const c = new HyperSyncClient({ url: 'https://hs.example.com', token: '', op: 'test' });
    expect(c.enabled).toBe(false);
    expect(await c.height()).toBeNull();
    expect(await c.sweepLogs(0, 1000, [{}])).toBeNull();
  });

  it('honours the page cap as a runaway backstop', async () => {
    // An endpoint advancing one block at a time must not spin forever.
    let n = 0;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ logs: [] }], next_block: ++n }),
    })) as unknown as typeof fetch;
    const c = new HyperSyncClient({
      url: 'https://hs.example.com',
      token: 'tok',
      op: 'test',
      maxPages: 5,
    });
    const r = await c.sweepLogs(0, 1_000_000, [{}]);
    expect(r!.pages).toBe(5);
    expect(r!.truncated).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// buildSwapFromLog reaches the network twice (receipt confirmation + token
// metadata). Stub both so a synthetic Transfer log decodes into a real swap —
// these tests are about the SCAN LOOP, not about decoding.
vi.mock('../chain/receipt.js', () => ({
  receiptConfirmsSwap: async () => true,
  receiptDiagnostic: () => undefined,
}));
vi.mock('../chain/metadata.js', () => ({
  fetchTokenMetadata: async () => ({ decimals: 18, symbol: 'TEST' }),
}));

const { HttpPollingChainListener } = await import('../chain/listener.js');
const { addressToTopic, TRANSFER_TOPIC } = await import('../chain/decoder.js');
const { MemoryStore } = await import('../store/memory.js');
const { loadFeedState, saveFeedState, FEED_STATE_VERSION } = await import('../store/feedState.js');
import type { SwapEvent, TrackedToken } from '../types.js';

function stubPrice() {
  return {
    usdValue: () => 100,
    isLive: () => true,
    sourceOf: () => 'dexscreener',
    dexUrl: () => 'x',
    start() {},
    stop() {},
  } as unknown as import('../chain/price.js').PriceOracle;
}

const TOKEN = '0x1111111111111111111111111111111111111111';

/** A Transfer log moving `TOKEN` INTO a tracked wallet (i.e. a buy). */
function transferLog(to: string, blockNumber: number, txHash: string, logIndex = '0x0') {
  return {
    address: TOKEN,
    topics: [
      TRANSFER_TOPIC,
      addressToTopic('0x2222222222222222222222222222222222222222'),
      addressToTopic(to),
    ],
    data: '0x' + (10n ** 18n).toString(16).padStart(64, '0'),
    blockNumber: '0x' + blockNumber.toString(16),
    transactionHash: txHash,
    logIndex,
  };
}

/**
 * Drive the polling listener with a scripted RPC. Returns the listener plus the
 * recorded eth_getLogs ranges, which is what proves a range was or was not
 * rescanned.
 */
function harness(
  build: (wallet: string) => {
    head: number | (() => number);
    getLogs: (call: number, from: number, to: number) => unknown;
  },
) {
  const store = new MemoryStore();
  const wallet = [...store.wallets.keys()][0]!;
  const script = build(wallet);
  const swaps: SwapEvent[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  let getLogsCalls = 0;

  const rpc = async (method: string, params: unknown[]) => {
    if (method === 'eth_blockNumber') {
      const h = typeof script.head === 'function' ? script.head() : script.head;
      return '0x' + h.toString(16);
    }
    if (method === 'eth_getLogs') {
      const p = (params as Array<{ fromBlock: string; toBlock: string }>)[0]!;
      const from = Number(BigInt(p.fromBlock));
      const to = Number(BigInt(p.toBlock));
      // Two calls per range (buy side + sell side); record the range once.
      if (getLogsCalls % 2 === 0) ranges.push({ from, to });
      const result = script.getLogs(Math.floor(getLogsCalls / 2), from, to);
      getLogsCalls += 1;
      return result;
    }
    return null;
  };

  const listener = new HttpPollingChainListener(store, stubPrice(), (s) => swaps.push(s), rpc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = listener as any;
  inner.walletTopics = [...store.wallets.keys()].map(addressToTopic);
  return {
    store,
    wallet,
    swaps,
    ranges,
    listener,
    /** Seed the cursor without starting the real interval. */
    setCursor: (n: number) => {
      inner.lastBlock = n;
    },
    cursor: () => inner.lastBlock as number,
    /** Simulate the backoff wall-clock having elapsed. */
    clearBackoff: () => {
      inner.backoffUntil = 0;
    },
    poll: () => inner.poll() as Promise<void>,
  };
}

describe('feed durability — atomic cursor advancement', () => {
  it('REGRESSION: a failed eth_getLogs does not skip the block range', async () => {
    const h = harness(() => ({
      head: 1_050,
      // Every call fails. Under the old code `null` folded to `[]` and the
      // cursor advanced anyway, permanently losing 1001-1050.
      getLogs: () => null,
    }));
    h.setCursor(1_000);

    await h.poll();

    expect(h.cursor()).toBe(1_000); // held, NOT advanced to 1050
    expect(h.ranges).toEqual([{ from: 1_001, to: 1_050 }]);
    expect(h.store.metrics.consecutiveFailures).toBe(1);
    expect(h.store.metrics.cursor).toBe(1_000);
  });

  it('REGRESSION: the failed range is retried, and processed exactly once', async () => {
    let attempt = 0;
    const h = harness((wallet) => ({
      head: 1_050,
      getLogs: (call, from, to) => {
        attempt = call;
        // First range attempt fails; the retry succeeds with one swap in it.
        if (call === 0) return null;
        return from <= 1_010 && to >= 1_010 ? [transferLog(wallet, 1_010, '0xaaa')] : [];
      },
    }));
    h.setCursor(1_000);

    await h.poll(); // fails
    expect(h.cursor()).toBe(1_000);

    h.clearBackoff();
    await h.poll(); // retry

    // The SAME range was requested again — this is the assertion that fails if
    // the cursor ever advances on error.
    expect(h.ranges).toEqual([
      { from: 1_001, to: 1_050 },
      { from: 1_001, to: 1_050 },
    ]);
    expect(h.cursor()).toBe(1_050); // advanced only after success
    expect(h.store.metrics.consecutiveFailures).toBe(0);
    expect(attempt).toBe(1);

    // And it is never scanned a third time.
    h.clearBackoff();
    await h.poll();
    expect(h.ranges.filter((r) => r.from === 1_001)).toHaveLength(2);
  });

  it('emits each log exactly once across a failure and its retry', async () => {
    const h = harness((wallet) => ({
      head: 1_010,
      getLogs: (call) => {
        if (call === 0) return null; // the fetch for this range fails
        return [transferLog(wallet, 1_005, '0xdead')];
      },
    }));
    h.setCursor(1_000);

    await h.poll();
    expect(h.swaps).toHaveLength(0); // nothing emitted from a failed range

    h.clearBackoff();
    await h.poll();

    // The retry decodes it once. Both getLogs sides return the same log, and the
    // in-range dedupe (txHash:logIndex) collapses them.
    expect(h.swaps).toHaveLength(1);
    expect(h.swaps[0]!.txHash).toBe('0xdead');
    expect(h.cursor()).toBe(1_010);
  });

  it('a PARTIAL failure (one side of the pair) emits nothing and holds the cursor', async () => {
    let n = 0;
    const store = new MemoryStore();
    const wallet = [...store.wallets.keys()][0]!;
    const swaps: SwapEvent[] = [];
    const rpc = async (method: string) => {
      if (method === 'eth_blockNumber') return '0x' + (1_010).toString(16);
      if (method === 'eth_getLogs') {
        n += 1;
        // buy side returns real logs, sell side times out (null)
        return n === 1 ? [transferLog(wallet, 1_005, '0xbeef')] : null;
      }
      return null;
    };
    const listener = new HttpPollingChainListener(store, stubPrice(), (s) => swaps.push(s), rpc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = listener as any;
    inner.walletTopics = [...store.wallets.keys()].map(addressToTopic);
    inner.lastBlock = 1_000;

    await inner.poll();

    // Half the answer is not an answer: emitting the buy side and advancing would
    // both lose the sell side AND double-emit the buy side on any later rescan.
    expect(swaps).toHaveLength(0);
    expect(inner.lastBlock).toBe(1_000);
  });

  it('backs off with bounded, increasing delay and narrows the range', async () => {
    const h = harness(() => ({ head: 20_000, getLogs: () => null }));
    h.setCursor(1_000);

    await h.poll();
    const firstWidth = h.ranges[0]!.to - h.ranges[0]!.from;

    h.clearBackoff();
    await h.poll();
    const secondWidth = h.ranges[1]!.to - h.ranges[1]!.from;

    expect(h.store.metrics.consecutiveFailures).toBe(2);
    // Adaptive narrowing: a range the RPC cannot serve is retried smaller, so
    // "never skip" terminates instead of retrying the same doomed width forever.
    expect(secondWidth).toBeLessThan(firstWidth);
    expect(h.cursor()).toBe(1_000);
  });

  it('a successful scan clears the failure counter and records lag + timestamp', async () => {
    let fail = true;
    const h = harness(() => ({
      head: 1_010,
      getLogs: () => (fail ? null : []),
    }));
    h.setCursor(1_000);

    await h.poll();
    expect(h.store.metrics.consecutiveFailures).toBe(1);

    fail = false;
    h.clearBackoff();
    await h.poll();

    expect(h.store.metrics.consecutiveFailures).toBe(0);
    expect(h.store.metrics.cursor).toBe(1_010);
    expect(h.store.metrics.cursorLag).toBe(0);
    expect(h.store.metrics.lastScanAt).toBeGreaterThan(0);
  });
});

describe('feed durability — snapshot persistence', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'feedstate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const token = (over: Partial<TrackedToken> = {}): TrackedToken => ({
    address: '0xabc0000000000000000000000000000000000001',
    symbol: 'NEW',
    name: 'New',
    totalSupply: 1_000_000_000,
    supplyVerified: false,
    stable: false,
    discovered: true,
    firstSeen: 1_700_000_000_000,
    ...over,
  });

  it('round-trips cursor, tokens and history', async () => {
    const path = join(dir, 'feed-state.json');
    await saveFeedState(path, {
      cursor: 28_700_000,
      tokens: [token()],
      swarms: [],
      alerts: [],
    });

    const back = await loadFeedState(path);
    expect(back).not.toBeNull();
    expect(back!.version).toBe(FEED_STATE_VERSION);
    expect(back!.cursor).toBe(28_700_000);
    expect(back!.tokens).toHaveLength(1);
    expect(back!.tokens[0]!.symbol).toBe('NEW');
  });

  it('writes atomically — no .tmp file survives a completed save', async () => {
    const path = join(dir, 'feed-state.json');
    await saveFeedState(path, { cursor: 1, tokens: [], swarms: [], alerts: [] });
    const files = await readdir(dir);
    expect(files).toContain('feed-state.json');
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('returns null for a missing file (cold start, not a crash)', async () => {
    expect(await loadFeedState(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', async () => {
    const path = join(dir, 'corrupt.json');
    await writeFile(path, '{"cursor": 123, "tokens": [');
    expect(await loadFeedState(path)).toBeNull();
  });

  it('discards a snapshot from an unknown schema version', async () => {
    const path = join(dir, 'v99.json');
    await writeFile(path, JSON.stringify({ version: 99, cursor: 5, tokens: [] }));
    expect(await loadFeedState(path)).toBeNull();
  });

  it('discards a snapshot whose cursor is not a usable block number', async () => {
    const path = join(dir, 'bad-cursor.json');
    await writeFile(
      path,
      JSON.stringify({ version: FEED_STATE_VERSION, cursor: 'soon', tokens: [] }),
    );
    expect(await loadFeedState(path)).toBeNull();
  });

  it('drops malformed token entries but keeps the good ones', async () => {
    const path = join(dir, 'mixed.json');
    await writeFile(
      path,
      JSON.stringify({
        version: FEED_STATE_VERSION,
        cursor: 10,
        tokens: [token(), { address: 'not-an-address' }, null, { symbol: 'NOADDR' }],
      }),
    );
    const back = await loadFeedState(path);
    expect(back!.tokens).toHaveLength(1);
  });

  it('never restores an unverified supply as verified', async () => {
    const path = join(dir, 'supply.json');
    await writeFile(
      path,
      JSON.stringify({
        version: FEED_STATE_VERSION,
        cursor: 10,
        // supplyVerified absent entirely — must read as false, or the oracle
        // would treat the 1e9 placeholder as a measured supply.
        tokens: [{ address: token().address, symbol: 'X', totalSupply: 1e9 }],
      }),
    );
    const back = await loadFeedState(path);
    expect(back!.tokens[0]!.supplyVerified).toBe(false);
  });

  it('no-ops on an empty path (persistence disabled)', async () => {
    await expect(saveFeedState('', { cursor: 1, tokens: [], swarms: [], alerts: [] })).resolves.toBeUndefined();
    expect(await loadFeedState('')).toBeNull();
  });
});

describe('feed durability — resume and bounded backfill', () => {
  /** Run init() against a scripted head, then stop the interval it starts. */
  async function boot(head: number, resumeFrom: number | null) {
    const store = new MemoryStore();
    const rpc = async (method: string) =>
      method === 'eth_blockNumber' ? '0x' + head.toString(16) : null;
    const listener = new HttpPollingChainListener(store, stubPrice(), () => {}, rpc);
    if (resumeFrom != null) listener.resumeAt(resumeFrom);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = listener as any;
    inner.walletTopics = [];
    await inner.init();
    listener.stop();
    return { store, listener, cursor: inner.lastBlock as number };
  }

  it('a cold start begins at the chain head', async () => {
    const { cursor } = await boot(28_700_000, null);
    expect(cursor).toBe(28_700_000);
  });

  it('resumes from the persisted cursor instead of the head', async () => {
    const { cursor, store } = await boot(28_700_100, 28_700_000);
    // This is the restart-blindness fix: without it the cursor would jump to the
    // head and the 100 intervening blocks would never be scanned.
    expect(cursor).toBe(28_700_000);
    expect(store.metrics.cursorLag).toBe(100);
  });

  it('clamps a cursor that is too far behind, and reports the skip', async () => {
    const head = 30_000_000;
    const { cursor, store } = await boot(head, 1_000);
    expect(cursor).toBe(head - 50_000); // FEED_MAX_BACKFILL_BLOCKS
    // The skip is surfaced, not silent — a nonzero value here means blocks were
    // genuinely abandoned and detection for them is gone.
    expect(store.metrics.skippedBlocks).toBeGreaterThan(0);
  });

  it('falls back to the head when the snapshot cursor is ahead of the chain', async () => {
    const { cursor } = await boot(1_000, 9_999_999);
    expect(cursor).toBe(1_000);
  });

  it('keeps the resumed cursor when the head is unreadable at boot', async () => {
    const store = new MemoryStore();
    const listener = new HttpPollingChainListener(store, stubPrice(), () => {}, async () => null);
    listener.resumeAt(28_700_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = listener as any;
    await inner.init();
    listener.stop();
    // Falling back to 0 here would make the first good poll try to scan the
    // entire chain from genesis.
    expect(inner.lastBlock).toBe(28_700_000);
  });
});

describe('feed durability — store restore semantics', () => {
  it('imports tokens without clobbering live entries', async () => {
    const store = new MemoryStore();
    const before = store.tokensByAddress.size;
    const added = store.importTokens([
      {
        address: '0xfeed000000000000000000000000000000000001',
        symbol: 'RESTORED',
        name: 'Restored',
        totalSupply: 1_000_000_000,
        supplyVerified: false,
        discovered: true,
        firstSeen: 1,
      },
    ]);
    expect(added).toBe(1);
    expect(store.tokensByAddress.size).toBe(before + 1);

    // Re-importing the same token is a no-op, not a duplicate.
    expect(store.importTokens([...store.exportDiscoveredTokens()])).toBe(0);
  });

  it('exports only discovered tokens (the seed set rebuilds itself)', async () => {
    const store = new MemoryStore();
    store.ensureToken('0xfeed000000000000000000000000000000000002', 'DISCO');
    const exported = store.exportDiscoveredTokens();
    expect(exported.every((t) => t.discovered === true)).toBe(true);
    expect(exported.some((t) => t.symbol === 'DISCO')).toBe(true);
  });

  it('restoreHistory does NOT re-emit alerts — a replayed alert is a duplicate buy', async () => {
    const store = new MemoryStore();
    const emitted: unknown[] = [];
    store.on('alert', (a) => emitted.push(a));
    store.on('swarm', (s) => emitted.push(s));

    store.restoreHistory(
      [{ id: 's1', token: '0xt', tokenSymbol: 'X' } as never],
      [{ id: 'a1', swarm: { id: 's1' } } as never],
    );

    // Present for display…
    expect(store.recentAlerts(10)).toHaveLength(1);
    expect(store.recentSwarms(10)).toHaveLength(1);
    // …but nothing went down the SSE stream to the sniper.
    expect(emitted).toHaveLength(0);
    // And they are not counted as work this process did.
    expect(store.totals.alerts).toBe(0);
  });
});

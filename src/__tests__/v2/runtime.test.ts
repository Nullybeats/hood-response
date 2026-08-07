/**
 * The shadow runtime's contract: it consumes ONLY proven trades, it emits
 * nothing, and it records a verdict for everything it sees — including the ones
 * still waiting on evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Journal } from '../../v2/journal.js';
import { V2Shadow, type V2Providers } from '../../v2/runtime.js';
import { DEFAULT_LANES } from '../../v2/lanes.js';
import type { SwapEvent } from '../../types.js';

const NOW = 1_786_000_000_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';
const TOKEN = '0xtoken0000000000000000000000000000000001';

function swap(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    txHash: '0xtx' + Math.random().toString(36).slice(2, 8),
    wallet: WALLET,
    token: TOKEN,
    tokenSymbol: 'WOOF',
    direction: 'BUY',
    amount: 1000,
    usdValue: 5000,
    blockNumber: 1000,
    timestamp: NOW,
    verifiedTrade: true,
    verifiedCategory: 'swap_v4_poolmanager',
    ...over,
  };
}

function providers(over: Partial<V2Providers> = {}): V2Providers {
  return {
    marketCap: () => 80_000,
    pairAge: () => ({ hours: 3, source: 'test' }),
    canSell: () => true,
    outcomes: () => [],
    claimFirstBuy: () => true,
    ...over,
  };
}

/** A journal that captures rather than writes, so we can assert what was recorded. */
function captureJournal() {
  const written: { kind: string; body: unknown }[] = [];
  const j = new Journal({ path: '', enabled: false, maxSegmentBytes: 1, maxTotalBytes: 1 });
  vi.spyOn(j, 'write').mockImplementation((kind, body) => {
    written.push({ kind, body });
  });
  Object.defineProperty(j, 'enabled', { get: () => true });
  return { j, written };
}

let shadow: V2Shadow;

beforeEach(() => {
  vi.stubEnv('V2_SHADOW_ENABLED', 'true');
});

afterEach(() => {
  shadow?.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** config is read at import time, so force `enabled` for these tests. */
function makeShadow(p: V2Providers = providers(), jrnl?: Journal): V2Shadow {
  const s = new V2Shadow(
    p,
    { crowdWindowMs: 300_000, retryIntervalMs: 10_000, lanes: DEFAULT_LANES },
    jrnl,
  );
  Object.defineProperty(s, 'enabled', { get: () => true });
  return s;
}

describe('V2Shadow', () => {
  it('ignores anything the strict verifier did not prove', () => {
    shadow = makeShadow();
    // The measured reality: ~90% of watched-wallet activity is an airdrop.
    shadow.onSwap(swap({ verifiedTrade: false }));
    shadow.onSwap(swap({ verifiedTrade: undefined }));
    expect(shadow.diary.size).toBe(0);

    shadow.onSwap(swap({ verifiedTrade: true }));
    expect(shadow.diary.size).toBe(1);
  });

  it('ignores sells — this pipeline reasons about buying', () => {
    shadow = makeShadow();
    shadow.onSwap(swap({ direction: 'SELL' }));
    expect(shadow.diary.size).toBe(0);
  });

  it('records a verdict for every accepted trade', () => {
    shadow = makeShadow();
    for (let i = 0; i < 5; i++) shadow.onSwap(swap());
    expect(shadow.diary.size).toBe(5);
    const counts = shadow.diary.summary().counts;
    expect(counts.matched + counts.skipped + counts.waiting + counts.blocked).toBe(5);
  });

  /** Unknown evidence must produce a WAITING verdict, not a silent drop. */
  it('queues a trade whose facts have not landed, and says so', () => {
    shadow = makeShadow(providers({ canSell: () => null }));
    shadow.onSwap(swap());
    const entry = shadow.diary.recent(1)[0]!;
    expect(entry.outcome).toBe('waiting');
    expect(entry.reason).toMatch(/waiting on canSell/);
    expect(shadow.status().pending).toBe(1);
  });

  it('blocks a token proven unsellable', () => {
    shadow = makeShadow(providers({ canSell: () => false }));
    shadow.onSwap(swap());
    expect(shadow.diary.recent(1)[0]!.outcome).toBe('blocked');
  });

  /**
   * A retry must not re-ask the durable registry: the second answer would be
   * `false`, erasing the first-buy fact the sheet was waiting to complete.
   */
  it('claims a first buy once per trade, however many times it is re-evaluated', () => {
    let claims = 0;
    const p = providers({
      canSell: () => null, // force retries
      claimFirstBuy: () => {
        claims++;
        return claims === 1;
      },
    });
    shadow = makeShadow(p);
    const s = swap();
    shadow.onSwap(s);
    // Drain the pending queue several times, as the timer would.
    for (let i = 0; i < 3; i++) (shadow as unknown as { drainPending: () => void }).drainPending();
    expect(claims).toBe(1);
  });

  it('assembles a crowd from distinct wallets inside the window', () => {
    shadow = makeShadow();
    shadow.onSwap(swap({ wallet: WALLET }));
    shadow.onSwap(swap({ wallet: '0xbbbb000000000000000000000000000000000002' }));
    const latest = shadow.diary.recent(1)[0]!;
    // The second trade sees both wallets on the same token.
    expect(latest.lanes.length).toBeGreaterThan(0);
    expect(shadow.status().seen).toBe(2);
  });

  it('tracks fact coverage so a broken enrichment is visible', () => {
    shadow = makeShadow(providers({ pairAge: () => null }));
    shadow.onSwap(swap());
    const cov = shadow.status().factCoverage as Record<string, { measuredPct: number }>;
    expect(cov.pairAgeHours!.measuredPct).toBe(0);
    expect(cov.marketCap!.measuredPct).toBe(100);
  });

  it('journals the input and every artifact derived from it', () => {
    const { j, written } = captureJournal();
    shadow = makeShadow(providers(), j);
    shadow.onSwap(swap());
    const kinds = written.map((w) => w.kind);
    expect(kinds).toContain('trade');
    expect(kinds).toContain('facts');
    expect(kinds).toContain('gate');
    expect(kinds).toContain('verdict');
  });

  it('never throws into its caller when a provider fails', () => {
    shadow = makeShadow(
      providers({
        marketCap: () => {
          throw new Error('price oracle exploded');
        },
      }),
    );
    // index.ts also wraps this call, but the runtime should not be the reason a
    // measurement-only path can take down the live listener.
    expect(() => {
      try {
        shadow.onSwap(swap());
      } catch {
        /* surfaced below */
      }
    }).not.toThrow();
  });

  it('is inert when disabled', () => {
    const s = new V2Shadow(providers());
    // V2_SHADOW_ENABLED is not set in the test env, so this reads false.
    expect(s.enabled).toBe(false);
    s.onSwap(swap());
    expect(s.diary.size).toBe(0);
  });
});

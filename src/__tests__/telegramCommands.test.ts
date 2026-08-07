import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  shortMC,
  multiplierStr,
  ageStr,
  convictionTenth,
  formatLine,
  topPlaysText,
  lastAlertsText,
  parseCommand,
  TelegramCommands,
  TelegramHttpError,
} from '../telegram/commands.js';
import type { TrackedCall } from '../engine/performance.js';
import type { PerformanceTracker } from '../engine/performance.js';
import { config } from '../config/env.js';

function trackedCall(over: Partial<TrackedCall> = {}): TrackedCall {
  const now = Date.now();
  return {
    id: 'c-' + Math.random().toString(36).slice(2),
    token: '0xtok',
    tokenSymbol: 'GME',
    kind: 'SOLO',
    conviction: 70,
    walletCount: 1,
    walletSummary: '1 alpha',
    walletLabels: [],
    repeatCount: 1,
    repeatWallets: 1,
    newHolder: false,
    entryPrice: 1,
    entryMarketCap: 200_000,
    pairAgeHours: 2,
    entryAt: now - 10 * 60_000,
    lastPrice: 4,
    lastMarketCap: 800_000,
    lastGainPct: 300,
    maxPrice: 5.5,
    maxGainPct: 450,
    maxGainAt: now,
    lastMilestoneAnnounced: 400,
    gain1hPct: null,
    gain6hPct: null,
    gain24hPct: null,
    updatedAt: now,
    closed: false,
    ...over,
  };
}

/** Minimal stand-in for PerformanceTracker exposing just what the command
 *  formatters need — list(). */
function fakeTracker(calls: TrackedCall[]): PerformanceTracker {
  return { list: () => calls } as unknown as PerformanceTracker;
}

describe('telegram command formatting', () => {
  it('formats compact market caps like the dashboard cards', () => {
    expect(shortMC(200_000)).toBe('200k');
    expect(shortMC(1_100_000)).toBe('1.1 mill');
    expect(shortMC(999)).toBe('999');
    expect(shortMC(null)).toBe('?');
  });

  it('formats a multiplier from entry to a later price', () => {
    expect(multiplierStr(1, 5)).toBe('5x');
    expect(multiplierStr(1, 2.3)).toBe('2.3x');
    expect(multiplierStr(0, 5)).toBe('?x');
  });

  it('formats age in minutes, hours, then days', () => {
    expect(ageStr(10 * 60_000)).toBe('10mins');
    expect(ageStr(60_000)).toBe('1min');
    expect(ageStr(3 * 3_600_000)).toBe('3h');
    expect(ageStr(2 * 24 * 3_600_000)).toBe('2d');
  });

  it('collapses conviction (0-100) to X/10', () => {
    expect(convictionTenth(70)).toBe(7);
    expect(convictionTenth(84)).toBe(8);
    expect(convictionTenth(5)).toBe(1);
    expect(convictionTenth(0)).toBe(0);
  });

  it('formats one line matching the requested style, using the peak by default', () => {
    const call = trackedCall();
    const now = call.entryAt + 10 * 60_000;
    const line = formatLine(1, call, true, now);
    expect(line).toBe('#1 $GME 200k - 1.1 mill 5.5x -10mins ago 7/10');
  });

  it('uses the current (not peak) mark when peak=false', () => {
    const call = trackedCall();
    const now = call.entryAt + 10 * 60_000;
    const line = formatLine(1, call, false, now);
    expect(line).toContain('4x');
    expect(line).toContain('800k');
  });

  it('parses a slash command, stripping an @botname suffix', () => {
    expect(parseCommand('/t5')).toBe('/t5');
    expect(parseCommand('/T10@SwarmTheFlyBot extra text')).toBe('/t10');
    expect(parseCommand('  /l5  ')).toBe('/l5');
  });

  it('/t5 and /t10: ranks calls from the last 24h by peak gain, best first', () => {
    const now = Date.now();
    const winner = trackedCall({ tokenSymbol: 'WIN', maxGainPct: 500, entryAt: now - 3_600_000 });
    const loser = trackedCall({ tokenSymbol: 'MEH', maxGainPct: 20, entryAt: now - 3_600_000 });
    const stale = trackedCall({ tokenSymbol: 'OLD', maxGainPct: 900, entryAt: now - 25 * 3_600_000 });
    const text = topPlaysText(fakeTracker([loser, winner, stale]), 5);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Top 2 plays');
    expect(lines[1]).toContain('#1 $WIN');
    expect(lines[2]).toContain('#2 $MEH');
    expect(text).not.toContain('OLD');
  });

  it('/t5 and /t10 report when nothing has been tracked in 24h', () => {
    expect(topPlaysText(fakeTracker([]), 5)).toBe('No tracked calls in the last 24h yet.');
  });

  it('/l5: most recent calls first regardless of performance, no 24h cutoff', () => {
    const now = Date.now();
    const recent = trackedCall({ tokenSymbol: 'NEW', entryAt: now - 60_000 });
    const older = trackedCall({ tokenSymbol: 'OLD', entryAt: now - 30 * 3_600_000 });
    const text = lastAlertsText(fakeTracker([older, recent]), 5);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Last 2 calls');
    expect(lines[1]).toContain('#1 $NEW');
    expect(lines[2]).toContain('#2 $OLD');
  });

  it('/l5 reports when nothing has been tracked yet', () => {
    expect(lastAlertsText(fakeTracker([]), 5)).toBe('No tracked calls yet.');
  });
});

/**
 * Two production deployments run this image. When they share a bot token,
 * Telegram answers one of them 409 forever — and the old loop retried every 3s
 * indefinitely, burying the logs. It buried a real nine-hour attribution stall.
 */
describe('409 conflict handling', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const perf = { calls: () => [] } as unknown as PerformanceTracker;

  it('yields the bot after repeated 409s instead of polling forever', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 409, json: async () => ({ ok: false }) } as unknown as Response;
    }) as typeof fetch;

    // The test env configures no bot, so supply one for the duration of the loop.
    const prior = config.notifications.telegram;
    config.notifications.telegram = { token: 'test-token', chatId: '123' };
    const cmds = new TelegramCommands(perf);
    try {
      (cmds as unknown as { stopped: boolean }).stopped = false;
      await (cmds as unknown as { run: () => Promise<void> }).run.call(cmds);
    } finally {
      config.notifications.telegram = prior;
    }

    expect(cmds.yielded).toBe(true);
    // Bounded: the catch-up call plus at most MAX_CONSECUTIVE_CONFLICTS polls.
    expect(calls).toBeLessThanOrEqual(5);
  }, 20_000);

  it('carries the status code so 409 is distinguishable from a transient failure', () => {
    const err = new TelegramHttpError(409);
    expect(err.status).toBe(409);
    expect(String(err)).toContain('409');
    expect(new TelegramHttpError(502).status).toBe(502);
  });
});

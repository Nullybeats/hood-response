import { describe, it, expect, vi, afterEach } from 'vitest';
import { HyperSyncClient } from '../chain/hypersync.js';

const OPTS = { url: 'https://hs.example', token: 'tok', op: 'test' };

function client(extra: Partial<ConstructorParameters<typeof HyperSyncClient>[0]> = {}) {
  return new HyperSyncClient({ ...OPTS, ...extra });
}

function res(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => ({ height: 1 }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * A revoked token and a quiet chain both used to produce `null`. These pin the
 * difference: the client must name the cause AND stop sending requests.
 */
describe('HyperSync rate-limit and auth backoff', () => {
  it('holds off after a 429 instead of re-sending immediately', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(res(429));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();

    expect(await c.query({}, 'r')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.limitState().rateLimited).toBe(1);

    // Second call must NOT reach the network — that is what earns the next 429.
    expect(await c.query({}, 'r')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.limitState().skippedInCooldown).toBe(1);

    // ...and must resume once the cooldown expires.
    vi.advanceTimersByTime(2_500);
    expect(await c.query({}, 'r')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After in seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(429, { 'retry-after': '30' })));
    const c = client();
    await c.query({}, 'r');
    expect(c.limitState().cooldownMsRemaining).toBeGreaterThan(29_000);

    vi.advanceTimersByTime(20_000);
    expect(c.limitState().cooldownMsRemaining).toBeGreaterThan(0);
    vi.advanceTimersByTime(11_000);
    expect(c.limitState().cooldownMsRemaining).toBe(0);
  });

  it('counts a 401 as an AUTH failure, not a quiet chain, and backs off hard', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(res(401));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();

    expect(await c.query({}, 'r')).toBeNull();
    const s = c.limitState();
    expect(s.authFailures).toBe(1);
    expect(s.rateLimited).toBe(0);
    expect(s.lastStatus).toBe(401);
    // 30s minimum — the old client retried every tick and logged 1,539 of these.
    expect(s.cooldownMsRemaining).toBeGreaterThan(25_000);

    // A 2s wait is not enough; the request must not go out.
    vi.advanceTimersByTime(2_000);
    await c.query({}, 'r');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('escalates repeated auth failures and resets after a success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(res(403));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();

    await c.query({}, 'r');
    const first = c.limitState().cooldownMsRemaining;
    vi.advanceTimersByTime(first + 1_000);
    await c.query({}, 'r');
    const second = c.limitState().cooldownMsRemaining;
    expect(second).toBeGreaterThan(first);

    // A rotated token must recover at full speed, not inherit the penalty.
    vi.advanceTimersByTime(second + 1_000);
    fetchMock.mockResolvedValue(res(200));
    expect(await c.height()).toBe(1);
    fetchMock.mockResolvedValue(res(403));
    await c.height();
    expect(c.limitState().cooldownMsRemaining).toBeLessThanOrEqual(first);
  });

  it('leaves a healthy client with no cooldown at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200)));
    const c = client();
    expect(await c.height()).toBe(1);
    const s = c.limitState();
    expect(s.rateLimited).toBe(0);
    expect(s.authFailures).toBe(0);
    expect(s.cooldownMsRemaining).toBe(0);
    expect(s.skippedInCooldown).toBe(0);
  });
});

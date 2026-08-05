import { describe, it, expect, afterEach } from 'vitest';
import {
  TraceCapabilityMatrix,
  isValidBlockTrace,
  isValidCallTrace,
  probeMethod,
  traceCoverageLabel,
  tracesUsable,
  type ProbeTarget,
} from '../attrib/traces.js';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const target: ProbeTarget = {
  chainId: '4663',
  rpcUrl: 'https://rpc.example.com/v2/SECRETKEY',
  probeTxHash: '0xabc',
  probeBlockHex: '0x1',
};

/** Reply with a JSON-RPC error. */
const rpcError = (code: number, message: string) => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ error: { code, message } }),
  })) as unknown as typeof fetch;
};
const ok = (result: unknown) => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ result }),
  })) as unknown as typeof fetch;
};
const http = (status: number) => {
  globalThis.fetch = (async () => ({ ok: false, status, statusText: 'x' })) as unknown as typeof fetch;
};

describe('trace capability — a matrix, not a boolean', () => {
  describe('structure validation (a 200 is not a trace)', () => {
    it('accepts a real callTracer frame', () => {
      expect(isValidCallTrace({ type: 'CALL', from: '0xaaa', to: '0xbbb', gas: '0x1' })).toBe(true);
      // A simple transfer has no nested calls; that must not fail validation.
      expect(isValidCallTrace({ type: 'CALL', from: '0xaaa', calls: [] })).toBe(true);
    });

    it('rejects successful-but-useless payloads', () => {
      for (const bad of [null, undefined, {}, [], 'trace', { from: '0xaaa' }, { type: 'CALL' }]) {
        expect(isValidCallTrace(bad)).toBe(false);
      }
      // `calls` present but not an array is malformed.
      expect(isValidCallTrace({ type: 'CALL', from: '0xa', calls: {} })).toBe(false);
    });

    it('validates trace_block as an array of frames', () => {
      expect(isValidBlockTrace([])).toBe(true); // an empty block is fine
      expect(isValidBlockTrace([{ type: 'call', action: {} }])).toBe(true);
      expect(isValidBlockTrace([{ type: 'call' }])).toBe(false);
      expect(isValidBlockTrace({ type: 'call' })).toBe(false); // not an array
    });
  });

  describe('status determination', () => {
    it('MEASURED CASE: -32601 is unavailable', async () => {
      // Chain 4663's public RPC answers exactly this, HTTP 200 with -32601,
      // while eth_getTransactionReceipt on the same host succeeds.
      rpcError(-32601, 'the method debug_traceTransaction does not exist/is not available');
      const c = await probeMethod(target, 'debug_traceTransaction');
      expect(c.status).toBe('unavailable');
      expect(c.errorCode).toBe(-32601);
    });

    it('REGRESSION: a 429 is INDETERMINATE, never unavailable', async () => {
      // The public RPC already 429s under sustained polling. Recording that as
      // "this chain has no tracing" would be permanently and wrongly wrong.
      http(429);
      const c = await probeMethod(target, 'debug_traceTransaction');
      expect(c.status).toBe('indeterminate');
      expect(c.detail).toContain('not the method');
    });

    it('auth failures are indeterminate', async () => {
      for (const s of [401, 403]) {
        http(s);
        expect((await probeMethod(target, 'trace_block')).status).toBe('indeterminate');
      }
    });

    it('a transport failure is indeterminate', async () => {
      globalThis.fetch = (async () => {
        throw new Error('ETIMEDOUT');
      }) as unknown as typeof fetch;
      const c = await probeMethod(target, 'debug_traceTransaction');
      expect(c.status).toBe('indeterminate');
    });

    it('a NON-(-32601) rpc error is indeterminate, not unavailable', async () => {
      // A pruned block or a bad param says nothing about method support.
      rpcError(-32000, 'block not found');
      const c = await probeMethod(target, 'trace_block');
      expect(c.status).toBe('indeterminate');
      expect(c.errorCode).toBe(-32000);
    });

    it('HTTP 200 with an unusable payload is indeterminate, not available', async () => {
      ok({});
      const c = await probeMethod(target, 'debug_traceTransaction');
      expect(c.status).toBe('indeterminate');
      expect(c.detail).toContain('not a usable trace');
    });

    it('a structurally valid trace is available', async () => {
      ok({ type: 'CALL', from: '0xaaa', to: '0xbbb', calls: [] });
      expect((await probeMethod(target, 'debug_traceTransaction')).status).toBe('available');
    });

    it('never records the URL, only the host', async () => {
      rpcError(-32601, 'nope');
      const c = await probeMethod(target, 'debug_traceTransaction');
      expect(c.sourceHost).toBe('rpc.example.com');
      expect(JSON.stringify(c)).not.toContain('SECRETKEY');
    });
  });

  describe('the matrix', () => {
    it('reports the two methods SEPARATELY — one can work while the other does not', async () => {
      let n = 0;
      globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
        const m = JSON.parse(String(init?.body ?? '{}')).method;
        n += 1;
        return m === 'debug_traceTransaction'
          ? ({ ok: true, json: async () => ({ result: { type: 'CALL', from: '0xa' } }) } as unknown as Response)
          : ({ ok: true, json: async () => ({ error: { code: -32601, message: 'no' } }) } as unknown as Response);
      }) as unknown as typeof fetch;

      const caps = await new TraceCapabilityMatrix().probeAll(target);
      expect(caps.find((c) => c.method === 'debug_traceTransaction')!.status).toBe('available');
      expect(caps.find((c) => c.method === 'trace_block')!.status).toBe('unavailable');
      expect(n).toBe(2);
    });

    it('caches per (chain, host, method) and does not re-probe within the TTL', async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return { ok: true, json: async () => ({ error: { code: -32601, message: 'no' } }) } as unknown as Response;
      }) as unknown as typeof fetch;
      const m = new TraceCapabilityMatrix();
      await m.probe(target, 'debug_traceTransaction');
      await m.probe(target, 'debug_traceTransaction');
      expect(calls).toBe(1);
    });

    it('re-probes after the TTL, so a transient failure cannot harden', async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return { ok: false, status: 429, statusText: 'x' } as unknown as Response;
      }) as unknown as typeof fetch;
      const m = new TraceCapabilityMatrix(0); // expire immediately
      await m.probe(target, 'debug_traceTransaction');
      await m.probe(target, 'debug_traceTransaction');
      expect(calls).toBe(2);
    });

    it('a different host does not inherit the previous answer', async () => {
      let seen: string[] = [];
      globalThis.fetch = (async (u: string) => {
        seen.push(String(u));
        return { ok: true, json: async () => ({ error: { code: -32601, message: 'no' } }) } as unknown as Response;
      }) as unknown as typeof fetch;
      const m = new TraceCapabilityMatrix();
      await m.probe(target, 'debug_traceTransaction');
      await m.probe({ ...target, rpcUrl: 'https://other.example.com' }, 'debug_traceTransaction');
      expect(seen).toHaveLength(2);
    });

    it('invalidateHost clears only that host', async () => {
      ok({ type: 'CALL', from: '0xa' });
      const m = new TraceCapabilityMatrix();
      await m.probe(target, 'debug_traceTransaction');
      await m.probe({ ...target, rpcUrl: 'https://other.example.com' }, 'debug_traceTransaction');
      expect(m.entries()).toHaveLength(2);
      m.invalidateHost(target.rpcUrl);
      expect(m.entries()).toHaveLength(1);
      expect(m.entries()[0]!.sourceHost).toBe('other.example.com');
    });
  });

  describe('reporting', () => {
    const cap = (status: 'available' | 'unavailable' | 'indeterminate') => ({
      chainId: '4663',
      sourceHost: 'h',
      method: 'debug_traceTransaction' as const,
      status,
      detail: '',
      checkedAt: Date.now(),
    });

    it('only `available` counts as usable', () => {
      expect(tracesUsable([cap('available')])).toBe(true);
      // Indeterminate must not be read as capable — that would promise evidence
      // we have never seen — nor as incapable.
      expect(tracesUsable([cap('indeterminate')])).toBe(false);
      expect(tracesUsable([cap('unavailable')])).toBe(false);
    });

    it('labels indeterminate distinctly from unavailable', () => {
      expect(traceCoverageLabel([cap('unavailable')])).toContain('permanently unprovable');
      const ind = traceCoverageLabel([cap('indeterminate')]);
      expect(ind).toContain('INDETERMINATE');
      expect(ind).toContain('do not read this as unavailable');
      expect(traceCoverageLabel([])).toContain('not probed');
    });
  });
});

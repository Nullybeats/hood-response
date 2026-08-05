import { describe, it, expect } from 'vitest';
import { buildTxOverrides, isFeeStale, STALE_FEE_FACTOR, type FeeQuote } from '../sniper/txOverrides.js';

/**
 * These overrides decide what gas price a funded wallet broadcasts at, so the important property is
 * not "does the optimisation work" but "does it fail back to the old behaviour whenever anything is
 * uncertain". An empty object means ethers estimates and looks fees up exactly as it did before.
 *
 * Negative control: delete the `isFeeStale` term from `buildTxOverrides` and "discards a fee quote
 * aged past the staleness factor" must go red — that assertion is the whole safety story here.
 */

const NOW = 1_800_000_000_000;
const fresh = (at = NOW): FeeQuote => ({ at, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });

describe('buildTxOverrides', () => {
  it('decides nothing when both levers are off — the shipped default', () => {
    expect(buildTxOverrides({ gasLimit: 0, feeCacheMs: 0, fees: fresh(), now: NOW })).toEqual({});
  });

  it('still decides nothing when the cache is off but a quote happens to exist', () => {
    // guards against "we refreshed fees for telemetry" silently turning the lever on
    expect(buildTxOverrides({ gasLimit: 0, feeCacheMs: 0, fees: fresh(), now: NOW })).toEqual({});
  });

  it('supplies a gas limit when configured, removing the estimate round trip', () => {
    expect(buildTxOverrides({ gasLimit: 900_000, feeCacheMs: 0, fees: null, now: NOW })).toEqual({
      gasLimit: 900_000n,
    });
  });

  it('supplies a fresh fee quote when the cache is on', () => {
    expect(buildTxOverrides({ gasLimit: 0, feeCacheMs: 5_000, fees: fresh(), now: NOW })).toEqual({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
  });

  it('discards a fee quote aged past the staleness factor — an unmined tx costs more than a round trip', () => {
    const ttl = 5_000;
    const old = fresh(NOW - ttl * STALE_FEE_FACTOR - 1);
    const out = buildTxOverrides({ gasLimit: 0, feeCacheMs: ttl, fees: old, now: NOW });
    expect(out.maxFeePerGas, 'a stale fee must never be broadcast').toBeUndefined();
    expect(out.maxPriorityFeePerGas).toBeUndefined();
  });

  it('keeps a quote that is old but still inside the window', () => {
    const ttl = 5_000;
    const borderline = fresh(NOW - ttl * STALE_FEE_FACTOR + 1);
    expect(buildTxOverrides({ gasLimit: 0, feeCacheMs: ttl, fees: borderline, now: NOW }).maxFeePerGas).toBe(
      2_000_000_000n,
    );
  });

  it('falls back cleanly when no refresh has ever landed', () => {
    expect(buildTxOverrides({ gasLimit: 0, feeCacheMs: 5_000, fees: null, now: NOW })).toEqual({});
  });

  it('applies the gas limit even when the fee half falls back', () => {
    // the two levers are independent — a stale fee must not suppress a perfectly good gas limit
    const old = fresh(NOW - 10 * 5_000);
    expect(buildTxOverrides({ gasLimit: 900_000, feeCacheMs: 5_000, fees: old, now: NOW })).toEqual({
      gasLimit: 900_000n,
    });
  });
});

describe('isFeeStale', () => {
  it('measures age against the factor, not the raw interval', () => {
    const ttl = 1_000;
    expect(isFeeStale(fresh(NOW - 2_000), ttl, NOW)).toBe(false); // 2 intervals — still fine
    expect(isFeeStale(fresh(NOW - 4_000), ttl, NOW)).toBe(true); // past 3× — discard
  });
});

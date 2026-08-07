/**
 * "First-ever buy" is the load-bearing word in the premium signal. The legacy
 * implementation was an in-memory Set on a service that redeploys on every push,
 * so it silently measured uptime instead of novelty. These tests pin the two
 * properties that fix it: it survives a restart, and it never fabricates a first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FirstBuyRegistry } from '../../v2/facts/firstBuy.js';

const WALLET = '0xAbCdEf0000000000000000000000000000000001';
const TOKEN = '0x1111111111111111111111111111111111111111';
const NOW = 1_786_000_000_000;

let dir: string;
let reg: FirstBuyRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v2-firstbuy-'));
  reg = new FirstBuyRegistry(join(dir, 'first-buy.sqlite'));
});

afterEach(() => {
  reg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FirstBuyRegistry', () => {
  it('reports a pair as first exactly once', () => {
    expect(reg.claim(WALLET, TOKEN, NOW, 100)).toBe(true);
    expect(reg.claim(WALLET, TOKEN, NOW + 1, 101)).toBe(false);
    expect(reg.claim(WALLET, TOKEN, NOW + 2, 102)).toBe(false);
  });

  it('treats wallet and token case-insensitively, as addresses are', () => {
    expect(reg.claim(WALLET.toUpperCase(), TOKEN.toUpperCase(), NOW, 1)).toBe(true);
    expect(reg.claim(WALLET.toLowerCase(), TOKEN.toLowerCase(), NOW, 2)).toBe(false);
  });

  it('scopes the claim to the pair, not to the wallet or the token alone', () => {
    const other = '0x2222222222222222222222222222222222222222';
    expect(reg.claim(WALLET, TOKEN, NOW, 1)).toBe(true);
    // Same wallet, different token — still a debut.
    expect(reg.claim(WALLET, other, NOW, 1)).toBe(true);
    // Different wallet, same token — also a debut for that wallet.
    expect(reg.claim('0x3333333333333333333333333333333333333333', TOKEN, NOW, 1)).toBe(true);
  });

  /** The bug this file exists for: a redeploy must not make old pairs new again. */
  it('survives a restart — reopening the same file remembers prior claims', () => {
    const path = join(dir, 'restart.sqlite');
    const first = new FirstBuyRegistry(path);
    expect(first.claim(WALLET, TOKEN, NOW, 500)).toBe(true);
    first.close();

    const afterRedeploy = new FirstBuyRegistry(path);
    expect(afterRedeploy.claim(WALLET, TOKEN, NOW + 60_000, 600)).toBe(false);
    expect(afterRedeploy.seen(WALLET, TOKEN)).toBe(true);
    afterRedeploy.close();
  });

  /**
   * A disabled registry must fail toward "not first". Failing the other way would
   * manufacture the premium signal for every pair it sees.
   */
  it('never claims a first when persistence is unavailable', () => {
    const disabled = new FirstBuyRegistry('');
    expect(disabled.enabled).toBe(false);
    expect(disabled.claim(WALLET, TOKEN, NOW, 1)).toBe(false);
    expect(disabled.seen(WALLET, TOKEN)).toBe(false);
    expect(disabled.count()).toBe(0);
  });

  it('records when and where the first buy happened', () => {
    reg.claim(WALLET, TOKEN, NOW, 12_345);
    const rec = reg.get(WALLET, TOKEN);
    expect(rec).not.toBeNull();
    expect(rec!.firstAt).toBe(NOW);
    expect(rec!.firstBlock).toBe(12_345);
    expect(rec!.wallet).toBe(WALLET.toLowerCase());
  });

  it('prunes by first-seen block, leaving newer pairs claimed', () => {
    reg.claim(WALLET, TOKEN, NOW, 100);
    reg.claim(WALLET, '0x4444444444444444444444444444444444444444', NOW, 900);
    expect(reg.count()).toBe(2);

    expect(reg.pruneBefore(500)).toBe(1);
    expect(reg.count()).toBe(1);
    // The surviving (newer) pair is still remembered as seen.
    expect(reg.seen(WALLET, '0x4444444444444444444444444444444444444444')).toBe(true);
    // The pruned one is claimable again — accepted, and why retention is aligned
    // with the attribution ledger's own window rather than a row count.
    expect(reg.claim(WALLET, TOKEN, NOW, 1000)).toBe(true);
  });

  it('is safe to claim concurrently — only one caller is told first', () => {
    // Sequential calls model the resolved order of a race; the ON CONFLICT is
    // what makes the outcome single-winner regardless of interleaving.
    const results = Array.from({ length: 10 }, () => reg.claim(WALLET, TOKEN, NOW, 1));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

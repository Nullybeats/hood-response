import { describe, it, expect } from 'vitest';
import { findWalletOwner, sharedWallets, type WalletHolder } from '../sniper/walletShare.js';
import { addressOfPrivateKey } from '../sniper/executor.js';

/**
 * Two owners on one wallet share a BALANCE.
 *
 * The per-position sell cap in `executor.sell()` already stops one tenant dumping another's lot —
 * that was the fix after a position closed `reconciled` at -100.59%. What it cannot do is make one
 * pot of ETH into two: both engines size their buys against the same balance, so one owner's fill
 * silently spends what the other's sizing counted on. There is no downstream fix for that, which is
 * why enrolment now refuses the condition instead of warning about it a boot later.
 */

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KEY_B = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

/** The owners whose wallets are being checked against — what the registry passes in. */
const holdersOf = (wallets: Record<string, string | undefined>): WalletHolder[] =>
  Object.entries(wallets).map(([owner, walletAddress]) => ({ owner, walletAddress }));

describe('addressOfPrivateKey', () => {
  it('derives the address without unlocking or enrolling anything', () => {
    const addr = addressOfPrivateKey(KEY_A);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Deterministic — the enrolment check and the enrolment itself must agree on the address.
    expect(addressOfPrivateKey(KEY_A)).toBe(addr);
    expect(addressOfPrivateKey(KEY_B)).not.toBe(addr);
  });

  it('tolerates surrounding whitespace, and throws on a malformed key', () => {
    expect(addressOfPrivateKey(`  ${KEY_A}\n`)).toBe(addressOfPrivateKey(KEY_A));
    expect(() => addressOfPrivateKey('not-a-key')).toThrow();
  });
});

describe('findWalletOwner — the check that refuses a shared enrolment', () => {
  const addrA = addressOfPrivateKey(KEY_A);
  const addrB = addressOfPrivateKey(KEY_B);

  it('names the other owner when the address is already enrolled', () => {
    const holders = holdersOf({ alice: addrA, bob: addrB });
    expect(findWalletOwner(holders, addrA, 'bob')).toBe('alice');
  });

  it('is case-insensitive — a checksummed address must not slip past', () => {
    // One client sends checksummed, another lowercased. A case-sensitive compare would wave the
    // shared wallet straight through, which is the whole failure this prevents.
    const holders = holdersOf({ alice: addrA.toLowerCase() });
    expect(findWalletOwner(holders, addrA, 'bob')).toBe('alice');
    expect(findWalletOwner(holdersOf({ alice: addrA }), addrA.toLowerCase(), 'bob')).toBe('alice');
  });

  it('lets an owner re-enrol their OWN key', () => {
    // Rotating or re-uploading your own wallet is not sharing, and must not 409.
    expect(findWalletOwner(holdersOf({ alice: addrA }), addrA, 'alice')).toBeNull();
  });

  it('returns null when the address is free', () => {
    expect(findWalletOwner(holdersOf({ alice: addrA }), addrB, 'bob')).toBeNull();
  });

  it('skips owners with no wallet — locked or unenrolled is not a match', () => {
    // walletAddress is null while an engine is locked; treating that as a match would block every
    // enrolment behind the first locked tenant.
    expect(findWalletOwner(holdersOf({ alice: undefined, carol: undefined }), addrA, 'bob')).toBeNull();
    expect(findWalletOwner([{ owner: 'alice', walletAddress: null }], addrA, 'bob')).toBeNull();
  });

  it('NEGATIVE CONTROL: without the check, the shared wallet is simply accepted', () => {
    // Pre-fix, enrolment looked only at the caller's own engine — so the condition was created
    // silently and surfaced only at the NEXT boot's warning. Reproduced so the fix is demonstrably
    // what does the work.
    const holders = holdersOf({ alice: addrA });
    const preFixCheck = (): string | null => null; // what enrolment effectively did before
    expect(preFixCheck()).toBeNull(); // → enrolment proceeds; two owners now share one balance
    expect(findWalletOwner(holders, addrA, 'bob')).toBe('alice'); // → the fix catches it
  });
});

describe('sharedWallets — the boot-time warning', () => {
  const addrA = addressOfPrivateKey(KEY_A);
  const addrB = addressOfPrivateKey(KEY_B);

  it('reports only addresses held by more than one owner', () => {
    const shared = sharedWallets(holdersOf({ alice: addrA, bob: addrA, carol: addrB }));
    expect([...shared.keys()]).toEqual([addrA.toLowerCase()]);
    expect(shared.get(addrA.toLowerCase())).toEqual(['alice', 'bob']);
  });

  it('is silent when every owner has their own wallet', () => {
    // The live state as of 2026-08-04: 5 tenants, no shared address, warning silent.
    expect(sharedWallets(holdersOf({ alice: addrA, bob: addrB, carol: undefined })).size).toBe(0);
  });
});

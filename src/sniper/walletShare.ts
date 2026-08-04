/**
 * The shared-wallet rule, kept pure and separate from the registry.
 *
 * Two owners on one wallet share a BALANCE. The per-position cap in `executor.sell()` stops one
 * tenant dumping another's lot — that was the fix after a position closed `reconciled` at
 * -100.59% — but it cannot make one pot of ETH into two: both engines size their buys against the
 * same balance, so one owner's fill silently spends what the other's sizing counted on. Nothing
 * downstream can repair that, so enrolment refuses to create the condition.
 *
 * It lives here rather than inside `registry.ts` because that module reaches `node:sqlite` through
 * the state store, which a unit test cannot load — and a rule that guards a funded wallet should be
 * the easiest thing in the repo to test, not the hardest.
 */

/** The minimum an engine must expose to be checked: who owns it, and which wallet it holds. */
export interface WalletHolder {
  owner: string;
  /** null/undefined while the engine is locked or has no key enrolled — never a match. */
  walletAddress?: string | null;
}

/**
 * Which OTHER owner already holds `address`, or null when it is free.
 *
 * Case-insensitive: an address arrives checksummed from one client and lowercased from another, and
 * a case mismatch here would wave the shared wallet straight through. Re-enrolling your own key is
 * not sharing, so `exceptOwner` is skipped.
 */
export function findWalletOwner(
  holders: Iterable<WalletHolder>,
  address: string,
  exceptOwner: string,
): string | null {
  const wanted = address.trim().toLowerCase();
  const except = exceptOwner.trim().toLowerCase();
  if (!wanted) return null;
  for (const h of holders) {
    if (h.owner.toLowerCase() === except) continue;
    if (h.walletAddress && h.walletAddress.trim().toLowerCase() === wanted) return h.owner;
  }
  return null;
}

/** Every address held by more than one owner, as address → owners. Powers the boot-time warning. */
export function sharedWallets(holders: Iterable<WalletHolder>): Map<string, string[]> {
  const byAddress = new Map<string, string[]>();
  for (const h of holders) {
    const addr = h.walletAddress?.trim().toLowerCase();
    if (!addr) continue;
    byAddress.set(addr, [...(byAddress.get(addr) ?? []), h.owner]);
  }
  for (const [addr, owners] of byAddress) if (owners.length < 2) byAddress.delete(addr);
  return byAddress;
}

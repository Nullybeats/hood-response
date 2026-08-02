import { createHash } from 'node:crypto';
import { config } from './config/env.js';

/**
 * Stable, opaque per-wallet identifier.
 *
 * Consumers need to say "this is the same wallet that called the last three runners" without
 * ever receiving an address. Labels can't do that job: `seed.ts` derives them from holdings
 * ("alpha · 3 coins"), so they MUTATE when a wallet buys another coin, and they COLLIDE — two
 * unrelated wallets both holding three coins get the identical string. Anything keyed on a
 * label silently merges wallets and loses history.
 *
 * A salted hash keeps the address-privacy invariant intact. The salt matters: addresses are
 * public and enumerable, so an UNSALTED hash is trivially reversed by hashing every address
 * that has ever touched the chain. With a secret salt the id is opaque.
 *
 * Set WALLET_ID_SALT to a long random string and never change it — rotating the salt renames
 * every wallet, so downstream track records can no longer be matched to the wallet that earned
 * them. When it is unset the ids are still stable across restarts, but are reversible by anyone
 * with a copy of this source; the startup warning in index.ts says so.
 */

const cache = new Map<string, string>();

/** True when WALLET_ID_SALT is unset — ids are stable but reversible. */
export const walletIdSaltMissing = config.WALLET_ID_SALT.length === 0;

const SALT = walletIdSaltMissing ? 'hood-response:unsalted:v1' : config.WALLET_ID_SALT;

/**
 * Opaque 16-hex-char id for a wallet address. Deterministic for a given salt, so the same
 * wallet keeps the same id across restarts, redeploys, and alerts.
 */
export function walletId(address: string): string {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  // 64 bits of a salted digest: collision odds stay negligible at any realistic wallet count
  // while keeping the id short enough to read in a log line.
  const id = createHash('sha256').update(`${SALT}:${key}`).digest('hex').slice(0, 16);
  cache.set(key, id);
  return id;
}

/**
 * Which alerts we missed while the SSE stream was down, kept pure and separate from the subscriber.
 *
 * Railway's edge terminates the feed's `/events` stream at a hard 900s, regardless of traffic —
 * measured 2026-08-05 at exactly 15m00s from an independent client on a different network, with
 * heartbeats flowing the whole time, so it is neither idleness nor our client nor our server. We
 * cannot prevent the disconnect; we can stop losing alerts to the reconnect gap, which at ~96
 * disconnects a day works out to ~2.6 missed SOLO alerts a year — and a SOLO is the kind DERP (51×)
 * and AMARA (40×) arrived on.
 *
 * On reconnect the subscriber re-reads the feed's recent alert history and replays anything it never
 * saw. Two independent bounds keep a replay from ever becoming a stale buy:
 *   1. `maxAgeMs` here — never resurrect history, only the seconds we were actually blind for.
 *   2. the engine's own freshness gate (`SNIPER_STALE_MAX_SEC`, 15s) downstream, which rejects a
 *      late alert regardless of how it arrived.
 * The gap is ~1.4s, so a genuinely missed alert clears both; anything older fails both.
 */

export interface CatchUpAlert {
  id?: string;
  swarm?: { token?: string; firstSeen?: number };
}

/**
 * Alerts to replay, oldest first (so downstream sees them in the order they happened).
 *
 * `seen` is the ids already dispatched on the live stream — the de-duplication that stops an alert
 * delivered just before the drop from being handled twice.
 */
export function selectCatchUp<T extends CatchUpAlert>(
  alerts: readonly T[],
  seen: ReadonlySet<string>,
  nowMs: number,
  maxAgeMs: number,
): T[] {
  return alerts
    .filter((a) => {
      if (!a?.id || seen.has(a.id)) return false;
      if (!a.swarm?.token) return false;
      const ts = a.swarm.firstSeen;
      // No timestamp = we cannot prove it is recent. Fail closed: an un-datable alert is far more
      // likely to be old history than something from the last second and a half.
      if (typeof ts !== 'number' || ts <= 0) return false;
      const age = nowMs - ts;
      // Negative age = the feed's clock runs ahead of ours; that is still "just happened", not stale.
      return age <= maxAgeMs;
    })
    .sort((a, b) => (a.swarm!.firstSeen ?? 0) - (b.swarm!.firstSeen ?? 0));
}

/** Remember `id`, evicting oldest first so the set cannot grow without bound. */
export function remember(seen: Set<string>, order: string[], id: string, cap: number): void {
  if (seen.has(id)) return;
  seen.add(id);
  order.push(id);
  while (order.length > cap) {
    const old = order.shift();
    if (old !== undefined) seen.delete(old);
  }
}

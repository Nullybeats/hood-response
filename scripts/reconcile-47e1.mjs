#!/usr/bin/env node
/**
 * Are we missing anything the reference engine calls?
 *
 * v2 is meant to make the SAME calls as the 47e1 instance, minus the ones that were allocations
 * wearing a buy's label. "Minus the dishonest ones" is easy to say and easy to hide behind — a
 * detection bug produces exactly the same silence as honest disagreement. This separates them.
 *
 * For every buy-shaped 47e1 alert inside our record's window, it asks what WE did:
 *
 *   AGREED       we called it too
 *   RULE         we saw it, evaluated it, and declined for a named reason. Honest disagreement —
 *                and where 47e1 called an allocation a buy, this is where that lands, correctly.
 *   EVIDENCE     we saw it but never established a fact (blocked/waiting). Not a rule decision;
 *                a coverage gap, and fixable.
 *   *** UNSEEN   we have NO record of it at all. THE ONLY BUCKET THAT MEANS A BUG. Every other
 *                outcome is a choice we can defend; this one is a signal that never reached us.
 *
 * Matching is by token + time, because 47e1's alerts carry no txHash — only `token`, `firstSeen`
 * and wallet LABELS (which collide and mutate, so they are not a key). A window is therefore
 * required, and it is deliberately generous: over-matching makes us look better than we are only
 * in the AGREED/RULE buckets, while UNSEEN — the bucket that matters — gets stricter as the window
 * widens, not looser.
 *
 * Alerts older than our earliest decision are SKIPPED, not counted as misses. After a rules-epoch
 * reset our record starts empty, and scoring 47e1's back-catalogue against it would report a
 * catastrophe that is really just a short window.
 *
 *   node scripts/reconcile-47e1.mjs [windowMinutes=15]
 */

const REF = 'https://hood-response-production-47e1.up.railway.app';
const OURS = process.env.FEED_URL || 'https://hood-response-production-7a7e.up.railway.app';
const WINDOW_MS = (Number(process.argv[2]) || 15) * 60_000;

const get = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

const refRaw = await get(`${REF}/api/alerts`);
const refAlerts = (Array.isArray(refRaw) ? refRaw : refRaw.alerts || [])
  .map((a) => ({ rule: a.ruleName || a.ruleId, ...(a.swarm || a) }))
  .filter((s) => s.kind !== 'SELL' && s.token);

const decisions = (await get(`${OURS}/api/v2/decisions?limit=500`)).decisions || [];
const ledger = await get(`${OURS}/api/v2/outcomes?limit=1000`);

if (!decisions.length) {
  console.log('We have no decisions recorded yet — nothing to reconcile. (Fresh rules epoch?)');
  process.exit(0);
}

// Our record only covers from here. Anything earlier cannot be a miss.
const ourStart = Math.min(...decisions.map((d) => d.at));
const inWindow = refAlerts.filter((s) => (s.firstSeen ?? s.lastSeen ?? 0) >= ourStart);

const buckets = { AGREED: [], RULE: [], EVIDENCE: [], UNSEEN: [] };

for (const ref of inWindow) {
  const at = ref.firstSeen ?? ref.lastSeen;
  const tok = ref.token.toLowerCase();
  const ours = decisions
    .filter((d) => (d.token || '').toLowerCase() === tok && Math.abs(d.at - at) <= WINDOW_MS)
    .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at));

  const row = { sym: ref.tokenSymbol, rule: ref.rule, at, mc: ref.marketCap, ours: ours[0] };
  if (!ours.length) buckets.UNSEEN.push(row);
  else if (ours.some((d) => d.outcome === 'matched')) buckets.AGREED.push(row);
  else if (ours.every((d) => d.outcome === 'blocked' || d.outcome === 'waiting')) buckets.EVIDENCE.push(row);
  else buckets.RULE.push(row);
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const usd = (n) => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-US'));

console.log(`our record starts ${new Date(ourStart).toISOString()} (${decisions.length} decisions, ${ledger.summary?.matched ?? 0} calls)`);
console.log(`47e1 buy-shaped alerts: ${refAlerts.length} total, ${inWindow.length} inside our window, match window ±${WINDOW_MS / 60000}m\n`);

if (!inWindow.length) {
  console.log('No overlap yet. Let both run for an hour and re-run — this is a window problem, not a result.');
  process.exit(0);
}

for (const [name, rows] of Object.entries(buckets)) {
  const pct = ((100 * rows.length) / inWindow.length).toFixed(0);
  console.log(`${name === 'UNSEEN' && rows.length ? '*** ' : ''}${name}: ${rows.length} (${pct}%)`);
  for (const r of rows.slice(0, 12)) {
    const why = r.ours ? `${r.ours.outcome}: ${(r.ours.reason || '').slice(0, 68)}` : 'no record on this token in the window';
    console.log(`   ${hhmm(r.at)} ${(r.sym || '?').padEnd(10)} ${String(r.rule).padEnd(22)} ${usd(r.mc).padStart(11)}  ${why}`);
  }
  if (rows.length > 12) console.log(`   … and ${rows.length - 12} more`);
  console.log();
}

console.log(
  buckets.UNSEEN.length === 0
    ? 'VERDICT: no 47e1 alert went unseen. Every divergence is a rule or an evidence gap we can name.'
    : `VERDICT: ${buckets.UNSEEN.length} alert(s) never reached us. That is a detection bug, not a rule choice — start there.`,
);

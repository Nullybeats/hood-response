/**
 * Dashboard v2 — what the brain is seeing, and why it decided what it decided.
 *
 * Served at /v2, alongside the legacy dashboard rather than replacing it, so the
 * old view stays available for as long as the old engine is the one on the wire.
 *
 * The layout follows the one question the legacy dashboard could never answer:
 * "why didn't it buy?" Decisions lead, with skips and near-misses shown as
 * prominently as matches — a suppressed signal must never again be
 * indistinguishable from a quiet market. Fact coverage sits beside them, because
 * a fact that is never measured is a broken enrichment, and it too would
 * otherwise read as silence.
 *
 * Neobrutalism to match snipurr.fun: flat surfaces, hard black borders, offset
 * shadows, lime accent. Self-contained — no CDN, no build step, no external
 * fonts, since this is served straight off the engine.
 */

export const DASHBOARD_V2_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Snipurr v2 — brain</title>
<style>
  :root {
    --lime: #cdff00;
    --ink: #0a0a0a;
    --paper: #f4f4f0;
    --card: #ffffff;
    --muted: #6b6b6b;
    --red: #ff4d4d;
    --amber: #ffb020;
    --blue: #4da3ff;
    --border: 3px solid var(--ink);
    --shadow: 6px 6px 0 var(--ink);
    --shadow-sm: 3px 3px 0 var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #12120f; --card: #1c1c18; --ink: #f4f4f0; --muted: #9a9a92; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    background: var(--paper); color: var(--ink);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.02em; text-transform: uppercase; }
  h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  .sub { color: var(--muted); margin-bottom: 18px; font-size: 12px; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .card {
    background: var(--card); border: var(--border); box-shadow: var(--shadow);
    padding: 14px; overflow: hidden;
  }
  .card.wide { grid-column: 1 / -1; }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .tile {
    background: var(--card); border: var(--border); box-shadow: var(--shadow-sm);
    padding: 8px 14px; min-width: 108px;
  }
  .tile .n { font-size: 24px; font-weight: 800; }
  .tile .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .tile.matched { background: var(--lime); color: #0a0a0a; }
  .tile.matched .k { color: #333; }
  .badge {
    display: inline-block; padding: 1px 7px; border: 2px solid var(--ink);
    font-size: 10px; font-weight: 800; text-transform: uppercase; margin-right: 5px;
  }
  .b-matched { background: var(--lime); color: #0a0a0a; }
  .b-skipped { background: transparent; }
  .b-waiting { background: var(--amber); color: #0a0a0a; }
  .b-blocked { background: var(--red); color: #fff; }
  .b-observed { background: var(--blue); color: #0a0a0a; }
  .ev { font-size: 12px; margin-right: 2px; }
  .row {
    display: flex; gap: 10px; align-items: baseline;
    padding: 8px 0; border-bottom: 1px dashed var(--muted);
    flex-wrap: wrap;
  }
  .row:last-child { border-bottom: 0; }
  .sym { font-weight: 800; min-width: 78px; }
  .reason { color: var(--muted); flex: 1; min-width: 200px; }
  .score { font-weight: 800; }
  .tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab {
    border: var(--border); background: var(--card); color: var(--ink);
    padding: 5px 12px; cursor: pointer; font: inherit; font-weight: 700;
    text-transform: uppercase; font-size: 11px; box-shadow: var(--shadow-sm);
  }
  .tab[aria-selected="true"] { background: var(--lime); color: #0a0a0a; }
  .bar { height: 14px; border: 2px solid var(--ink); background: var(--card); margin-top: 3px; }
  .bar > i { display: block; height: 100%; background: var(--lime); }
  .lane { border: 2px solid var(--ink); padding: 8px; margin-bottom: 8px; }
  .lane .name { font-weight: 800; }
  .lane .sentence { color: var(--muted); font-size: 12px; }
  .off { border-color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, transparent); padding: 10px; }
  code { background: color-mix(in srgb, var(--muted) 18%, transparent); padding: 1px 4px; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>🧠 Snipurr v2 <span style="font-size:13px;border:var(--border);padding:2px 8px;background:var(--lime);color:#0a0a0a">SHADOW</span></h1>
  <div class="sub">Observing verified trades. Emits nothing, buys nothing — the legacy engine is still the only thing on the wire.</div>

  <div id="offbanner"></div>
  <div class="tiles" id="tiles"></div>

  <div class="grid">
    <div class="card wide">
      <h2>Decisions — including the skips</h2>
      <div class="tabs" id="tabs">
        <button class="tab" data-o="" aria-selected="true">All</button>
        <button class="tab" data-o="matched">Matched</button>
        <button class="tab" data-o="skipped">Skipped</button>
        <button class="tab" data-o="waiting">Waiting</button>
        <button class="tab" data-o="blocked">Blocked</button>
        <button class="tab" data-o="observed">Sells</button>
      </div>
      <div id="decisions"><div class="reason">loading…</div></div>
    </div>

    <div class="card">
      <h2>Fact coverage</h2>
      <div class="sub" style="margin:0 0 8px">How often each fact is actually established. A fact that never resolves is a broken enrichment, not a quiet market.</div>
      <div id="coverage"></div>
    </div>

    <div class="card">
      <h2>Near misses by lane</h2>
      <div class="sub" style="margin:0 0 8px">Which rule turns away the most trades, and by how much.</div>
      <div id="nearmiss"></div>
    </div>

    <div class="card">
      <h2>Lanes</h2>
      <div id="lanes"></div>
    </div>

    <div class="card wide">
      <h2>Scoreboard — what happened after each match</h2>
      <div class="sub" style="margin:0 0 8px">Peak return since the signal fired, bucketed. <b>unpriced</b> = never quotable, excluded from the averages. <b>late</b> = the baseline is a price from AFTER the signal, so those rows understate the move. Win = peak ≥ 50%, the same bar 47e1's record uses.</div>
      <div id="scoreboard"><div class="reason">loading…</div></div>
    </div>

    <div class="card wide">
      <h2>Diagnostics — every metric, with its age</h2>
      <div class="sub" style="margin:0 0 8px">A value without freshness cannot tell "just booted" from "broken". Ages update live; ⚠ means stale, ⏳ means never this boot.</div>
      <div id="diag"></div>
    </div>
  </div>

<script>
const $ = (id) => document.getElementById(id);
let outcome = '';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
};

async function load() {
  const [status, decisions, lanes, diag, outcomes] = await Promise.all([
    fetch('/api/v2/status').then((r) => r.json()).catch(() => ({})),
    fetch('/api/v2/decisions?limit=120' + (outcome ? '&outcome=' + outcome : '')).then((r) => r.json()).catch(() => ({ decisions: [] })),
    fetch('/api/v2/lanes').then((r) => r.json()).catch(() => ({ lanes: [] })),
    fetch('/api/debug/metrics').then((r) => r.json()).catch(() => null),
    fetch('/api/v2/outcomes?limit=1').then((r) => r.json()).catch(() => ({ enabled: false })),
  ]);

  $('offbanner').innerHTML = status.enabled
    ? ''
    : '<div class="card off"><b>Shadow is OFF.</b> Set <code>V2_SHADOW_ENABLED=true</code> to start observing. Nothing below will update until then.</div><br>';

  const c = status.outcomes || {};
  $('tiles').innerHTML = [
    ['matched', c.matched, 'matched'],
    ['skipped', c.skipped, ''],
    ['waiting', c.waiting, ''],
    ['blocked', c.blocked, ''],
    ['evaluated', status.seen, ''],
    ['🎁 allocs', (status.intake || {}).distributions, ''],
    ['sells', (status.intake || {}).verifiedSells, ''],
    ['pending', status.pending, ''],
  ].map(([k, n, cls]) => '<div class="tile ' + cls + '"><div class="n">' + (n ?? 0) + '</div><div class="k">' + k + '</div></div>').join('');

  const ix = status.intake || {};
  const rows = (decisions.decisions || []);
  const emptyMsg = ix.total
    ? 'No decisions yet — but the pipeline IS receiving traffic: ' + ix.total + ' events seen (' +
      (ix.distributions ?? 0) + ' allocations, ' + (ix.verifiedSells ?? 0) + ' verified sells, ' +
      (ix.verifiedBuys ?? 0) + ' verified buys, ' + (ix.unverified ?? 0) + ' unverified).'
    : 'No events have reached the pipeline yet. Verified trades AND allocations (transfers-in) enter it; decisions appear here as they arrive.';
  $('decisions').innerHTML = rows.length === 0
    ? '<div class="reason">' + esc(emptyMsg) + '</div>'
    : rows.map((d) =>
        '<div class="row">' +
          '<span class="badge b-' + esc(d.outcome) + '">' + esc(d.outcome) + '</span>' +
          '<span class="ev" title="' + esc(d.eventType || 'verified-buy') + '">' +
            (d.eventType === 'distribution' ? '🎁' : d.eventType === 'verified-sell' ? '🔻' : '🟢') + '</span>' +
          '<span class="sym">' + esc(d.tokenSymbol) + '</span>' +
          '<span class="score">' + (d.score == null ? '—' : d.score) + '</span>' +
          '<span class="reason">' + esc(d.reason) + '</span>' +
          '<span class="reason" style="flex:0;min-width:34px;text-align:right">' + ago(d.at) + '</span>' +
        '</div>').join('');

  const cov = status.factCoverage || {};
  $('coverage').innerHTML = Object.keys(cov).length === 0
    ? '<div class="reason">no samples yet</div>'
    : Object.entries(cov).map(([fact, v]) =>
        '<div style="margin-bottom:8px"><b>' + esc(fact) + '</b> — ' + v.measuredPct + '% measured' +
        ' <span class="reason">(' + v.measured + ' ✅ / ' + v.unknown + ' ⏳ / ' + v.failed + ' ❌)</span>' +
        '<div class="bar"><i style="width:' + v.measuredPct + '%"></i></div></div>').join('');

  // The scoreboard. A bucket with nothing priced shows its counts and says so,
  // rather than rendering a 0% win rate that reads as "these all failed".
  if (!outcomes || outcomes.enabled === false) {
    $('scoreboard').innerHTML = '<div class="reason">Ledger is OFF. Set <code>V2_LEDGER_ENABLED=true</code> to start following matches to an outcome.</div>';
  } else {
    const s = outcomes.summary || {};
    const groups = [
      ['by lane', s.byLane], ['by seed tier', s.bySeedTier], ['by cap at entry', s.byCapBand],
      ['by pair age', s.byPairAge], ['solo vs wave', s.byCohort], ['by event type', s.byEventType],
    ];
    const head = '<div class="reason" style="margin-bottom:8px">' +
      (s.total ?? 0) + ' matches followed · ' + (s.priced ?? 0) + ' priced · ' + (s.open ?? 0) + ' still open · tracked ' + (s.trackHours ?? 24) + 'h</div>';
    const table = (rows) => (rows || []).filter((b) => b.count > 0).map((b) =>
      '<div class="row">' +
        '<span class="sym" style="min-width:120px">' + esc(b.label) + '</span>' +
        '<span class="score">' + b.count + '</span>' +
        '<span class="reason">' +
          (b.count === b.unpriced
            ? 'none priced yet — nothing measured'
            : 'win ' + b.winRatePct + '% · avg peak ' + b.avgMaxGainPct + '% · best ' + b.bestMaxGainPct + '%' +
              (b.unpriced ? ' · ' + b.unpriced + ' unpriced' : '') +
              (b.lateEntryPct ? ' · ' + b.lateEntryPct + '% late entry' : '')) +
        '</span>' +
      '</div>').join('');
    $('scoreboard').innerHTML = head + groups.map(([name, rows]) => {
      const body = table(rows);
      return body ? '<div style="margin-bottom:10px"><b>' + esc(name) + '</b>' + body + '</div>' : '';
    }).join('') || head + '<div class="reason">No matches followed yet.</div>';
  }

  const nm = status.nearMissesByLane || [];
  $('nearmiss').innerHTML = nm.length === 0
    ? '<div class="reason">no near misses yet</div>'
    : nm.map((n) =>
        '<div style="margin-bottom:8px"><b>' + esc(n.laneId) + '</b> — ' + n.n + '×' +
        n.examples.map((e) => '<div class="reason">· ' + esc(e) + '</div>').join('') + '</div>').join('');

  if (diag) {
    const fmtAge = (ms) => ms == null ? '⏳ never this boot' : (ms < 60000 ? Math.round(ms/1000)+'s ago' : Math.round(ms/60000)+'m ago');
    const rowsD = [];
    const met = diag.metrics || {};
    rowsD.push(['uptime', Math.round(diag.uptimeSeconds/60) + 'm', 'counters below reset at boot']);
    rowsD.push(['ws', met.wsConnected?.value ? 'connected' : 'DOWN', met.wsConnected?.note || '']);
    rowsD.push(['last block', met.lastBlock?.value ?? '—', fmtAge(met.lastBlock?.ageMs) + ' · ' + (met.lastBlock?.verdict || '')]);
    rowsD.push(['rpc latency', (met.rpcLatencyMs?.value ?? '—') + 'ms', fmtAge(met.rpcLatencyMs?.ageMs) + ' · ' + (met.rpcLatencyMs?.verdict || '')]);
    rowsD.push(['swaps (boot)', met.swaps?.sinceBoot ?? 0, fmtAge(met.swaps?.ageMs)]);
    rowsD.push(['swarms', (met.swarms?.sinceBoot ?? 0) + ' boot / ' + (met.swarms?.restoredHistory ?? 0) + ' restored', met.swarms?.note || '']);
    const ia = diag.v2?.intakeAges || {};
    rowsD.push(['v2 intake', JSON.stringify(diag.v2?.intake || {}), 'last: buy ' + fmtAge(ia.verifiedBuy) + ' · alloc ' + fmtAge(ia.distribution) + ' · sell ' + fmtAge(ia.verifiedSell)]);
    if (diag.price) rowsD.push(['price sweep', 'q=' + diag.price.backgroundQueue + ' prio=' + diag.price.priorityQueue, 'last ' + fmtAge(diag.price.lastSweepAgeMs) + ' · 429s: ' + diag.price.dex429Count]);
    rowsD.push(['journal', diag.v2?.journalEnabled ? 'writing' : 'off', diag.v2?.journalStopped || '']);
    $('diag').innerHTML = rowsD.map(([k, v, note]) =>
      '<div class="row"><span class="sym" style="min-width:110px">' + esc(k) + '</span>' +
      '<span class="score">' + esc(String(v)) + '</span>' +
      '<span class="reason">' + esc(String(note)) + '</span></div>').join('');
  }

  $('lanes').innerHTML = (lanes.lanes || []).map((l) =>
    '<div class="lane"><div class="name">' + esc(l.emoji) + ' ' + esc(l.name) + '</div>' +
    '<div class="sentence">' + esc(l.sentence) + '</div></div>').join('');
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  outcome = b.dataset.o;
  [...document.querySelectorAll('.tab')].forEach((t) => t.setAttribute('aria-selected', String(t === b)));
  load();
});

load();
setInterval(load, 5000);
</script>
</body>
</html>`;

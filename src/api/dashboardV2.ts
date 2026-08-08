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
 * DENSITY IS DELIBERATE. This is an operator's screen, watched for hours: one
 * line per decision, no wrapping, everything above the fold. The prose that used
 * to sit under each heading moved into `title` tooltips — it explained the
 * design once and then cost vertical space forever. Secondary panels are
 * <details>, collapsed by default, so the page opens on the two things that
 * matter (what it decided, and how those decisions turned out) and expands only
 * when something looks wrong.
 *
 * Neobrutalism to match snipurr.fun: flat surfaces, hard black borders, offset
 * shadows, lime accent — tightened to 2px borders and 3px shadows at this
 * density, since 3/6 at 12px reads as noise. Self-contained: no CDN, no build
 * step, no external fonts, since this is served straight off the engine.
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
    --line: #d9d9d2;
    --border: 2px solid var(--ink);
    --shadow: 3px 3px 0 var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #12120f; --card: #1c1c18; --ink: #f4f4f0; --muted: #9a9a92; --line: #2e2e28; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 10px;
    background: var(--paper); color: var(--ink);
    font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  /* ── top bar: identity, vitals and counters on one line ─────────────────── */
  .bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    border: var(--border); box-shadow: var(--shadow); background: var(--card);
    padding: 6px 8px; margin-bottom: 8px;
  }
  .bar h1 { font-size: 14px; margin: 0; letter-spacing: -0.02em; text-transform: uppercase; }
  .pill {
    border: var(--border); background: var(--lime); color: #0a0a0a;
    padding: 1px 6px; font-size: 10px; font-weight: 800; text-transform: uppercase;
  }
  .vitals { color: var(--muted); font-size: 11px; }
  .vitals b { color: var(--ink); font-weight: 800; }
  .spacer { flex: 1; }
  .chip {
    border: var(--border); background: var(--card); padding: 1px 7px;
    font-size: 11px; white-space: nowrap;
  }
  .chip b { font-size: 13px; font-weight: 800; }
  .chip.on { background: var(--lime); color: #0a0a0a; }

  /* ── layout: decisions lead, everything else is a rail ──────────────────── */
  .wrap { display: grid; gap: 8px; grid-template-columns: minmax(0, 1.9fr) minmax(300px, 1fr); }
  @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: var(--border); box-shadow: var(--shadow); padding: 8px; min-width: 0; }
  .card + .card { margin-top: 8px; }
  h2 {
    font-size: 10px; margin: 0 0 6px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); cursor: help;
  }
  details > summary {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); cursor: pointer; list-style: none; user-select: none;
  }
  details > summary::before { content: '▸ '; }
  details[open] > summary::before { content: '▾ '; }
  details > summary::-webkit-details-marker { display: none; }
  details[open] > summary { margin-bottom: 6px; }

  /* ── the decision line: one row, never wraps ────────────────────────────── */
  .rows { max-height: 62vh; overflow-y: auto; }
  .rail .rows { max-height: 30vh; }
  .r {
    display: flex; gap: 6px; align-items: baseline;
    padding: 2px 0; border-bottom: 1px solid var(--line); white-space: nowrap;
  }
  .r:last-child { border-bottom: 0; }
  .b { padding: 0 4px; border: 1px solid var(--ink); font-size: 9px; font-weight: 800; text-transform: uppercase; }
  .b-matched { background: var(--lime); color: #0a0a0a; }
  .b-skipped { background: transparent; color: var(--muted); border-color: var(--muted); }
  .b-waiting { background: var(--amber); color: #0a0a0a; }
  .b-blocked { background: var(--red); color: #fff; }
  .b-observed { background: var(--blue); color: #0a0a0a; }
  .sym { font-weight: 800; min-width: 66px; }
  .sc { font-weight: 800; min-width: 20px; text-align: right; }
  .why { color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .age { color: var(--muted); min-width: 26px; text-align: right; }
  .k { min-width: 104px; }
  .empty { color: var(--muted); white-space: normal; padding: 4px 0; }

  /* ── tabs ───────────────────────────────────────────────────────────────── */
  .tabs { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
  .tab {
    border: var(--border); background: var(--card); color: var(--ink);
    padding: 1px 7px; cursor: pointer; font: inherit; font-size: 10px;
    font-weight: 700; text-transform: uppercase;
  }
  .tab[aria-selected="true"] { background: var(--lime); color: #0a0a0a; }

  /* ── coverage bars, inline ──────────────────────────────────────────────── */
  .bar2 { height: 6px; border: 1px solid var(--ink); background: var(--card); width: 70px; }
  .bar2 > i { display: block; height: 100%; background: var(--lime); }
  .off { border: var(--border); border-color: var(--amber); background: color-mix(in srgb, var(--amber) 14%, transparent); padding: 6px; margin-bottom: 8px; }
  code { background: color-mix(in srgb, var(--muted) 18%, transparent); padding: 0 3px; }
</style>
</head>
<body>
  <div class="bar">
    <h1>🧠 Snipurr v2</h1>
    <span class="pill">shadow</span>
    <span class="vitals" id="vitals">…</span>
    <span class="spacer"></span>
    <span id="chips"></span>
  </div>

  <div id="offbanner"></div>

  <div class="wrap">
    <div>
      <div class="card">
        <div class="tabs" id="tabs">
          <button class="tab" data-o="" aria-selected="true">all</button>
          <button class="tab" data-o="matched">matched</button>
          <button class="tab" data-o="skipped">skipped</button>
          <button class="tab" data-o="waiting">waiting</button>
          <button class="tab" data-o="blocked">blocked</button>
          <button class="tab" data-o="observed">sells</button>
        </div>
        <div class="rows" id="decisions"><div class="empty">loading…</div></div>
      </div>

      <div class="card">
        <h2 title="Peak return since each signal fired. 'unpriced' never became quotable and is excluded from the averages; 'late' means the baseline is a price from AFTER the signal, so those rows understate the move. Win = peak ≥ 50%, the same bar 47e1's record uses.">scoreboard — what happened after each match</h2>
        <div id="scoreboard"><div class="empty">loading…</div></div>
      </div>
    </div>

    <div class="rail">
      <div class="card">
        <h2 title="How often each fact is actually established. A fact that never resolves is a broken enrichment, not a quiet market.">fact coverage</h2>
        <div id="coverage"></div>
      </div>

      <div class="card">
        <details open>
          <summary title="Which rule turns away the most trades, and by how much. This is the tuning signal.">near misses by lane</summary>
          <div class="rows" id="nearmiss"></div>
        </details>
      </div>

      <div class="card">
        <details>
          <summary>lanes</summary>
          <div id="lanes"></div>
        </details>
      </div>

      <div class="card">
        <details>
          <summary title="A value without freshness cannot tell 'just booted' from 'broken'. ⏳ means never this boot.">diagnostics — every metric, with its age</summary>
          <div class="rows" id="diag"></div>
        </details>
      </div>
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
const fmtAge = (ms) => ms == null ? '⏳ never' : (ms < 60000 ? Math.round(ms/1000)+'s' : Math.round(ms/60000)+'m');
const glyph = (t) => t === 'distribution' ? '🎁' : t === 'verified-sell' ? '🔻' : '🟢';

/** One dense line. The full text lives in the tooltip, since the row never wraps. */
const line = (cells, title) =>
  '<div class="r"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + cells.join('') + '</div>';

async function load() {
  const [status, decisions, lanes, diag, outcomes] = await Promise.all([
    fetch('/api/v2/status').then((r) => r.json()).catch(() => ({})),
    fetch('/api/v2/decisions?limit=200' + (outcome ? '&outcome=' + outcome : '')).then((r) => r.json()).catch(() => ({ decisions: [] })),
    fetch('/api/v2/lanes').then((r) => r.json()).catch(() => ({ lanes: [] })),
    fetch('/api/debug/metrics').then((r) => r.json()).catch(() => null),
    fetch('/api/v2/outcomes?limit=1').then((r) => r.json()).catch(() => ({ enabled: false })),
  ]);

  $('offbanner').innerHTML = status.enabled
    ? ''
    : '<div class="off"><b>Shadow is OFF.</b> Set <code>V2_SHADOW_ENABLED=true</code> to start observing. Nothing below will update until then.</div>';

  // Vitals: is the thing alive, and is it being fed? The two questions that
  // decide whether an empty list below is a quiet market or an outage.
  const met = (diag && diag.metrics) || {};
  const ia = (diag && diag.v2 && diag.v2.intakeAges) || {};
  $('vitals').innerHTML =
    'block <b>' + (met.lastBlock?.value ?? '–') + '</b> ' + fmtAge(met.lastBlock?.ageMs) +
    ' · head <b>' + (diag?.metrics?.headLatencyMs?.value ?? met.rpcLatencyMs?.value ?? '–') + 'ms</b>' +
    ' · up <b>' + (diag ? Math.round(diag.uptimeSeconds / 60) : '–') + 'm</b>' +
    ' · last alloc <b>' + fmtAge(ia.distribution) + '</b> · buy <b>' + fmtAge(ia.verifiedBuy) + '</b> · sell <b>' + fmtAge(ia.verifiedSell) + '</b>';

  const c = status.outcomes || {};
  const ix = status.intake || {};
  const led = status.ledger || {};
  $('chips').innerHTML = [
    ['matched', c.matched, 'on'],
    ['skip', c.skipped, ''],
    ['wait', c.waiting, ''],
    ['block', c.blocked, ''],
    ['🎁', ix.distributions, ''],
    ['🔻', ix.verifiedSells, ''],
    ['tracked', led.total, ''],
  ].map(([k, n, cls]) => '<span class="chip ' + cls + '"><b>' + (n ?? 0) + '</b> ' + k + '</span>').join(' ');

  const rows = decisions.decisions || [];
  const emptyMsg = ix.total
    ? 'No decisions yet — but the pipeline IS receiving traffic: ' + ix.total + ' events (' +
      (ix.distributions ?? 0) + ' allocations, ' + (ix.verifiedSells ?? 0) + ' sells, ' +
      (ix.verifiedBuys ?? 0) + ' buys, ' + (ix.unverified ?? 0) + ' unverified).'
    : 'No events have reached the pipeline yet. Verified trades AND allocations (transfers-in) enter it; decisions appear here as they arrive.';
  $('decisions').innerHTML = rows.length === 0
    ? '<div class="empty">' + esc(emptyMsg) + '</div>'
    : rows.map((d) => line([
        '<span class="b b-' + esc(d.outcome) + '">' + esc(d.outcome.slice(0, 5)) + '</span>',
        '<span>' + glyph(d.eventType) + '</span>',
        '<span class="sym">' + esc(d.tokenSymbol) + '</span>',
        '<span class="sc">' + (d.score == null ? '—' : d.score) + '</span>',
        '<span class="why">' + esc(d.reason) + '</span>',
        '<span class="age">' + ago(d.at) + '</span>',
      ], (d.eventType || '') + ' · ' + d.outcome + ' · ' + d.reason)).join('');

  const cov = status.factCoverage || {};
  $('coverage').innerHTML = Object.keys(cov).length === 0
    ? '<div class="empty">no samples yet</div>'
    : Object.entries(cov).map(([fact, v]) => line([
        '<span class="k">' + esc(fact) + '</span>',
        '<span class="bar2"><i style="width:' + v.measuredPct + '%"></i></span>',
        '<span class="sc">' + v.measuredPct + '%</span>',
        '<span class="why">' + v.measured + '✅ ' + v.unknown + '⏳ ' + v.failed + '❌</span>',
      ], fact + ': measured on ' + v.measuredPct + '% of sheets')).join('');

  // The scoreboard. A bucket with nothing priced says so, rather than rendering
  // a 0% win rate that reads as "these all failed".
  if (!outcomes || outcomes.enabled === false) {
    $('scoreboard').innerHTML = '<div class="empty">Ledger is OFF. Set <code>V2_LEDGER_ENABLED=true</code> to follow matches to an outcome.</div>';
  } else {
    const s = outcomes.summary || {};
    const groups = [
      ['lane', s.byLane], ['seed tier', s.bySeedTier], ['cap at entry', s.byCapBand],
      ['pair age', s.byPairAge], ['solo vs wave', s.byCohort], ['event type', s.byEventType],
    ];
    const head = '<div class="empty">' + (s.total ?? 0) + ' followed · ' + (s.priced ?? 0) +
      ' priced · ' + (s.open ?? 0) + ' open · ' + (s.trackHours ?? 24) + 'h window</div>';
    const table = (bs) => (bs || []).filter((b) => b.count > 0).map((b) => line([
        '<span class="k">' + esc(b.label) + '</span>',
        '<span class="sc">' + b.count + '</span>',
        '<span class="why">' + (b.count === b.unpriced
          ? 'none priced yet — nothing measured'
          : 'win ' + b.winRatePct + '% · avg ' + b.avgMaxGainPct + '% · best ' + b.bestMaxGainPct + '%' +
            (b.unpriced ? ' · ' + b.unpriced + ' unpriced' : '') +
            (b.lateEntryPct ? ' · ' + b.lateEntryPct + '% late' : '')) + '</span>',
      ], b.label + ': ' + b.count + ' matches, ' + b.unpriced + ' never priced')).join('');
    const body = groups.map(([name, bs]) => {
      const t = table(bs);
      return t ? '<div style="margin-top:6px"><b>' + esc(name) + '</b>' + t + '</div>' : '';
    }).join('');
    $('scoreboard').innerHTML = head + (body || '<div class="empty">No matches followed yet — records open as new matches fire.</div>');
  }

  const nm = status.nearMissesByLane || [];
  $('nearmiss').innerHTML = nm.length === 0
    ? '<div class="empty">no near misses yet</div>'
    : nm.map((n) => line([
        '<span class="k">' + esc(n.laneId) + '</span>',
        '<span class="sc">' + n.n + '</span>',
        '<span class="why">' + esc(n.examples[0] || '') + '</span>',
      ], n.examples.join(' | '))).join('');

  if (diag) {
    const d = [];
    d.push(['ws', met.wsConnected?.value ? 'connected' : 'DOWN', met.wsConnected?.note || '']);
    d.push(['block', met.lastBlock?.value ?? '—', fmtAge(met.lastBlock?.ageMs) + ' · ' + (met.lastBlock?.verdict || '')]);
    d.push(['head ms', met.headLatencyMs?.value ?? met.rpcLatencyMs?.value ?? '—', met.headSource?.value || '']);
    d.push(['swaps', met.swaps?.sinceBoot ?? 0, fmtAge(met.swaps?.ageMs) + ' · boot counter']);
    d.push(['swarms', (met.swarms?.sinceBoot ?? 0) + '/' + (met.swarms?.restoredHistory ?? 0), 'boot / restored']);
    d.push(['intake', JSON.stringify(diag.v2?.intake || {}), '']);
    if (diag.price) d.push(['price q', diag.price.backgroundQueue + '/' + diag.price.priorityQueue, 'swept ' + fmtAge(diag.price.lastSweepAgeMs) + ' · 429s ' + diag.price.dex429Count]);
    d.push(['journal', diag.v2?.journalEnabled ? 'writing' : 'off', diag.v2?.journalStopped || '']);
    $('diag').innerHTML = d.map(([k, v, note]) => line([
      '<span class="k">' + esc(k) + '</span>',
      '<span class="sc">' + esc(String(v)) + '</span>',
      '<span class="why">' + esc(String(note)) + '</span>',
    ], String(note))).join('');
  }

  $('lanes').innerHTML = (lanes.lanes || []).map((l) => line([
    '<span class="sym" style="min-width:0">' + esc(l.emoji) + ' ' + esc(l.name) + '</span>',
    '<span class="why">' + esc(l.sentence) + '</span>',
  ], l.conditions ? l.conditions.join(' · ') : l.sentence)).join('');
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

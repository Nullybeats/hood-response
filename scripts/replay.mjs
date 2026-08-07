// Replay a v2 journal through a rules module, deterministically.
//
//   node scripts/replay.mjs <journal-file-or-dir> [options]
//     --module ./dist/v2/rules.js   module exporting `replay(record, ctx)`; omit to only summarise
//     --kind trade,facts            only feed these record kinds to the module
//     --json                        emit each result as NDJSON on stdout (for diffing two runs)
//     --limit N                     stop after N matching records
//
// Why this exists: a rule change is only trustworthy if it can be evaluated
// against traffic that actually happened. The legacy engine had no such harness,
// which is how a dedup collision swallowed ENTRY alerts unnoticed — the bug was
// invisible precisely because nothing could re-ask "what would you have done?".
//
// DETERMINISM IS THE POINT. Two runs over the same journal with the same module
// must produce byte-identical output, or the harness proves nothing. That holds
// only while rules take their clock from the record (`record.at`) instead of
// reading Date.now() themselves — so this script passes the recorded clock in
// `ctx.now` and never exposes the real one. If a run diffs against itself, a
// rule is reading ambient state: that is a bug in the rule, and this is the tool
// that catches it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const KNOWN_SCHEMA_VERSIONS = new Set([1]);

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.error(
    'usage: node scripts/replay.mjs <journal-file-or-dir> [--module M] [--kind k1,k2] [--json] [--limit N]',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const target = argv[0];
const modulePath = flag('--module');
const kinds = flag('--kind') ? new Set(flag('--kind').split(',').map((s) => s.trim())) : null;
const asJson = argv.includes('--json');
const limit = flag('--limit') ? Number(flag('--limit')) : Infinity;

/** Segment files oldest-first, with the active journal last — the order they were written. */
function segmentsOf(path) {
  if (!existsSync(path)) {
    console.error(`replay: no such path: ${path}`);
    process.exit(1);
  }
  if (!statSync(path).isDirectory()) return [path];
  const files = readdirSync(path).filter((f) => f.startsWith('journal-v2') && f.endsWith('.ndjson'));
  // Rotated names carry an ISO stamp so they sort chronologically; the active
  // file has no stamp and is always the newest, hence sorted last explicitly.
  const active = files.filter((f) => f === 'journal-v2.ndjson');
  const rotated = files.filter((f) => f !== 'journal-v2.ndjson').sort();
  return [...rotated, ...active].map((f) => join(path, f));
}

function* records(paths) {
  for (const p of paths) {
    const text = readFileSync(p, 'utf8');
    let lineNo = 0;
    for (const line of text.split('\n')) {
      lineNo++;
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // A truncated tail is expected when a process died mid-append. Report it
        // rather than crashing: the rest of the journal is still evidence.
        console.error(`replay: skipping unparseable line ${p}:${lineNo}`);
        continue;
      }
      if (!KNOWN_SCHEMA_VERSIONS.has(rec.v)) {
        console.error(`replay: refusing unknown schema version ${rec.v} at ${p}:${lineNo}`);
        process.exit(2);
      }
      yield rec;
    }
  }
}

const paths = segmentsOf(resolve(target));
let mod = null;
if (modulePath) {
  mod = await import(resolve(modulePath));
  if (typeof mod.replay !== 'function') {
    console.error(`replay: ${modulePath} does not export replay(record, ctx)`);
    process.exit(1);
  }
}

const tally = Object.create(null);
let seen = 0;
let fed = 0;
let firstAt = null;
let lastAt = null;

for (const rec of records(paths)) {
  seen++;
  tally[rec.kind] = (tally[rec.kind] ?? 0) + 1;
  if (firstAt === null) firstAt = rec.at;
  lastAt = rec.at;
  if (kinds && !kinds.has(rec.kind)) continue;
  if (fed >= limit) break;
  fed++;
  if (!mod) continue;
  // The recorded clock, never the real one — see the determinism note above.
  const out = mod.replay(rec, { now: rec.at, seq: rec.seq });
  if (asJson && out !== undefined) process.stdout.write(`${JSON.stringify(out)}\n`);
}

const span = firstAt != null && lastAt != null ? `${new Date(firstAt).toISOString()} .. ${new Date(lastAt).toISOString()}` : 'empty';
console.error(
  [
    `replay: ${paths.length} segment(s), ${seen} record(s), ${fed} fed to module`,
    `  span:  ${span}`,
    `  kinds: ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}`,
    mod ? `  module: ${modulePath}` : '  module: (none — summary only)',
  ].join('\n'),
);

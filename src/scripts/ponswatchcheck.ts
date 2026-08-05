import { PonsWatcher } from '../pons/watch.js';

/**
 * Dry-run verification for the Pons watcher: does it detect real launches and fire at the gate?
 *
 *   PONS_ENABLED=1 PONS_DRY_RUN=1 npx tsx src/scripts/ponswatchcheck.ts [seconds]
 *
 * Read-only — it never touches the engine, a wallet or a key. The "dead window" it prints is the
 * 0-12s L1 gate, and seeing it land in that range is the check that the gate math is right live.
 */
const SECS = Number(process.argv[2]) || 100;
const t0 = Date.now();
let seen = 0;
const w = new PonsWatcher((l) => {
  seen++;
  console.log(
    `GATE OPEN -> would buy ${l.token} fee=${l.fee} ` +
      `selfBuy=${(Number(l.initialBuyWei) / 1e18).toFixed(4)}E ` +
      `deadWindow=${((Date.now() - l.seenAt) / 1000).toFixed(1)}s`,
  );
});
w.start();
setTimeout(() => {
  console.log(`\n--- after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${seen} launches reached their gate, ${w.armedCount()} still armed ---`);
  w.stop();
  process.exit(0);
}, SECS * 1000);

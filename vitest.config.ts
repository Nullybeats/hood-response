import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Tests must never touch a real store.
     *
     * SniperEngine and PerformanceTracker take their persistence paths from env, and the tests
     * construct them without an explicit `storePath` — so they inherit whatever the ambient
     * environment says. Running `npm test` on the box therefore wrote a synthetic position
     * (`token: "0xtok"`, `symbol: "GEM"`, `buyTx: "0xb"`) into the LIVE store at
     * SNIPER_STORE_PATH, where it sat marked `"status":"open"`.
     *
     * That was not merely untidy. `SniperRegistry` seeds a tenant from the legacy store the first
     * time an owner has no file of their own (registry.ts, guarded by SNIPER_LEGACY_OWNER) — so a
     * missing tenant file would have imported the fake position as a real open one, and the engine
     * would then try to manage a token that does not exist.
     *
     * Blanking the paths makes every persistence path a no-op — engine.ts and performance.ts both
     * begin their load/save with `if (!<path>) return`. Set them explicitly in a test that needs
     * persistence, pointing at a tmp dir.
     */
    env: {
      SNIPER_STORE_PATH: '',
      SNIPER_JOURNAL_PATH: '',
      PERF_STORE_PATH: '',
      // Same rule for the attribution ledger: a test must never write into a
      // real ledger. Tests that need one pass an explicit tmp path.
      ATTRIB_LEDGER_PATH: '',
    },
    server: {
      deps: {
        // Vite rewrites `node:sqlite` to a bare `sqlite` specifier and then
        // cannot resolve it, so any suite importing the SQLite-backed stores
        // fails to collect. Externalising it hands the import back to Node,
        // which has the built-in.
        external: [/^node:sqlite$/],
      },
    },
  },
});

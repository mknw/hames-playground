/**
 * The e2e runner — a SEPARATE vitest, on purpose.
 *
 * `app/vitest.config.ts` is the CI suite: jsdom, coverage floors, and a
 * `test.include` rooted at `src/`. This config shares none of that. Keeping the
 * two apart is what makes the isolation structural rather than conventional —
 * the same discipline `app/evals/` uses, and `src/__tests__/e2e-not-in-ci.test.ts`
 * pins every row of it:
 *
 *   - nothing here lives under `src/`, so the CI config's globs cannot see it;
 *   - no file is named `*.test.ts`, so a widened glob still would not match;
 *   - `pnpm test:e2e` is a standalone script with no `pre*` hook chaining it;
 *   - `.github/workflows/ci.yml` never invokes it;
 *   - nothing under `src/` imports from `e2e/`.
 *
 * Why a whole config rather than a project entry: these scenarios need a node
 * environment (they import `.server.ts` modules and open sockets), a single
 * process (one fake endpoint, one pattern cache, one database view), no
 * parallelism (the cold-start scenario would otherwise race the others for
 * wall-clock), and minute-scale timeouts. Every one of those is wrong for the
 * unit suite.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Matches the unit suite's target so both write to the throwaway database. */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/kgagent_test'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    name: 'e2e',
    environment: 'node',
    globals: true,
    include: ['e2e/scenarios/**/*.e2e.ts'],
    // Provisions `kgagent_test` if it does not exist. Shared with the unit
    // suite rather than copied — the two must agree on the target, or one of
    // them is writing somewhere nobody cleans up.
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./e2e/setup.ts'],
    // One process, one file at a time. See the header. `isolate: false` is
    // the load-bearing half: without it each file gets a fresh module graph,
    // so `bootApp`'s process-wide singleton would boot a second fake endpoint
    // per file and the pattern cache would never be shared the way it is in a
    // running server.
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    fileParallelism: false,
    // The cold-start scenario deliberately withholds a response for
    // E2E_COLD_START_MS (default 90s), and a turn makes several calls after
    // it lands. Ten minutes is the envelope, not an expectation.
    testTimeout: 600_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    // Coverage is meaningless here and actively misleading: these scenarios
    // walk most of the app, so counting them would inflate the number the CI
    // floors are read against.
    coverage: { enabled: false },
    env: {
      // Read by `setup.ts` and by `lib/app.ts`. Set here rather than in a
      // shell so the suite behaves the same however it is invoked.
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      // Same key the unit suite uses — both write to `kgagent_test`, and
      // `initSchema()`'s backfill would fight two different keys.
      DATA_ENCRYPTION_KEY: 'unit-test-data-encryption-key',
      // The turn path authenticates through `getAuthenticatedUser()` unless
      // the dev bypass is on, and there is no Entra session in a test process.
      // Both halves of the gate are required: `import.meta.env.DEV` is already
      // true under vitest, this is the explicit opt-in (`lib/auth/dev-bypass.ts`).
      VITE_DEV_BYPASS_AUTH: 'true',
      // Keep BAML's own logging out of the run unless someone asks for it.
      BAML_LOG: process.env.BAML_LOG ?? 'warn',
    },
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
})

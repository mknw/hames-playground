/**
 * The browser runner — a SEPARATE tool, on purpose.
 *
 * `app/vitest.config.ts` is the CI suite (jsdom, coverage floors, `src/**`).
 * `app/e2e/vitest.config.ts` is the app-path suite (node, real Postgres, the
 * server action called as a function). This config shares nothing with either,
 * and that is what makes the isolation structural rather than conventional —
 * the same discipline `app/evals/` and `app/e2e/` use, pinned by
 * `src/__tests__/browser-e2e-not-in-ci.test.ts`:
 *
 *   - nothing here lives under `src/`, so the CI config's globs cannot see it;
 *   - no file is named `*.test.ts`, so a widened vitest glob still misses;
 *   - vitest cannot run a Playwright suite at all — different runner, different
 *     assertion library — so a stray `include` would error rather than silently
 *     add minutes to every push;
 *   - `pnpm test:e2e:browser` is standalone, with no `pre*` hook chaining it;
 *   - `.github/workflows/ci.yml` never invokes it, and never installs a browser.
 *
 * WHY IT MUST NOT BE A MERGE GATE. It needs a Postgres, a ~95 MB browser
 * download, and a `vinxi dev` boot per run; it drives a real dev server whose
 * compile times are a developer's machine, not a hermetic image. A CI job that
 * picked it up would take minutes longer and go red on someone else's docker —
 * turning a diagnostic into a gate. That is the same judgement `app/e2e/`
 * records, one layer up.
 */
import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { APP_URL } from './lib/env'

export default defineConfig({
  testDir: fileURLToPath(new URL('./scenarios', import.meta.url)),
  // Not `*.spec.ts` and not `*.test.ts`: the suffix is the last line of defence
  // if someone widens a vitest glob to `**/*.test.ts`.
  testMatch: /.*\.browser\.ts/,

  // One server, one fake endpoint, one database view, one dev-bypass user whose
  // rows every scenario file wipes. Parallel workers would race all four. The
  // suite is small and its cost is the dev-server boot, which is paid once.
  workers: 1,
  fullyParallel: false,

  // A red scenario here is a finding about the app, and a retry that turns it
  // green is a finding erased. `app/e2e/` makes the same choice by having no
  // retry mechanism at all.
  retries: 0,

  // Generous: one scenario deliberately sits through a simulated cold start,
  // and a turn behind a cold vite dev server is not fast.
  timeout: 120_000,
  expect: { timeout: 20_000 },

  globalSetup: fileURLToPath(new URL('./global-setup.ts', import.meta.url)),

  reporter: process.env.CI ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: APP_URL,
    // Evidence for a red run, nothing for a green one.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  outputDir: fileURLToPath(new URL('./.runtime/results', import.meta.url)),

  projects: [
    {
      name: 'chromium',
      // Headless, and only chromium. This layer's claim is "a real browser ran
      // the real app", not "the app works in four engines" — cross-browser
      // rendering is a different question with a different cost, and adding
      // engines here would triple a suite whose findings do not vary by engine.
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

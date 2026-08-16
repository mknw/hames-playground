import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Still emit the report when a test fails, so a red run tells you both
      // what broke and where coverage stands.
      reportOnFailure: true,
      // Extension-filtered: a bare `src/**` makes v8 try to instrument the
      // markdown under src/, which fails to parse and spills a rollup stack
      // trace into the very log the gate is meant to make legible.
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: [
        'baml_client/**',
        '.output/**',
        '.vinxi/**',
        // Mirrors test.include above — tests are globbed at any depth, so a
        // colocated __tests__/ dir must not start counting as source.
        'src/**/__tests__/**',
        '**/*.d.ts',
        '**/*.config.{ts,js,mts,mjs}',
        // No test imports it, and its `virtual:uno.css` import cannot resolve
        // under this config (no UnoCSS plugin here), so v8 falls back to
        // parsing the raw file without JSX and throws. It was already being
        // dropped from the report — naming it just keeps the stack trace out
        // of the log. Drop this line if a test ever mounts the app shell.
        'src/app.tsx',
        // Manual smoke-test scripts (run by hand against a live sandbox),
        // not unit-testable — recommendation from the sandbox coverage lane.
        'src/lib/sandbox/scripts/smoke-*.ts',
      ],
      // Backstop floors, not aspirations. Measured on 2026-08-16 against the
      // scope above (post smoke-script exclude) and set 2pp below the
      // baseline so ordinary churn does not trip the gate. This closes the
      // 85%-coverage programme (PRs #182-#189), which raised repo-wide
      // coverage from ~52% to:
      //   statements 95.26  branches 84.87  functions 94.58  lines 96.57
      // The job fails if coverage drops below these. Raise them by hand as
      // coverage grows; never lower them to make a red run green.
      thresholds: {
        statements: 93,
        branches: 82,
        functions: 92,
        lines: 94,
      },
    },
  },
  resolve: {
    conditions: ['development', 'browser'],
    alias: {
      // Mirror SolidStart's `~` → src/ alias so components that use it
      // (e.g. AllGraphTab → ~/lib/turn-utils) are importable from tests.
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})

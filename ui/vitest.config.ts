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
      ],
      // Backstop floors, not aspirations. Measured on 2026-08-16 against the
      // scope above and set 2pp below the baseline so ordinary churn does not
      // trip the gate. Baseline is the CI number (Node 22, run 31914658201),
      // which is the authoritative one — local Node 24 reads ~1pp higher:
      //   statements 45.21  branches 47.48  functions 32.96  lines 49.85
      // The job fails if coverage drops below these. Raise them by hand as
      // coverage grows; never lower them to make a red run green.
      thresholds: {
        statements: 43,
        branches: 45,
        functions: 30,
        lines: 47,
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

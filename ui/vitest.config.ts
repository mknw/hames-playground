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
      include: ['src/**'],
      exclude: [
        'baml_client/**',
        '.output/**',
        '.vinxi/**',
        'src/__tests__/**',
        '**/*.d.ts',
        '**/*.config.{ts,js,mts,mjs}',
      ],
      // Backstop floors, not aspirations. Measured on 2026-08-16 against
      // src/** and set 2pp below the baseline so ordinary churn does not
      // trip the gate:
      //   statements 46.12  branches 47.91  functions 34.21  lines 50.85
      // The job fails if coverage drops below these. Raise them by hand as
      // coverage grows; never lower them to make a red run green.
      thresholds: {
        statements: 44,
        branches: 45,
        functions: 32,
        lines: 48,
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

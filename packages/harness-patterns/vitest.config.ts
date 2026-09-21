import { defineConfig } from 'vitest/config'

// The package's OWN suite: the co-located tests that moved with the modules
// (core-absorb PR-1, 2026-09). They run in a plain node environment — no
// jsdom, no app test database, no `~` alias — because everything they import
// is either this package or its declared dependencies. A test that needs app
// code belongs in the app's `src/__tests__/` tree, not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})

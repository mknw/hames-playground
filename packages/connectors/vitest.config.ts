import { defineConfig } from 'vitest/config'

// The package's OWN suite: the co-located tests that moved with the code
// (#225 PR-C2). They run in a plain node environment — no jsdom, no app test
// database, no `~` alias — because everything they import is either this
// package, its two declared dependencies, or their own fixtures. A test that
// needs app code belongs in the app's `src/__tests__/` tree, not here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})

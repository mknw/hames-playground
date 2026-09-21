import { defineConfig } from 'vitest/config'

// The package's OWN suite: the co-located tests that moved with the code
// (the @hames/sandbox extraction). Plain node environment — no jsdom, no app
// test database, no `~` alias — because everything they import is either this
// package, its declared dependencies, or their own fixtures. A test that needs
// app code (the composition root, the request scope) belongs in the app's
// `src/__tests__/` tree, not here; so does a test of repo-root infrastructure
// — `rootfs/egress-proxy/proxy.mjs` is built and shipped by the repo, not by
// this package, and its suite stayed behind with it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})

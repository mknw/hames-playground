import { defineConfig } from 'vitest/config'

// The package's OWN suite: the co-located tests that moved with the code
// (the @hames-ai/sandbox extraction). Plain node environment — no jsdom, no app
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
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      // Still emit the report when a test fails, so a red run tells you both
      // what broke and where coverage stands (the app config's reasoning).
      reportOnFailure: true,
      // Exactly what the tarball ships: the top-level modules the manifest's
      // `files` allowlist names. Both halves are load-bearing and they do
      // DIFFERENT jobs — `include` decides which never-loaded files are still
      // counted (at 0%), `exclude` is the only thing that drops a file the
      // suite DID load.
      //
      // So `include: ['*.ts']` is what keeps `scripts/smoke-{llm,scripted}.ts`
      // out: 78 statements no hermetic run can reach, because they are the
      // live-container smoke checks driven by hand against a docker daemon,
      // and they do not ship either. Same call the app config makes for
      // `src/lib/**/scripts/smoke-*.ts`, for the same reason. The excludes then
      // drop the two files the suite loads but that are not this package's
      // shipped surface: `__tests__/` (tests are not source — the app config's
      // rule) and `scripts/_shared.ts`, the smoke scripts' helper, which rides
      // in at 38/38 lines and would otherwise flatter the floor with coverage
      // of something the tarball does not contain.
      include: ['*.ts'],
      exclude: ['vitest.config.ts', '__tests__/**', 'scripts/**'],
      // Backstop floors, not aspirations — the app's convention (see
      // `app/vitest.config.ts`), and the answer to the #365 post-merge
      // review's O1: the extraction moved this package's tests out of the
      // app's run, `app/vitest.config.ts` correctly dropped it from
      // `coverage.include` (instrumented-but-unexercised source would only
      // drag the app's floors down), and the net was the whole containment
      // layer sitting outside the repo's only coverage gate with nothing in
      // its place — on the one package where that gate mattered most.
      //
      // MEASURED on this suite, 2026-09-21 — 293 tests over the 14 shipped
      // modules above:
      //   statements 99.00  branches 90.17  functions 81.72  lines 99.32
      // …and each floor set ~2pp under its reading, so ordinary churn does not
      // trip the gate. Functions sits lowest because several modules export
      // narrow helpers the suite reaches only through their callers; that is a
      // real number, not an aspiration, and it is the one to raise first.
      // Raise them by hand as coverage grows; never lower them to make a red
      // run green.
      thresholds: {
        statements: 97,
        branches: 88,
        functions: 79,
        lines: 97,
      },
    },
  },
})

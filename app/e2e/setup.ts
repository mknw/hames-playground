/**
 * Per-file setup for the e2e suite.
 *
 * Deliberately thin. Everything that has to happen BEFORE an app module is
 * imported lives in `lib/app.ts#bootApp`, because ordering is the constraint
 * (see that file's header) and a setup file cannot express "after the fakes are
 * listening". What is left here is the environment `vitest.config.ts` cannot
 * express as a static value, and the one check every test gets: no fake
 * refused a request.
 */
import { afterEach } from 'vitest'

// Vitest's `test.env` writes strings; anything derived from them belongs here.
// `NODE_ENV=test` is what tells `pg` and friends they are not in production.
process.env.NODE_ENV ??= 'test'

// A hermetic run must never reach a real provider. `lib/app.ts` overwrites the
// Anthropic key as well; this refuses the far more common mistake of a
// developer exporting `USE_VERDA_INFERENCE=1` in their shell and quietly
// changing which tier every scenario measures.
delete process.env.USE_VERDA_INFERENCE

// Failing closed is structural, not something each scenario has to remember
// (#433 S9). Inside a turn a fake's refusal becomes a failed tool result or a
// failed ingest, which the turn can survive, so after EVERY test a request the
// Graph or converter fake refused fails that test. Both are checked and both
// are reset, so one refusal never carries into the next test's verdict. The
// import is dynamic so no lib module loads before the lines above have run.
afterEach(async () => {
  const { peekBootedApp } = await import('./lib/app')
  const app = await peekBootedApp()?.catch(() => null)
  if (!app) return
  const failures: string[] = []
  for (const fake of [app.fakeGraph, app.fakeConverter]) {
    try {
      fake.assertAllMatched()
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
    fake.reset()
  }
  if (failures.length > 0) throw new Error(failures.join('\n'))
})

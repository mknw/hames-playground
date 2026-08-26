/**
 * Per-file setup for the e2e suite.
 *
 * Deliberately thin. Everything that has to happen BEFORE an app module is
 * imported lives in `lib/app.ts#bootApp`, because ordering is the constraint
 * (see that file's header) and a setup file cannot express "after the fakes are
 * listening". What is left here is the environment `vitest.config.ts` cannot
 * express as a static value.
 */

// Vitest's `test.env` writes strings; anything derived from them belongs here.
// `NODE_ENV=test` is what tells `pg` and friends they are not in production.
process.env.NODE_ENV ??= 'test'

// A hermetic run must never reach a real provider. `lib/app.ts` overwrites the
// Anthropic key as well; this refuses the far more common mistake of a
// developer exporting `USE_VERDA_INFERENCE=1` in their shell and quietly
// changing which tier every scenario measures.
delete process.env.USE_VERDA_INFERENCE

/**
 * Server middleware — the app's server-boot hook.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Three things today: the routine scheduler
 * (#131) — whose tick also reconciles runs abandoned at `status='running'`, and
 * which sweeps once here at boot for exactly the rows the previous process left
 * behind (#273 D-a) — the LLM-usage recorder behind the preview header's global
 * counters, and the dev-only inference redirect the browser e2e layer reaches
 * through.
 *
 * The first two are import side effects, so they cost nothing per request. The
 * third needs an `await`, and must not be reachable from module scope at all;
 * see below.
 */

import { createMiddleware } from '@solidjs/start/middleware'
import { startRoutineScheduler } from './lib/routines/scheduler.server'
import { installUsageRecorder } from './lib/metrics/usage-recorder.server'
import {
  devFakeInferenceUrl,
  installDevFakeInference,
} from './lib/inference/dev-fake-inference.server'

// Both are idempotent and HMR-safe (the armed timer / install flag are parked
// on globalThis symbols), so a dev-server module reload doesn't stack a second
// timer or a second usage listener that would double-count every LLM call.
startRoutineScheduler()
installUsageRecorder()

/**
 * The dev-only inference redirect (`app/e2e-browser/`) — armed on the first
 * request and then already resolved for every later one.
 *
 * ## Why the `import()` is inside the handler
 *
 * Nothing in THIS MODULE'S STATIC-IMPORT CLOSURE may import `baml_client` or
 * `@boundaryml/baml` at module scope. That is the rule, and it is narrower than
 * "nothing in `src/` does" — which is simply untrue: `harness-patterns`'
 * patterns and adapters take a module-scope `Collector`, and
 * `agents/title-generator.server.ts` imports `b` itself. Those are fine
 * precisely because nothing reaches them from here.
 *
 * The house idiom for a call site that IS reachable from the entry is
 * `const { b } = await import('…/baml_client')` INSIDE an async function, which
 * is what keeps the native runtime out of the server entry chunk. The first
 * draft of this file broke that by creating the promise at module scope — nitro
 * then linked `@boundaryml/baml` into `.output/server/index.mjs` itself and the
 * production container died at boot with `Cannot find module
 * '…/@boundaryml/baml/native'` before serving a single request. `pnpm build`
 * passes either way; CI's `docker image · build · boot` job is what caught it.
 *
 * The closure is walked and pinned by
 * `src/__tests__/browser-e2e-not-in-ci.test.ts`, so adding an import here — or
 * anywhere below here — that drags BAML in fails on every push rather than only
 * in the docker job.
 *
 * ## Why a handler at all rather than a top-level await
 *
 * Nitro transpiles the server bundle to es2019, where top-level `await` is a
 * build error. `onRequest` is the next-best ordering guarantee and is in fact
 * sufficient: SolidStart awaits it before handling, and the first BAML call is
 * inside a request, so the redirect is provably in place before it.
 *
 * ## Why it costs production nothing
 *
 * `devFakeInferenceUrl()` returns `null` unless `import.meta.env.DEV` — a
 * constant a build replaces with `false` — so `onRequest` is `undefined` and
 * there is no per-request hook at all.
 */
let fakeInferenceReady: Promise<unknown> | null = null

export default createMiddleware({
  onRequest: devFakeInferenceUrl()
    ? async () => {
        fakeInferenceReady ??= import('../baml_client').then(({ b }) => installDevFakeInference(b))
        await fakeInferenceReady
      }
    : undefined,
})

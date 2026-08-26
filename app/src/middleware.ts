/**
 * Server middleware — the app's server-boot hook.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Three things today: the routine scheduler
 * (#131), the LLM-usage recorder behind the preview header's global counters,
 * and the dev-only inference redirect the browser e2e layer reaches through.
 *
 * The first two are import side effects, so they cost nothing per request. The
 * third needs an `await` and therefore a handler; see below.
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
 * The dev-only inference redirect (`app/e2e-browser/`), or `null` — which is
 * every ordinary `pnpm dev` and EVERY production build, because
 * `devFakeInferenceUrl()`'s first gate is `import.meta.env.DEV`, a constant
 * Vite replaces with `false`. The import is dynamic so an ordinary `pnpm start`
 * never pulls the BAML native runtime into server boot for a hook that cannot
 * fire.
 *
 * NOT awaited at the top level: nitro transpiles the server bundle to es2019,
 * where top-level await is a build error rather than a slower build. So the
 * promise is parked here and awaited in `onRequest` instead, which SolidStart
 * awaits before handling — the redirect is provably in place before the first
 * BAML call, because the first BAML call is inside a request.
 */
const fakeInferenceReady = devFakeInferenceUrl()
  ? import('../baml_client').then(({ b }) => installDevFakeInference(b))
  : null

export default createMiddleware({
  // `undefined` in production, so there is no per-request hook at all there.
  onRequest: fakeInferenceReady ? async () => void (await fakeInferenceReady) : undefined,
})

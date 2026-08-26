/**
 * Server middleware — the app's server-boot hook.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Two things today: the routine scheduler (#131)
 * — whose tick also reconciles runs abandoned at `status='running'`, and which
 * sweeps once here at boot for exactly the rows the previous process left
 * behind (#273 D-a) — and the LLM-usage recorder behind the preview header's
 * global counters.
 *
 * There are no request/response handlers here on purpose — the arming is the
 * module's import side effect, so it costs nothing per request. If a real
 * middleware handler is ever needed, add it to the `createMiddleware` call
 * below; the arming stays where it is.
 */

import { createMiddleware } from '@solidjs/start/middleware'
import { startRoutineScheduler } from './lib/routines/scheduler.server'
import { installUsageRecorder } from './lib/metrics/usage-recorder.server'

// Both are idempotent and HMR-safe (the armed timer / install flag are parked
// on globalThis symbols), so a dev-server module reload doesn't stack a second
// timer or a second usage listener that would double-count every LLM call.
startRoutineScheduler()
installUsageRecorder()

export default createMiddleware({})

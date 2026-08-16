/**
 * Server middleware — the app's server-boot hook.
 *
 * SolidStart imports this module once when the server handler graph loads,
 * before any request is served, which makes it the natural place to arm
 * process-wide background work. Today that's exactly one thing: the routine
 * scheduler (#131).
 *
 * There are no request/response handlers here on purpose — the arming is the
 * module's import side effect, so it costs nothing per request. If a real
 * middleware handler is ever needed, add it to the `createMiddleware` call
 * below; the arming stays where it is.
 */

import { createMiddleware } from '@solidjs/start/middleware'
import { startRoutineScheduler } from './lib/routines/scheduler.server'

// Idempotent and HMR-safe (the armed timer is parked on a globalThis symbol),
// so a dev-server module reload doesn't stack a second timer.
startRoutineScheduler()

export default createMiddleware({})

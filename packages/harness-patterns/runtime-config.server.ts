/**
 * Runtime-config reader (server-only).
 *
 * The budgets and truncation limits every pattern reads at execution time —
 * instead of threading them through every signature, and instead of importing
 * host-app code, which an installed tarball cannot resolve.
 *
 * The VALUE lives in the run frame's `config` slot (`run-frame.server.ts`); this
 * module is just the typed reader and the re-export point the patterns import
 * from. The scope this module used to own (`withRuntimeConfig`) is gone: a host
 * supplies its settings when it opens the frame, and the library defaults apply
 * inside a frame whose `config` slot nobody filled.
 *
 * NO FALL-BACK OUTSIDE A FRAME (ruling D3, issue #374). `runtimeConfig()` used
 * to answer `DEFAULT_RUNTIME_CONFIG` outside any scope, which meant a host that
 * forgot to open one got the library's budgets instead of its own, silently, on
 * every turn. It now refuses, because `activeRunFrame()` refuses — the same rule
 * as the guard and the tier, applied to the one slot that had been quietly
 * papering over its own absence.
 */
import { assertServerOnImport } from './assert.server'
import { activeRunFrame } from './run-frame.server'
import type { HarnessRuntimeConfig } from './runtime-config'

assertServerOnImport()

export { DEFAULT_RUNTIME_CONFIG, RUNTIME_CONFIG_BOUNDS, resolveTurnBudget } from './runtime-config'
export type { HarnessRuntimeConfig } from './runtime-config'

/**
 * This run's runtime config — the host's settings when it supplied any, the
 * library defaults otherwise.
 *
 * THROWS outside a run frame. See the module docstring: the fall-back it
 * replaced could not distinguish "this host wants the defaults" from "this host
 * never opened a frame", and only one of those is safe.
 */
export function runtimeConfig(): HarnessRuntimeConfig {
  return activeRunFrame().config
}

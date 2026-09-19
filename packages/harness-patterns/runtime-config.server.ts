/**
 * Runtime-config scope (server-only).
 *
 * AsyncLocalStorage frame carrying {@link HarnessRuntimeConfig} — the same
 * shape as the host app's `runWithSettings`/`getRequestSettings` pair, so a
 * pattern reads its budgets at execution time instead of threading them
 * through every signature (and instead of importing host-app code, which an
 * installed tarball cannot resolve).
 *
 * The host app opens this scope with its own (extended) settings object; a
 * standalone consumer gets the library defaults. Outside any scope,
 * `runtimeConfig()` returns `DEFAULT_RUNTIME_CONFIG` — the same fall-back
 * rule the app's reader used for background work.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
import { DEFAULT_RUNTIME_CONFIG, type HarnessRuntimeConfig } from './runtime-config'

assertServerOnImport()

export { DEFAULT_RUNTIME_CONFIG, RUNTIME_CONFIG_BOUNDS, resolveTurnBudget } from './runtime-config'
export type { HarnessRuntimeConfig } from './runtime-config'

const runtimeStore = new AsyncLocalStorage<HarnessRuntimeConfig>()

/**
 * Run an async function with a request-scoped runtime config.
 * Patterns called within `fn` can access it via `runtimeConfig()`.
 * An absent config runs with the library defaults.
 */
export function withRuntimeConfig<T>(
  config: HarnessRuntimeConfig | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runtimeStore.run(config ?? DEFAULT_RUNTIME_CONFIG, fn)
}

/**
 * The current request's runtime config. Returns `DEFAULT_RUNTIME_CONFIG` when
 * called outside a `withRuntimeConfig` scope (e.g. during background work),
 * mirroring the host app's previous fall-back behaviour.
 */
export function runtimeConfig(): HarnessRuntimeConfig {
  return runtimeStore.getStore() ?? DEFAULT_RUNTIME_CONFIG
}

/**
 * The current runtime config, or `undefined` outside a scope — for a host that
 * needs to distinguish "in scope" from "fell back to defaults" (the app's
 * reader keeps returning its own FULL defaults, including settings this
 * library does not know about, when no scope is open).
 */
export function tryRuntimeConfig(): HarnessRuntimeConfig | undefined {
  return runtimeStore.getStore()
}

/**
 * Request-scoped settings context — the app's EXTENSION of the library's
 * runtime-config scope.
 *
 * The package (`@hames/harness-patterns/runtime-config.server`) owns the
 * AsyncLocalStorage frame, the six core knobs and their defaults; this module
 * opens that scope with the app's full `HarnessSettings` (which structurally
 * extends `HarnessRuntimeConfig`), so the package's `runtimeConfig()` readers
 * pick up the app's overrides at execution time — no need to thread settings
 * through every function signature, and no import of app code from the package
 * (a consumer's installed tarball cannot resolve it).
 */
import { tryRuntimeConfig, withRuntimeConfig } from '@hames/harness-patterns/runtime-config.server'
import { DEFAULT_SETTINGS, type HarnessSettings } from './settings'

/**
 * Run an async function with request-scoped settings.
 * Patterns called within `fn` can access settings via getRequestSettings();
 * the package's own readers resolve the same scope via `runtimeConfig()`.
 */
export function runWithSettings<T>(
  settings: HarnessSettings | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withRuntimeConfig(settings ?? DEFAULT_SETTINGS, fn)
}

/**
 * Get the current request's settings.
 *
 * Inside a `runWithSettings` scope the store holds exactly the
 * `HarnessSettings` that was passed in; outside one (e.g. during background
 * summarization) this falls back to the app's FULL defaults — including
 * `maxConcurrentRuns` and `sandbox`, which the library's defaults do not
 * carry — exactly as this reader did before the scope moved into the library.
 */
export function getRequestSettings(): HarnessSettings {
  // The cast is the scope's own invariant: only `runWithSettings` (below)
  // writes to it, and it always writes a full HarnessSettings.
  return (tryRuntimeConfig() as HarnessSettings | undefined) ?? DEFAULT_SETTINGS
}

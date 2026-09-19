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
 * Inside a `runWithSettings` scope the store holds the `HarnessSettings` that
 * was passed in; outside one (e.g. during background summarization) it holds
 * nothing and this returns the app's FULL defaults. The spread is the
 * hardening, not style: the library scope is public API (`withRuntimeConfig`),
 * so a scope opened with a bare `HarnessRuntimeConfig` — six knobs, no
 * `sandbox`/`maxConcurrentRuns` — must not leave this reader answering with a
 * partial object that `with-sandbox.server.ts` dereferences unguarded. Scope
 * values win for the six core knobs; the app's own settings keep their
 * defaults.
 */
export function getRequestSettings(): HarnessSettings {
  return { ...DEFAULT_SETTINGS, ...tryRuntimeConfig() }
}

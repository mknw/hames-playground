/**
 * Request-scoped settings context using AsyncLocalStorage.
 *
 * Patterns call getRequestSettings() at execution time to pick up
 * the settings sent with the current request — no need to thread
 * settings through every function signature.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_SETTINGS, type HarnessSettings } from './settings'

const settingsStore = new AsyncLocalStorage<HarnessSettings>()

/**
 * Run an async function with request-scoped settings.
 * Patterns called within `fn` can access settings via getRequestSettings().
 */
export function runWithSettings<T>(
  settings: HarnessSettings | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return settingsStore.run(settings ?? DEFAULT_SETTINGS, fn)
}

/**
 * Get the current request's settings.
 * Returns DEFAULT_SETTINGS if called outside a runWithSettings context
 * (e.g., during background summarization).
 */
export function getRequestSettings(): HarnessSettings {
  return settingsStore.getStore() ?? DEFAULT_SETTINGS
}

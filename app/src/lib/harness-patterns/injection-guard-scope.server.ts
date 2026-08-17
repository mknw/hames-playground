/**
 * Request-scoped injection-guard context — AsyncLocalStorage.
 *
 * Same shape and rationale as `sandbox/scope.server.ts`: a wrapper pattern
 * (`withInjectionGuard`) runs the wrapped pattern inside an ALS scope, and
 * readers deep inside the call graph consult it without any intermediate
 * pattern having to be guard-aware. `chain` / `router` / `routes` /
 * `withReferences` need no changes.
 *
 * Two readers:
 *
 *   1. `mcp-client.callTool` — the PRIMARY chokepoint. Every tool result of
 *      every transport (gateway, app-side, sandbox in-VM) and every pattern
 *      passes through it, including the controller TURN LOG, which loop
 *      patterns build from `result.data` rather than from the event stream.
 *   2. `patterns/retriever.server.ts` — the SECOND path. A retriever calls its
 *      injected backends directly and emits a `tool_result` itself, so it never
 *      reaches `callTool`; it sanitizes its hits at write-time through the same
 *      guard, before `scope.data.matches` or the event exist.
 *
 * Sentinel is `undefined` — the guard is opt-in, so outside a wrapper both
 * readers behave exactly as they did before it existed.
 *
 * This module deliberately imports NOTHING but types. `mcp-client.server.ts`
 * imports it, and namespace resolution needs `tools.server.ts`, which imports
 * `mcp-client.server.ts` — resolving namespaces here would close that cycle.
 * The ready-made guard is therefore built by the pattern wrapper (which can
 * import freely) and only stored here.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
import type { SanitizeReport } from './injection-guard'

assertServerOnImport()

/** The guard as its readers see it — fully built by `withInjectionGuard`. */
export interface ActiveInjectionGuard {
  /** True when this tool's namespace (or explicit tool list) is untrusted. */
  isUntrusted(tool: string): boolean
  /**
   * Sanitize one untrusted payload. Returns the SAME `data` reference when
   * nothing was found, and omits `report` in that case — so a caller can treat
   * "no report" as "byte-identical, nothing to annotate".
   *
   * Emits the `content_sanitized` event as a side effect when it neutralizes,
   * so the observability trail cannot be forgotten by a caller.
   */
  sanitize(tool: string, data: unknown): Promise<{ data: unknown; report?: SanitizeReport }>
}

const guardStore = new AsyncLocalStorage<ActiveInjectionGuard>()

/** Run `fn` with `guard` as the active injection guard. Nesting is allowed and
 *  the innermost wrapper wins — an inner `withInjectionGuard` with a narrower
 *  namespace list fully shadows an outer one for its subtree. */
export function runWithInjectionGuard<T>(
  guard: ActiveInjectionGuard,
  fn: () => Promise<T>,
): Promise<T> {
  return guardStore.run(guard, fn)
}

/** The active guard, or `undefined` outside any `withInjectionGuard` wrapper. */
export function getActiveInjectionGuard(): ActiveInjectionGuard | undefined {
  return guardStore.getStore()
}

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
import type { InjectionGuardOptions, SanitizeSummary, SpotlightMode } from './injection-guard'

assertServerOnImport()

/** The guard as its readers see it — fully built by `withInjectionGuard`. */
export interface ActiveInjectionGuard {
  /** True when this tool's namespace (or explicit tool list) is untrusted. */
  isUntrusted(tool: string): boolean
  /**
   * The sanitizer options this guard resolved — already unioned with any
   * enclosing guard's. Exposed for exactly that reason: a NESTED
   * `createInjectionGuard` reads it so it can take the STRICTEST of the two
   * rather than shadowing the outer boundary's rules, spotlight and screen. See
   * `unionOptions` in `patterns/withInjectionGuard.server.ts`.
   */
  options: InjectionGuardOptions
  /**
   * Sanitize one untrusted payload.
   *
   * `data` comes back by REFERENCE when the content did not change, so
   * `result.data === input` is the caller's "nothing happened" test — and it is
   * the test to use, because `spotlight: 'always'` rewrites (fences) content on
   * which nothing was detected. `summary` is present only when something WAS
   * detected (or when the optional screen was unavailable), so it answers "is
   * there anything to annotate?", NOT "did the content change?".
   *
   * `summary` is deliberately the REDACTED projection, never the full report:
   * it is attached to `tool_result` events, which several consumers JSON-dump
   * wholesale (see `SanitizeSummary`). The verbatim spans go only to the
   * `content_sanitized` event, which this method emits as a side effect — so
   * the observability trail cannot be forgotten by a caller.
   */
  sanitize(
    tool: string,
    data: unknown,
    /** Per-call overrides. `spotlight: 'off'` is for fields where a multi-line
     *  fence would corrupt a structural value the UI depends on — the
     *  retriever's `source` filename is the one real case. */
    overrides?: { spotlight?: SpotlightMode },
  ): Promise<{ data: unknown; summary?: SanitizeSummary }>
}

const guardStore = new AsyncLocalStorage<ActiveInjectionGuard>()

/** Run `fn` with `guard` as the active injection guard. Nesting is allowed and
 *  UNIONS: `createInjectionGuard` reads the enclosing guard at construction and
 *  ORs its `isUntrusted`, so an inner wrapper can only ever widen coverage.
 *  Shadowing would let a narrow inner wrapper silently remove an outer one's
 *  protection for its whole subtree, which is not a thing a security control
 *  should permit by accident. The same union covers the SANITIZER options
 *  (`options` above) — widening the boundary while narrowing the rules applied
 *  to it would have been a hole of exactly the shape this prevents. */
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

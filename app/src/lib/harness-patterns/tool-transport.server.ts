/**
 * Tool transports — the containment seam.
 *
 * A **transport** is anything that owns some tool names and can run them. Core
 * knows the interface and the ORDER; it knows nothing about what any particular
 * transport is. This module has no import from `../sandbox`, `../app-tools` or
 * anything else outside `harness-patterns`, which is the point: the order below
 * is a property of core, not of whoever registers.
 *
 * ## The containment invariant
 *
 * > Any tool name owned by a transport supplied through `withTransport` is
 * > dispatched there, in innermost-first order, before any process-registered
 * > transport and before the gateway. No value a registrant can pass — and no
 * > registration order — can invert that.
 *
 * It is carried by the SHAPE of this module, not by a check inside it: there
 * are two structurally different ways to supply a transport, and the difference
 * between them IS the invariant.
 *
 *   - `withTransport(t, fn)` — SCOPED. An AsyncLocalStorage stack bounded by
 *     one call. Consulted first, innermost first.
 *   - `registerTransport(t)` — PROCESS. A module-level list. Consulted only
 *     after every scoped transport.
 *
 * **There is deliberately no `priority` field, and no argument on either
 * function that could express one.** A rank would make containment a runtime
 * value any registrant could set, and — until someone set it — would make it
 * depend on module import order. A per-call in-VM sandbox and a process-wide
 * per-user tool registry are not two entries in one ranked list; they are two
 * phases. Adding a rank here is a containment change, not a refactor.
 *
 * `transport-precedence.test.ts` pins the order by dispatching a colliding tool
 * name, and pins the absence of a rank by scanning this file.
 *
 * ## Nesting SHADOWS, and that is not the injection guard's rule
 *
 * Two nested `withTransport` scopes resolve a name they BOTH own in favour of
 * the inner one. That is the opposite of `withInjectionGuard`, which unions and
 * never shadows (SD-5) — and the inconsistency is deliberate, so do not "fix"
 * it. A nested guard is a second reviewer of the same content and the strictest
 * reading must win; two nested sandboxes are two different machines that both
 * own `sandbox_bash`, and a union has no answer to "which machine" while an
 * order has a deterministic one.
 *
 * The stack is consulted innermost-FIRST rather than innermost-ONLY, so a name
 * owned only by an outer scope still reaches that outer scope instead of
 * falling through to the gateway. See `withTransport` for the one behaviour
 * this changed relative to the single-slot scope it replaced.
 *
 * ## What this seam does NOT decide
 *
 * It moves *which* transport a name reaches. What a transport is then allowed
 * to do — a sandbox's capabilities, network profile and workspace paths
 * (SD-19 / SD-21) — is unchanged by this module and lives with that transport.
 * And the injection guard still sits ABOVE all of this, in `callTool`: every
 * dispatch path returns through the same chokepoint (SD-6).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
import type { ToolCallResult, MCPToolDescription } from './types'

assertServerOnImport()

/**
 * One tool transport.
 *
 * Deliberately four members and no rank. `ownsTool` is asked of every candidate
 * on every dispatch, so it must be synchronous and side-effect-free.
 */
export interface ToolTransport {
  /** Stable id — diagnostics, and the precedence test's assertion subject. */
  readonly id: string
  /** Does this transport own `name`? Synchronous and side-effect-free. */
  ownsTool(name: string): boolean
  /** Only ever called when `ownsTool(name)` returned true. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>
  /** Advertised surface, in the shared descriptor shape. */
  listTools(): Promise<MCPToolDescription[]>
}

/** Shared empty result, so `activeTransports()` outside any scope allocates
 *  nothing on a path that runs per tool call and per allowlist check. */
const NO_TRANSPORTS: readonly ToolTransport[] = Object.freeze([])

/** Innermost-first stack. The store is REPLACED per scope rather than mutated,
 *  so an inner scope cannot be seen by the outer one after it exits. */
const scopedStore = new AsyncLocalStorage<readonly ToolTransport[]>()

const processRegistry: ToolTransport[] = []

/**
 * SCOPED registration: run `fn` with `transport` as the innermost transport.
 *
 * Consulted before every process-registered transport and before the gateway,
 * for the whole async lifetime of `fn` — an ALS scope rather than a chain step,
 * because dispatch happens deep inside a pattern the caller never sees.
 *
 * Nesting pushes: `[inner, ...outer]`. The predecessor of this seam
 * (`sandbox/scope.server.ts`) held a single slot, so an inner scope hid the
 * outer one ENTIRELY and a name owned only by an outer scope fell through to
 * the gateway. It now reaches that outer transport instead, which is the
 * invariant as written ("innermost-first order") and is strictly more
 * containing. For a name both scopes own — the case that actually occurs, since
 * every sandbox owns `sandbox_bash` — the answer is unchanged: the inner one.
 */
export function withTransport<T>(transport: ToolTransport, fn: () => Promise<T>): Promise<T> {
  const outer = scopedStore.getStore() ?? NO_TRANSPORTS
  return scopedStore.run(Object.freeze([transport, ...outer]), fn)
}

/**
 * The scoped stack, innermost first. Empty outside any `withTransport`.
 *
 * This is the ONE primitive the loop patterns and the prompt builder read —
 * for the allowlist (`some(t => t.ownsTool(name))`), for the tool surface the
 * model is shown, and for "is this run holding tools the gateway never served".
 */
export function activeTransports(): readonly ToolTransport[] {
  return scopedStore.getStore() ?? NO_TRANSPORTS
}

/**
 * PROCESS registration: consulted only after every scoped transport, in
 * registration order. Returns an unregister handle (tests, HMR).
 *
 * One parameter, on purpose. There is nothing to pass that could raise a
 * process transport above a scoped one — that is what makes the invariant
 * unexpressible-to-invert rather than merely documented.
 */
export function registerTransport(transport: ToolTransport): () => void {
  processRegistry.push(transport)
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    const at = processRegistry.indexOf(transport)
    if (at >= 0) processRegistry.splice(at, 1)
  }
}

/**
 * Process-registered transports, in registration order. A copy, so no caller
 * can reorder the registry it was handed.
 *
 * Not on the public barrel: dispatch and the tool catalog are the only readers,
 * and both live in `mcp-client.server.ts`. A pattern that consulted this would
 * be reading process state as if it were run state.
 */
export function processTransports(): readonly ToolTransport[] {
  return [...processRegistry]
}

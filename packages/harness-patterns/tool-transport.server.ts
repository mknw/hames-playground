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
 * > Any tool name owned by a transport in the run frame's `transports` slot is
 * > dispatched there, in innermost-first order, before any process-registered
 * > transport and before the gateway. No value a registrant can pass — and no
 * > registration order — can invert that.
 *
 * It is carried by the SHAPE of this module, not by a check inside it: there
 * are two structurally different ways to supply a transport, and the difference
 * between them IS the invariant.
 *
 *   - the run frame's `transports` slot — SCOPED. Supplied when the frame is
 *     opened, or amended below it by `withSandbox` through
 *     `amendRunFrame({ transports: [t] }, fn)`. Bounded by that scope.
 *     Consulted first, innermost first.
 *   - `registerTransport(t)` — PROCESS. A module-level list. Consulted only
 *     after every scoped transport.
 *
 * **There is deliberately no `priority` field, and no argument on either
 * side that could express one.** A rank would make containment a runtime
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
 * Two nested transport scopes resolve a name they BOTH own in favour of the
 * inner one. That is the opposite of `withInjectionGuard`, which unions and
 * never shadows (SD-5) — and the inconsistency is deliberate, so do not "fix"
 * it. A nested guard is a second reviewer of the same content and the strictest
 * reading must win; two nested sandboxes are two different machines that both
 * own `sandbox_bash`, and a union has no answer to "which machine" while an
 * order has a deterministic one. Since the run frame, BOTH rules are stated in
 * one place — `amendRunFrame` in `run-frame.server.ts` — rather than one in
 * each module's docstring.
 *
 * The stack is consulted innermost-FIRST rather than innermost-ONLY, so a name
 * owned only by an outer scope still reaches that outer scope instead of
 * falling through to the gateway.
 *
 * ## What this seam does NOT decide
 *
 * It moves *which* transport a name reaches. What a transport is then allowed
 * to do — a sandbox's capabilities, network profile and workspace paths
 * (SD-19 / SD-21) — is unchanged by this module and lives with that transport.
 * And the injection guard still sits ABOVE all of this, in `callTool`: every
 * dispatch path returns through the same chokepoint (SD-6).
 */

import { assertServerOnImport } from './assert.server'
import { currentRunFrame } from './run-frame.server'
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
  /**
   * This transport's own namespace for `toolName`, or undefined when it does
   * not know the name. Consulted by `inferServer` BEFORE the registered
   * namespace resolver and the heuristic (#225 L5) — grouping and the
   * injection guard resolve through the same chain. Optional: the gateway has
   * no transport at all, and a transport whose names all resolve through the
   * catalog need not declare one. NOT read by dispatch — this is vocabulary
   * for the tool surface, never a routing input.
   */
  namespaceFor?(toolName: string): string | undefined
}

/** Shared empty result, so `activeTransports()` outside any run allocates
 *  nothing on a path that runs per tool call and per allowlist check. */
const NO_TRANSPORTS: readonly ToolTransport[] = Object.freeze([])

const processRegistry: ToolTransport[] = []

/**
 * The scoped stack, innermost first. Empty outside any run frame, and empty
 * inside one whose `transports` slot nobody filled.
 *
 * This is the ONE primitive the loop patterns and the prompt builder read —
 * for the allowlist (`some(t => t.ownsTool(name))`), for the tool surface the
 * model is shown, and for "is this run holding tools the gateway never served".
 *
 * It reads the RUN FRAME, never a store of its own. The scoped registration it
 * used to own (`withTransport`) is gone: a transport is supplied when the frame
 * is opened, or amended below it by `withSandbox` via
 * `amendRunFrame({ transports: [t] }, fn)`, whose prepend is what makes the
 * stack innermost-first. The soft read is deliberate — a prompt builder asking
 * for the tool surface outside a run is a legitimate question with the same
 * answer it always had, and the refusal that stops a RUN happening without a
 * frame belongs at the run boundary (`runChain`), not here.
 */
export function activeTransports(): readonly ToolTransport[] {
  return currentRunFrame()?.transports ?? NO_TRANSPORTS
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

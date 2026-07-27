/**
 * Request-scoped sandbox context — AsyncLocalStorage.
 *
 * `withSandbox` acquires a sandbox (boot + connectMcp) and runs the wrapped
 * pattern inside an ALS scope carrying the resulting `McpTransport`. Three
 * downstream readers consult it (see docs/plan/sandbox.md → "How tools reach
 * the controller"):
 *
 *   1. `mcp-client.callTool` — routes sandbox-owned tool names to the in-VM
 *      transport instead of the host gateway.
 *   2. `simpleLoop` / `actorCritic` — extend their allowlist guard with
 *      `sandbox.ownsTool(...)` so sandbox tools pass `tools.includes(...)`
 *      without being threaded through the pattern's `tools` / `availableTools`.
 *   3. BAML adapters in `baml-adapters.server.ts` — append the active
 *      sandbox's `listTools()` descriptions to the prompt's tool list so the
 *      actor sees them in its first-turn prompt.
 *
 * Model: same shape as `settings-context.server.ts`. Sentinel is `undefined`
 * (sandbox is opt-in — outside a wrapper, readers behave exactly as today).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { McpTransport } from './types'

assertServerOnImport()

const sandboxStore = new AsyncLocalStorage<McpTransport>()

/** Run `fn` with `transport` as the active sandbox scope. Used by
 *  `withSandbox` to inject the sandbox for the wrapped pattern's lifetime. */
export function runWithSandbox<T>(
  transport: McpTransport,
  fn: () => Promise<T>,
): Promise<T> {
  return sandboxStore.run(transport, fn)
}

/** Return the active sandbox's MCP transport, or `undefined` when no sandbox
 *  is attached. Readers treat `undefined` as "route to gateway as today". */
export function getActiveSandbox(): McpTransport | undefined {
  return sandboxStore.getStore()
}

/**
 * Test helper: arms THIS deployment's namespace catalog through the REAL seam.
 *
 * The catalog moved out of core in Lane B2 (#225 L5) — `inferServer` now
 * consults registered resolvers, and the app registers `mcpNamespace` at boot
 * (`app-tools/index.server.ts`, reached from `src/middleware.ts`). Unit tests
 * that exercise the guard's namespace matching against gateway tool names
 * (`search` → `web`) therefore need the same registration the boot hook
 * performs, or every declared namespace is unmatchable by construction.
 *
 * This module performs exactly that registration — `registerToolNamespaces(
 * mcpNamespace)`, the real resolver, the real seam, no stub of `inferServer`
 * (a stub is what the design note forbids: "a version that stubs inferServer
 * is not [a valid test]"). Import it for its side effect; registration is
 * idempotent per module instance.
 */

import { registerToolNamespaces } from '../../../../packages/harness-patterns/tools.server'
import { mcpNamespace } from '../../lib/app-tools/mcp-catalog'

let registered = false

export function registerAppNamespaceCatalog(): void {
  if (registered) return
  registerToolNamespaces(mcpNamespace)
  registered = true
}

registerAppNamespaceCatalog()

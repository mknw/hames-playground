/**
 * Stash transport seam — Server Only
 *
 * The Data Stash pipeline (`stash/document-store` / `stash/document-ingest` /
 * `stash/vector-store`) reaches Redis exclusively through an injectable
 * `CallTool`. Every public function takes one as an optional parameter; this
 * module supplies the DEFAULT.
 *
 * The library-owned default is the MCP gateway's `callTool` — core owns the
 * gateway client, and "requires Redis" is a runtime fact about a deployment,
 * never a dependency this package drags in or a socket opened at import.
 *
 * A HOST that has a faster transport (the app's direct-ioredis adapter,
 * flag-gated at `STASH_DIRECT_REDIS` because the gateway's serial stdio pipe
 * makes a large ingest O(chunks)×2 serial round-trips) registers its resolver
 * here at boot — the same explicit-config seam shape the connectors package
 * uses for its Neo4j client. Nothing in this module reads the host's env: the
 * flag semantics belong to whoever owns the transport.
 *
 * The `isBuiltin` half of the registration backs the list-cache decision in
 * `stash/document-store.server.ts`: only REAL backends may share the cache —
 * tests inject fakes and must not see one another's cached lists. The gateway
 * is always builtin; the host registers any transport of its own that qualifies.
 */

import type { CallTool } from './stash/document-store.server'
import { callTool as gatewayCallTool } from './mcp-client.server'

type StashTransportResolver = () => CallTool
type StashTransportPredicate = (callTool: CallTool) => boolean

let resolver: StashTransportResolver | undefined
const builtinPredicates: StashTransportPredicate[] = []

/**
 * Register the host's stash transport. Replaces any previous registration
 * (idempotent for HMR / repeated boot). `isBuiltin` marks transports the list
 * cache may treat as real; omit it to mark nothing beyond the gateway.
 */
export function registerStashTransport(
  resolve: StashTransportResolver,
  isBuiltin?: StashTransportPredicate,
): void {
  resolver = resolve
  builtinPredicates.length = 0
  if (isBuiltin) builtinPredicates.push(isBuiltin)
}

/** Drop the registration (tests / HMR). The default reverts to the gateway. */
export function resetStashTransport(): void {
  resolver = undefined
  builtinPredicates.length = 0
}

/** The `CallTool` the stash pipeline defaults to: the host's, else the gateway. */
export function resolveStashCallTool(): CallTool {
  return resolver ? resolver() : gatewayCallTool
}

/** True when `callTool` is a real backend (gateway or a host-registered one),
 *  not an injected test fake — the list-cache gate. */
export function isBuiltinStashTransport(callTool: CallTool): boolean {
  return callTool === gatewayCallTool || builtinPredicates.some((p) => p(callTool))
}

export { gatewayCallTool }

/**
 * Neo4j Query Server Functions (Non-Agentic Layer) — the RETAINED RPC surface.
 *
 * Every export here is a `'use server'` RPC — browser-reachable — so every
 * one of them takes an authenticated (allow-listed) user or the gated dev
 * bypass first (#230), and then delegates to the identity-free op in
 * `@hames-ai/connectors` (#225 PR-C2: the op bodies moved into the package;
 * this module is the thin gated wrapper that keeps the import path its
 * clients already use). The ops open every session in READ access mode —
 * the driver enforces read-only, not this module (SD-14: the wrappers open
 * NO sessions at all, pinned by the source-scan in this file's tests).
 *
 * The auth gate is DUPLICATED per module rather than imported (SD-13: a
 * shared helper would itself be an RPC), mirrors
 * `graph-edit.server.ts:requireAuthenticated` / `actions.server.ts:58`, and
 * returns its refusal BEFORE any resource is opened.
 */

'use server'

import type {
  SchemaResult,
  CypherResult,
  ConnectionResult,
  NodePropertiesResult,
} from '@hames-ai/connectors/neo4j/queries'
import {
  getSchema as getSchemaOp,
  getSchemaForAgent as getSchemaForAgentOp,
  getSimplifiedSchema as getSimplifiedSchemaOp,
  getNodeProperties as getNodePropertiesOp,
  runManualCypher as runManualCypherOp,
  resetNeo4jConnection as resetNeo4jConnectionOp,
  testNeo4jConnection as testNeo4jConnectionOp,
} from '@hames-ai/connectors/neo4j/queries'
import { getAuthenticatedUser } from '../auth/server'
import { isBypassEnabled } from '../auth/dev-bypass'

export type { SchemaResult, CypherResult, ConnectionResult, NodePropertiesResult }

// ============================================================================
// Guards
// ============================================================================

/**
 * Envelope-shaped auth gate for this module's RPCs (#230).
 *
 * Returns `null` when the caller is an authenticated, allow-listed user (or
 * the DEV-gated bypass is on), otherwise the `{ success: false }` envelope
 * every function here resolves to instead of throwing — the manual-query box
 * shows `error` verbatim. Callers must return it *before* delegating to the
 * package op, so an unauthenticated call never reaches the driver.
 *
 * Mirrors `graph-edit.server.ts:25` / `actions.server.ts:58`; those cannot be
 * imported here, since a `'use server'` file's exports are all RPCs.
 */
async function denyUnauthenticated(): Promise<{ success: false; error: string } | null> {
  if (isBypassEnabled()) return null
  try {
    await getAuthenticatedUser()
    return null
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ============================================================================
// Schema Operations
// ============================================================================

/**
 * Fetch the Neo4j database schema
 * Used by agent for context about available node types and relationships
 */
export async function getSchema(): Promise<SchemaResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return getSchemaOp()
}

/**
 * Get a formatted schema for the BAML agent
 * Produces concise, LLM-friendly output with:
 * - Node labels with their properties
 * - Relationship patterns (start)-[TYPE]->(end)
 */
export async function getSchemaForAgent(): Promise<SchemaResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return getSchemaForAgentOp()
}

/**
 * Get a simplified schema representation
 * Useful for smaller context windows
 */
export async function getSimplifiedSchema(): Promise<SchemaResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return getSimplifiedSchemaOp()
}

// ============================================================================
// Node Property Operations
// ============================================================================

/**
 * Fetch properties for a specific node by element ID
 * Used when clicking on a graph node that doesn't have properties loaded
 *
 * @param elementId - Neo4j 5.x element ID (e.g., "4:xxx:123")
 */
export async function getNodeProperties(elementId: string): Promise<NodePropertiesResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return getNodePropertiesOp(elementId)
}

// ============================================================================
// Manual Cypher Operations
// ============================================================================

/**
 * Execute a read-only Cypher query (for GraphVisualization manual input)
 *
 * The caller supplies the query text, so read-only is enforced by the driver
 * inside the package op (`executeRead` over a READ-mode session, #230), not by
 * inspecting the text.
 *
 * @param cypher - The Cypher query to execute
 */
export async function runManualCypher(cypher: string): Promise<CypherResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return runManualCypherOp(cypher)
}

// There is deliberately no write counterpart to `runManualCypher` (#228).
// `executeWriteCypher(cypher)` used to live here: a `'use server'` RPC — so
// browser-reachable — that ran any string the caller sent, with no auth and
// no approval flow behind it despite what its comment claimed. It had no
// callers. Graph writes go through the intent-shaped, authenticated ops in
// `graph-edit.server.ts` (#226 C2), which own their Cypher; nothing new
// belongs here that takes query text from the client.
//
// `runManualCypher` stays because a manual-query box in GraphVisualization
// genuinely uses it, and it is safe on a different footing (#230): the caller
// must be authenticated (the gate above), and the driver — not a blacklist —
// is what makes the query read-only. Any new export in this file must gate
// with `denyUnauthenticated()` before delegating; that is what the
// source-scan pin in queries.test.ts holds — and this wrapper opens no
// sessions at all (the ops own them, package-side).

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Reset the Neo4j connection
 * Forces the driver singleton to reconnect on the next query
 */
export async function resetNeo4jConnection(): Promise<ConnectionResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return resetNeo4jConnectionOp()
}

/**
 * Test the Neo4j connection
 */
export async function testNeo4jConnection(): Promise<ConnectionResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  return testNeo4jConnectionOp()
}

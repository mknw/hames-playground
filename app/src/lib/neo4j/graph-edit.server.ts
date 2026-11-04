/**
 * Neo4j Graph Edit Actions (#226 C2) — the RETAINED RPC surface.
 *
 * Intent-shaped `'use server'` operations for the graph visualization UI's
 * edit affordances (create node, link nodes, edit a property). Replaces the
 * deleted `write-action.ts`, whose `executeCypherWrite(cypher, params)` was a
 * browser-reachable arbitrary-Cypher endpoint with no auth.
 *
 * Since #225 PR-C2 this module is the thin gated wrapper: every export runs
 * the per-module auth gate (duplicated, never imported — SD-13) and then
 * delegates to the identity-free op in `@hames-ai/connectors`. The op owns its
 * Cypher — the client sends intent, never query text — passes all values as
 * Cypher parameters, and validates identifiers against a strict charset
 * allowlist before interpolating them backtick-quoted.
 *
 * Since org-knowledge slice 6 every op is checked against the organisation's
 * ontology (`ORG_ONTOLOGY`) and stamps provenance. The gate stays GATE-ONLY
 * (#225 PR-C1 is preserved): it returns nothing, and the actor the ops record is
 * read AFTER it from `canvasActor()`, a separate server-only helper, as
 * provenance and never as an authorization input.
 */

'use server'

import {
  createGraphNode as createGraphNodeOp,
  linkGraphNodes as linkGraphNodesOp,
  setGraphNodeProperty as setGraphNodePropertyOp,
} from '@hames-ai/connectors/neo4j/graph-edit.server'
import { getAuthenticatedUser } from '../auth/server'
import { isBypassEnabled } from '../auth/dev-bypass'
import { ORG_ONTOLOGY } from '../org-graph/ontology'
import { canvasActor } from '../org-graph/canvas-actor.server'

// Auth gate (mirrors actions.server.ts:58). GATE-ONLY by construction (#225
// PR-C1): it returns `Promise<void>`, so it cannot hand out an identity — the
// id it used to return was discarded by every caller, and a gate that returns
// the identity it checked invites a future caller to use it as authorization.
// The shape is pinned by `auth-gate-shape.test.ts`.
async function requireAuthenticated(): Promise<void> {
  if (isBypassEnabled()) return
  await getAuthenticatedUser()
}

/** Create a node of an ontology label with the given name and optional
 *  description, or merge onto the node of that name.
 *  Resolves with the created node's Neo4j elementId: the canvas keys a fresh
 *  node by its user-typed name (#323 B1), so later edits and relations in the
 *  same session need the real id to target it with. */
export async function createGraphNode(
  label: string,
  name: string,
  description?: string,
): Promise<string> {
  await requireAuthenticated()
  return createGraphNodeOp(ORG_ONTOLOGY, await canvasActor(), label, name, description)
}

/** Create a relationship of the given type between two nodes, matched by
 * elementId. MERGE keeps a second click on the same pair idempotent instead of
 * stacking duplicate edges. */
export async function linkGraphNodes(
  sourceId: string,
  targetId: string,
  relType: string,
): Promise<void> {
  await requireAuthenticated()
  return linkGraphNodesOp(ORG_ONTOLOGY, await canvasActor(), sourceId, targetId, relType)
}

/** Set one property on the node with the given elementId. */
export async function setGraphNodeProperty(
  nodeId: string,
  key: string,
  value: string,
): Promise<void> {
  await requireAuthenticated()
  return setGraphNodePropertyOp(ORG_ONTOLOGY, await canvasActor(), nodeId, key, value)
}

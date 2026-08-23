/**
 * Neo4j Graph Edit Actions (#226 C2)
 *
 * Intent-shaped `'use server'` operations for the graph visualization UI's
 * edit affordances (create node, link nodes, edit a property). Replaces the
 * deleted `write-action.ts`, whose `executeCypherWrite(cypher, params)` was a
 * browser-reachable arbitrary-Cypher endpoint with no auth.
 *
 * Every operation:
 *  - requires an authenticated (allow-listed) user, or the gated dev bypass;
 *  - owns its Cypher — the client sends intent, never query text;
 *  - passes all values as Cypher parameters;
 *  - validates identifiers (label / relationship type / property key), which
 *    cannot be parameters, against a strict charset allowlist before
 *    interpolating them backtick-quoted.
 */

'use server'

import { getNeo4jDriver } from './client'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'

// Auth helper (mirrors actions.server.ts:58)
async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id
  const u = await getAuthenticatedUser()
  return u.id
}

// Labels, relationship types and property keys cannot be Cypher parameters,
// so they are interpolated — restricted to a charset that cannot terminate
// the backtick quoting or smuggle query syntax. The UI legitimately mints NEW
// labels/relationship types (free-text inputs, defaults `Concept` /
// `RELATES_TO`), so validation is by shape, not by membership in
// db.labels()/db.relationshipTypes() — a catalog check would reject the first
// node of every new label.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeIdentifier(kind: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${kind} ${JSON.stringify(value)}: must match ${SAFE_IDENTIFIER}`)
  }
  return value
}

async function run(cypher: string, params: Record<string, unknown>): Promise<void> {
  const session = getNeo4jDriver().session()
  try {
    await session.run(cypher, params)
  } finally {
    await session.close()
  }
}

/** Create a node with the given label, name and optional description. */
export async function createGraphNode(
  label: string,
  name: string,
  description?: string,
): Promise<void> {
  await requireUserId()
  const safeLabel = assertSafeIdentifier('label', label)
  if (description) {
    await run(`CREATE (n:\`${safeLabel}\` {name: $name, description: $description})`, {
      name,
      description,
    })
  } else {
    await run(`CREATE (n:\`${safeLabel}\` {name: $name})`, { name })
  }
}

/** Create a relationship of the given type between two nodes, matched by name. */
export async function linkGraphNodes(
  sourceName: string,
  targetName: string,
  relType: string,
): Promise<void> {
  await requireUserId()
  const safeType = assertSafeIdentifier('relationship type', relType)
  await run(
    `MATCH (a {name: $sourceName}), (b {name: $targetName}) CREATE (a)-[:\`${safeType}\`]->(b)`,
    { sourceName, targetName },
  )
}

/** Set one property on a node matched by name. */
export async function setGraphNodeProperty(
  nodeName: string,
  key: string,
  value: string,
): Promise<void> {
  await requireUserId()
  const safeKey = assertSafeIdentifier('property key', key)
  await run(`MATCH (n {name: $name}) SET n.\`${safeKey}\` = $value`, {
    name: nodeName,
    value,
  })
}

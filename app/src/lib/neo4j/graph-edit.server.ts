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

async function run(cypher: string, params: Record<string, unknown>) {
  const session = getNeo4jDriver().session()
  try {
    return await session.run(cypher, params)
  } finally {
    await session.close()
  }
}

/** The write's final `RETURN count(*)` — how many nodes the MATCH bound. A
 *  zero-match MATCH turns the write into a no-op that resolves exactly like a
 *  success (#314), so every op that MATCHes first reads this and rejects. */
function matchedCount(
  result: { records: { get: (key: string) => unknown }[] },
  key: string,
): number {
  const record = result.records[0]
  if (!record) throw new Error('Graph edit query returned no summary record')
  return Number(record.get(key))
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

/** Create a relationship of the given type between two nodes, matched by
 *  elementId. MERGE keeps a second click on the same pair idempotent instead of
 *  stacking duplicate edges. */
export async function linkGraphNodes(
  sourceId: string,
  targetId: string,
  relType: string,
): Promise<void> {
  await requireUserId()
  const safeType = assertSafeIdentifier('relationship type', relType)
  const result = await run(
    `MATCH (a), (b) WHERE elementId(a) = $sourceId AND elementId(b) = $targetId MERGE (a)-[:\`${safeType}\`]->(b) RETURN count(*) AS linked`,
    { sourceId, targetId },
  )
  if (matchedCount(result, 'linked') === 0) {
    throw new Error('Graph edit matched no graph node for that relation — nothing was created')
  }
}

/** Set one property on the node with the given elementId. */
export async function setGraphNodeProperty(
  nodeId: string,
  key: string,
  value: string,
): Promise<void> {
  await requireUserId()
  const safeKey = assertSafeIdentifier('property key', key)
  const result = await run(
    `MATCH (n) WHERE elementId(n) = $nodeId SET n.\`${safeKey}\` = $value RETURN count(n) AS matched`,
    { nodeId, value },
  )
  if (matchedCount(result, 'matched') === 0) {
    throw new Error('Graph edit matched no graph node with that id — nothing was written')
  }
}

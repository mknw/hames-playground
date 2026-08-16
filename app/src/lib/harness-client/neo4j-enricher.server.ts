/**
 * Neo4j Tool Result Enricher
 *
 * Wired into a `simpleLoop` config as `onToolResult`. After a Neo4j read/write,
 * collects the names of nodes returned by the agent's query, fetches their 1-hop
 * neighborhood directly from Neo4j (bypassing the LLM), and attaches that
 * context to the tool result so the graph panel can render the touched nodes
 * inside their actual neighborhood.
 *
 * Output shape consumed by `graph-extractor.ts`:
 *   { rows: <original>, _neighborhood: { rows: [...] }, _touched: ["Name", ...] }
 *
 * Failures are non-fatal — simpleLoop catches and logs an error event; the
 * original (un-enriched) tool result is preserved.
 */

"use server";

import { getNeo4jDriver } from '../neo4j/client'
import type { OnToolResult } from '../harness-patterns/types'

const ENRICHABLE_TOOLS = new Set([
  'read_neo4j_cypher',
  'write_neo4j_cypher',
])

/** Cap to avoid blowing up the IN-clause and neighborhood result. */
const MAX_TOUCHED_NAMES = 50
const NEIGHBORHOOD_LIMIT = 100

const NEIGHBORHOOD_QUERY =
  'MATCH (n) WHERE n.name IN $names ' +
  'OPTIONAL MATCH (n)-[r]-(m) ' +
  `RETURN n, r, m LIMIT ${NEIGHBORHOOD_LIMIT}`

export const enrichNeo4jResult: OnToolResult = async (toolName, result, _ctx) => {
  if (!result.success || !ENRICHABLE_TOOLS.has(toolName)) return
  if (result.data === null || result.data === undefined) return

  const names = collectNames(result.data)
  if (names.length === 0) return

  const driver = getNeo4jDriver()
  const session = driver.session()
  try {
    const res = await session.run(NEIGHBORHOOD_QUERY, { names })
    const rows = res.records.map((rec) => {
      const nObj = rec.get('n')
      const mObj = rec.get('m')
      const r = rec.get('r')
      const n = serializeNode(nObj)
      const m = serializeNode(mObj)
      let relTuple: [Record<string, unknown>, string, Record<string, unknown>] | null = null
      if (isDriverRelationship(r) && n && m && mObj) {
        // Always emit the tuple in the relationship's actual direction (rel.start → rel.end),
        // not the query binding order. The MCP cypher server already does this for the
        // original `read_neo4j_cypher` path, so matching it here keeps edge IDs stable
        // across queries that touch the same rel from either endpoint (avoids dup edges).
        const isNStart = identityEquals(getIdentity(nObj), r.start)
        relTuple = isNStart ? [n, r.type, m] : [m, r.type, n]
      }
      return { n, r: relTuple, m }
    })
    return {
      data: {
        rows: result.data,
        _neighborhood: { rows },
        _touched: names,
      },
    }
  } finally {
    await session.close()
  }
}

function getIdentity(nodeObj: unknown): unknown {
  if (!nodeObj || typeof nodeObj !== 'object') return undefined
  return (nodeObj as { identity?: unknown }).identity
}

function identityEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false
  // neo4j-driver Integer wraps int64 with .equals(). Fall back to string compare
  // if either side isn't an Integer (defensive — shouldn't happen in practice).
  const aHasEquals = a !== null && typeof a === 'object' && typeof (a as { equals?: unknown }).equals === 'function'
  if (aHasEquals) {
    return (a as { equals: (other: unknown) => boolean }).equals(b)
  }
  return String(a) === String(b)
}

/** Walk the tool result and collect every string `name` property we encounter
 *  (including names inside 3-tuple relationship arrays). De-duplicated, capped. */
function collectNames(value: unknown): string[] {
  const out = new Set<string>()
  walk(value, out)
  return Array.from(out).slice(0, MAX_TOUCHED_NAMES)
}

function walk(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out)
    return
  }
  if (typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    out.add(obj.name)
  }
  for (const key of Object.keys(obj)) {
    if (key === 'name') continue
    walk(obj[key], out)
  }
}

interface DriverRelationship {
  type: string
  start: unknown
  end: unknown
  properties?: Record<string, unknown>
}

function isDriverRelationship(value: unknown): value is DriverRelationship {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.type === 'string' && 'properties' in v && 'start' in v && 'end' in v
}

/** Serialize a neo4j-driver Node to its property bag — matches what the MCP
 *  cypher server returns for nodes, so the extractor handles them identically.
 *  Returns null for null/missing input (OPTIONAL MATCH miss). */
function serializeNode(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if ('properties' in v && 'labels' in v && Array.isArray(v.labels)) {
    return (v.properties as Record<string, unknown>) ?? {}
  }
  return null
}

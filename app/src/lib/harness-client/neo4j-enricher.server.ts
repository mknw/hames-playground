/**
 * Neo4j Tool Result Enricher
 *
 * Wired into a `simpleLoop` config as `onToolResult`. After a Neo4j read/write,
 * collects the names of nodes returned by the agent's query, fetches their 1-hop
 * neighborhood, and attaches that context to the tool result so the graph panel
 * can render the touched nodes inside their actual neighborhood.
 *
 * Output shape consumed by `graph-extractor.ts`:
 *   { rows: <original>, _neighborhood: { rows: [...] }, _touched: ["Name", ...] }
 *
 * The neighborhood is read with the same `read_neo4j_cypher` tool, through the
 * shared tool-call function, never a driver session of its own. That function is
 * where the run's injection guard applies (SD-6), so on a route that declares the
 * `neo4j` namespace the neighborhood arrives fenced exactly like the agent's own
 * read, and the egress gate's local-result observer sees it too. The MCP server
 * already returns each relationship as `[start, TYPE, end]` in its actual
 * direction, which is the shape the extractor reads.
 *
 * The names it queries are read through the fence (`unspotlight`): a guarded
 * route fences every string in a result, and a fenced name matches no node.
 * `_touched` keeps the names as the result carried them, so this hook adds no
 * unfenced graph text to the result; the extractor unfences both sides.
 *
 * Failures are non-fatal: simpleLoop catches and logs an error event; the
 * original (un-enriched) tool result is preserved.
 */

'use server'

import { callTool } from '@hames-ai/harness-patterns/mcp-client.server'
import { unspotlight } from '@hames-ai/harness-patterns/guard'
import type { OnToolResult } from '@hames-ai/harness-patterns/types'

const ENRICHABLE_TOOLS = new Set(['read_neo4j_cypher', 'write_neo4j_cypher'])

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

  const touched = collectNames(result.data)
  if (touched.length === 0) return

  const names = [...new Set(touched.map(unspotlight))]
  const neighborhood = await callTool('read_neo4j_cypher', {
    query: NEIGHBORHOOD_QUERY,
    params: { names },
  })
  if (!neighborhood.success) {
    throw new Error(`neighborhood read failed: ${neighborhood.error ?? 'no error given'}`)
  }
  return {
    data: {
      rows: result.data,
      _neighborhood: { rows: neighborhood.data },
      _touched: touched,
    },
  }
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

/**
 * Neo4j Query Server Functions (Non-Agentic Layer)
 *
 * Server-side functions for direct Neo4j operations:
 * - Schema fetching for agent initialization
 * - Manual Cypher queries from GraphVisualization
 * - Connection management
 *
 * These operations bypass the agent layer for performance and simplicity.
 *
 * Every export here is a `'use server'` RPC — browser-reachable — so every
 * one of them takes an authenticated (allow-listed) user or the gated dev
 * bypass first (#230), and every session is opened in READ access mode: this
 * module never writes, and the driver enforces that rather than the query
 * text being inspected for it. See `graph-edit.server.ts` (#226 C2) for the
 * authenticated, intent-shaped ops that own the graph writes.
 */

'use server'

import neo4j from 'neo4j-driver'
import { getNeo4jDriver, resetDriver, verifyConnection } from './client'
import { transformNeo4jToCytoscape, parseNeo4jResults } from '../graph/transform'
import { toPlainNeo4jValue } from './plain'
import { getAuthenticatedUser } from '../auth/server'
import { isBypassEnabled } from '../auth/dev-bypass'

// ============================================================================
// Types
// ============================================================================

export interface SchemaResult {
  success: boolean
  schema?: string
  error?: string
}

export interface CypherResult {
  success: boolean
  graphUpdate?: ReturnType<typeof transformNeo4jToCytoscape>
  raw?: unknown[]
  error?: string
}

export interface ConnectionResult {
  success: boolean
  error?: string
}

// ============================================================================
// Guards
// ============================================================================

/**
 * Envelope-shaped auth gate for this module's RPCs (#230).
 *
 * Returns `null` when the caller is an authenticated, allow-listed user (or
 * the DEV-gated bypass is on), otherwise the `{ success: false }` envelope
 * every function here resolves to instead of throwing — the manual-query box
 * shows `error` verbatim. Callers must return it *before* opening a session,
 * so an unauthenticated call never reaches the driver.
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

/**
 * A session the driver refuses to write through.
 *
 * Nothing in this module writes, so READ access mode costs nothing and makes
 * the guarantee structural: the server rejects a write statement sent over a
 * READ-mode transaction whatever the text says, which is the barrier a
 * keyword blacklist can never be (comments, unicode escapes, `CALL { … }`
 * subqueries, apoc procedures).
 */
function readSession() {
  return getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
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

  const session = readSession()
  try {
    const result = await session.run('CALL db.schema.visualization()')
    return {
      success: true,
      schema: JSON.stringify(result.records, null, 2),
    }
  } catch (error) {
    console.error('Failed to fetch schema:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await session.close()
  }
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

  const session = readSession()
  try {
    // Get labels with their actual properties (sample 1 node per label)
    const labelsQuery = `
      CALL db.labels() YIELD label
      CALL {
        WITH label
        MATCH (n) WHERE label IN labels(n)
        RETURN keys(n) as props LIMIT 1
      }
      RETURN label, props
    `
    const labelsResult = await session.run(labelsQuery)

    // Get relationship patterns by querying actual data
    // (db.schema.visualization returns virtual nodes that don't support startNode/endNode)
    const relsQuery = `
      MATCH (a)-[r]->(b)
      WITH
        [lbl IN labels(a) WHERE lbl <> 'UNIQUE IMPORT LABEL'][0] as startLabel,
        type(r) as relType,
        [lbl IN labels(b) WHERE lbl <> 'UNIQUE IMPORT LABEL'][0] as endLabel
      WHERE startLabel IS NOT NULL AND endLabel IS NOT NULL
      RETURN DISTINCT startLabel, relType, endLabel
    `
    const relsResult = await session.run(relsQuery)

    // Format as readable text
    let schema = 'Node Labels:\n'
    for (const record of labelsResult.records) {
      const label = record.get('label')
      if (label === 'UNIQUE IMPORT LABEL') continue // Skip APOC import label
      const props = record.get('props') || []
      schema += `- ${label} (properties: ${props.join(', ')})\n`
    }

    schema += '\nRelationships:\n'
    for (const record of relsResult.records) {
      const start = record.get('startLabel')
      const rel = record.get('relType')
      const end = record.get('endLabel')
      if (start && rel && end) {
        schema += `- (${start})-[${rel}]->(${end})\n`
      }
    }

    return { success: true, schema }
  } catch (error) {
    console.error('Failed to fetch agent schema:', error)
    // Fallback to simplified schema
    return getSimplifiedSchema()
  } finally {
    await session.close()
  }
}

/**
 * Get a simplified schema representation
 * Useful for smaller context windows
 */
export async function getSimplifiedSchema(): Promise<SchemaResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  const session = readSession()
  try {
    // Get node labels
    const labelsResult = await session.run('CALL db.labels()')
    const labels = labelsResult.records.map((r) => r.get(0))

    // Get relationship types
    const relTypesResult = await session.run('CALL db.relationshipTypes()')
    const relTypes = relTypesResult.records.map((r) => r.get(0))

    // Get property keys
    const propsResult = await session.run('CALL db.propertyKeys()')
    const propKeys = propsResult.records.map((r) => r.get(0))

    const schema = {
      nodeLabels: labels,
      relationshipTypes: relTypes,
      propertyKeys: propKeys,
    }

    return {
      success: true,
      schema: JSON.stringify(schema, null, 2),
    }
  } catch (error) {
    console.error('Failed to fetch simplified schema:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await session.close()
  }
}

// ============================================================================
// Node Property Operations
// ============================================================================

export interface NodePropertiesResult {
  success: boolean
  properties?: Record<string, unknown>
  labels?: string[]
  error?: string
}

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

  const session = readSession()
  try {
    const result = await session.run(
      'MATCH (n) WHERE elementId(n) = $elementId RETURN properties(n) as props, labels(n) as labels',
      { elementId },
    )

    if (result.records.length === 0) {
      return { success: false, error: 'Node not found' }
    }

    const record = result.records[0]
    return {
      success: true,
      // Plain projection, not the driver's own values: an int property is an
      // `Integer` instance, which the RPC serializer cannot encode (see
      // `plain.ts`).
      properties: toPlainNeo4jValue(record.get('props')) as Record<string, unknown>,
      labels: record.get('labels') as string[],
    }
  } catch (error) {
    console.error('Failed to fetch node properties:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await session.close()
  }
}

// ============================================================================
// Manual Cypher Operations
// ============================================================================

// Defense in depth only (#230). The barrier is the READ-mode transaction
// below; this pre-check exists to answer an obvious write faster, and with a
// message that points at the chat interface. Word boundaries, not substrings
// (#190): `RETURN n.createdAt` and `MATCH (n:Dataset)` are reads.
const WRITE_CLAUSE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DETACH)\b/i

// How Neo4j phrases its own refusal of a write over a READ transaction.
const DRIVER_READ_ONLY_REFUSAL = /read[- ]?only|read access mode|ForbiddenDueToTransactionType/i

/**
 * Execute a read-only Cypher query (for GraphVisualization manual input)
 *
 * The caller supplies the query text, so read-only is enforced by the driver
 * (`executeRead` over a READ-mode session, #230), not by inspecting the text.
 *
 * @param cypher - The Cypher query to execute
 */
export async function runManualCypher(cypher: string): Promise<CypherResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  const writeClause = WRITE_CLAUSE.exec(cypher)
  if (writeClause) {
    return {
      success: false,
      error: `Manual queries cannot use write operations (${writeClause[1].toUpperCase()}). Use the chat interface for modifications.`,
    }
  }

  const session = readSession()
  try {
    // READ mode is pinned on the transaction as well as the session, so a
    // write that slipped past WRITE_CLAUSE is refused by the server.
    const result = await session.executeRead((tx) => tx.run(cypher))

    // Plain-project the rows *before* anything else touches them: both what
    // goes back over the RPC and what the Cytoscape projection embeds
    // (`data.properties`, `data.neo4jId`) would otherwise carry driver class
    // instances, which the serializer refuses mid-stream (see `plain.ts`).
    const rows = result.records.map(
      (r) => toPlainNeo4jValue(r.toObject()) as Record<string, unknown>,
    )

    // Parse and transform results for Cytoscape
    const parsed = parseNeo4jResults({ records: rows })
    const graphData = transformNeo4jToCytoscape(parsed.nodes || [], parsed.relationships || [])

    return {
      success: true,
      graphUpdate: graphData,
      raw: rows,
    }
  } catch (error) {
    console.error('Manual Cypher query failed:', error)
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: DRIVER_READ_ONLY_REFUSAL.test(message)
        ? `Manual queries are read-only and the database refused this one. Use the chat interface for modifications. (${message})`
        : message,
    }
  } finally {
    await session.close()
  }
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
// must be authenticated, and the driver — not a blacklist — is what makes the
// query read-only. Any new export in this file must open its session through
// `readSession()`; that is what the source-scan pin in queries.test.ts holds.

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

  try {
    await resetDriver()
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Test the Neo4j connection
 */
export async function testNeo4jConnection(): Promise<ConnectionResult> {
  'use server'

  const denied = await denyUnauthenticated()
  if (denied) return denied

  try {
    const connected = await verifyConnection()
    return {
      success: connected,
      error: connected ? undefined : 'Connection verification failed',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

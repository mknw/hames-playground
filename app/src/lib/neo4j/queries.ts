/**
 * Neo4j Query Server Functions (Non-Agentic Layer)
 *
 * Server-side functions for direct Neo4j operations:
 * - Schema fetching for agent initialization
 * - Manual Cypher queries from GraphVisualization
 * - Connection management
 *
 * These operations bypass the agent layer for performance and simplicity.
 */

'use server'

import { getNeo4jDriver, resetDriver, verifyConnection } from './client'
import { transformNeo4jToCytoscape, parseNeo4jResults } from '../graph/transform'

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
// Schema Operations
// ============================================================================

/**
 * Fetch the Neo4j database schema
 * Used by agent for context about available node types and relationships
 */
export async function getSchema(): Promise<SchemaResult> {
  'use server'

  const session = getNeo4jDriver().session()
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

  const session = getNeo4jDriver().session()
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

  const session = getNeo4jDriver().session()
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

  const session = getNeo4jDriver().session()
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
      properties: record.get('props') as Record<string, unknown>,
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

/**
 * Execute a read-only Cypher query (for GraphVisualization manual input)
 *
 * @param cypher - The Cypher query to execute
 */
export async function runManualCypher(cypher: string): Promise<CypherResult> {
  'use server'

  // Basic safety check - reject write operations
  const normalizedQuery = cypher.trim().toUpperCase()
  const writeKeywords = ['CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE', 'DETACH']

  for (const keyword of writeKeywords) {
    if (normalizedQuery.includes(keyword)) {
      return {
        success: false,
        error: `Manual queries cannot use write operations (${keyword}). Use the chat interface for modifications.`,
      }
    }
  }

  const session = getNeo4jDriver().session()
  try {
    const result = await session.run(cypher)

    // Parse and transform results for Cytoscape
    const parsed = parseNeo4jResults({ records: result.records })
    const graphData = transformNeo4jToCytoscape(parsed.nodes || [], parsed.relationships || [])

    return {
      success: true,
      graphUpdate: graphData,
      raw: result.records.map((r) => r.toObject()),
    }
  } catch (error) {
    console.error('Manual Cypher query failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
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

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Reset the Neo4j connection
 * Forces the driver singleton to reconnect on the next query
 */
export async function resetNeo4jConnection(): Promise<ConnectionResult> {
  'use server'

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

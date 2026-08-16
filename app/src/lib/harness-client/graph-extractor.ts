/**
 * Graph Element Extractor
 *
 * Extracts graph elements (nodes and edges) from harness context events.
 * Maps pattern IDs to graph sources (neo4j, memory) for UI tab filtering.
 */

import type { GraphElement } from './types'

// ============================================================================
// Pattern to Source Mapping
// ============================================================================

/** Map pattern IDs to graph sources */
const PATTERN_SOURCE_MAP: Record<string, GraphElement['source']> = {
  // Neo4j patterns
  'neo4j-query': 'neo4j',
  'neo4j': 'neo4j',
  'ontology': 'neo4j',

  // Memory patterns
  'memory': 'memory',
  'memory-loop': 'memory',
  'session-memory': 'memory',
  'conversational-memory': 'memory',

  // Default to unknown for other patterns
}

/** Determine graph source from pattern ID */
function getSourceFromPattern(patternId: string): GraphElement['source'] {
  // Check exact match first
  if (PATTERN_SOURCE_MAP[patternId]) {
    return PATTERN_SOURCE_MAP[patternId]
  }

  // Check prefix matches
  if (patternId.startsWith('neo4j') || patternId.includes('neo4j')) {
    return 'neo4j'
  }
  if (patternId.startsWith('memory') || patternId.includes('memory')) {
    return 'memory'
  }

  return 'unknown'
}

// ============================================================================
// Tool Result Parsing
// ============================================================================

/** Check if a tool result contains Neo4j graph data */
export function isNeo4jGraphResult(toolName: string, _result: unknown): boolean {
  const neo4jTools = [
    'read_neo4j_cypher',
    'write_neo4j_cypher',
    'get_neo4j_schema'
  ]
  return neo4jTools.some(t => toolName.includes(t))
}

/** Check if a tool result contains Memory graph data */
export function isMemoryGraphResult(toolName: string, _result: unknown): boolean {
  const memoryTools = [
    'read_graph',
    'search_nodes',
    'open_nodes',
    'create_entities',
    'create_relations',
    'add_observations'
  ]
  return memoryTools.some(t => toolName.includes(t))
}

/** Enrichment payload produced by `enrichNeo4jResult()` — original rows plus
 * a 1-hop neighborhood and the list of touched node names (canonical = `name`).
 */
interface EnrichedNeo4jResult {
  rows: unknown
  _neighborhood: { rows: unknown }
  _touched: string[]
}

function isEnrichedNeo4jResult(value: unknown): value is EnrichedNeo4jResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v._touched) && 'rows' in v && '_neighborhood' in v
}

/** Schema-info bag from `get_neo4j_schema` (APOC shape) — never a graph node. */
function looksLikeSchemaInfo(obj: Record<string, unknown>): boolean {
  return (obj.type === 'node' || obj.type === 'relationship') && 'count' in obj
}

/** Parse Neo4j Cypher result into graph elements.
 *
 * Handles two formats:
 * 1. **MCP format** (from neo4j-cypher MCP server): flat record objects where
 *    nodes are `{ name, description, ... }` and relationships are 3-element
 *    arrays `[startNode, "TYPE", endNode]`.
 * 2. **Neo4j driver format**: objects with `identity`/`elementId`, `labels[]`,
 *    `properties{}`.
 */
function parseNeo4jResult(result: unknown, source: GraphElement['source']): GraphElement[] {
  const elements: GraphElement[] = []

  if (!result || typeof result !== 'object') return elements

  // Handle stringified JSON (MCP may return text)
  let parsed = result
  if (typeof result === 'string') {
    try { parsed = JSON.parse(result) } catch { return elements }
  }

  // Enrichment payload from onToolResult hook: original rows + 1-hop neighborhood.
  // Process both as records, then tag nodes whose name is in `_touched`.
  if (isEnrichedNeo4jResult(parsed)) {
    const enriched = parsed as EnrichedNeo4jResult
    const touched = new Set(enriched._touched.map(String))
    const fromRows = parseNeo4jResult(enriched.rows, source)
    const fromNeighborhood = parseNeo4jResult(enriched._neighborhood?.rows, source)
    const all = [...fromRows, ...fromNeighborhood]
    for (const el of all) {
      if (!el.data) continue
      const isNode = el.data.source === undefined && el.data.target === undefined
      if (isNode && el.data.id !== undefined && touched.has(String(el.data.id))) {
        el.data.touched = true
      }
    }
    return deduplicateElements(all)
  }

  // Handle array of records (typical Cypher result)
  const records = Array.isArray(parsed) ? parsed : [parsed]

  for (const record of records) {
    if (!record || typeof record !== 'object') continue

    const rec = record as Record<string, unknown>

    for (const [key, value] of Object.entries(rec)) {
      if (!value) continue

      // MCP relationship format: [startNodeObj, "REL_TYPE", endNodeObj]
      if (Array.isArray(value) && value.length === 3 &&
          typeof value[1] === 'string' &&
          value[0] && typeof value[0] === 'object' &&
          value[2] && typeof value[2] === 'object') {
        const startNode = value[0] as Record<string, unknown>
        const relType = value[1] as string
        const endNode = value[2] as Record<string, unknown>

        const startId = String(startNode.name ?? startNode.id ?? `node-${key}-start`)
        const endId = String(endNode.name ?? endNode.id ?? `node-${key}-end`)

        // Add start and end nodes
        elements.push({
          data: { id: startId, label: startId, type: 'Node', ...startNode },
          source
        })
        elements.push({
          data: { id: endId, label: endId, type: 'Node', ...endNode },
          source
        })
        // Add relationship edge
        elements.push({
          data: {
            id: `${startId}-${relType}-${endId}`,
            source: startId,
            target: endId,
            label: relType
          },
          source
        })
        continue
      }

      // MCP node format: plain object with properties (has name/id, no identity/elementId).
      // Require a string name/id/title to be confident this is a real node — this avoids
      // synthesizing fake nodes from schema-info bags (`get_neo4j_schema` shape) and other
      // metadata-shaped objects. (Bug #14 root cause was the absence of this guard.)
      if (typeof value === 'object' && !Array.isArray(value) && !isNeo4jNode(value)) {
        const obj = value as Record<string, unknown>
        if (looksLikeSchemaInfo(obj)) continue
        const idSource = obj.name ?? obj.id ?? obj.title
        if (typeof idSource !== 'string' || idSource.length === 0) continue
        const id = idSource
        elements.push({
          data: { id, label: id, type: 'Node', ...obj },
          source
        })
        continue
      }

      // Neo4j driver format (identity, labels, properties)
      const extracted = extractGraphEntities(value, source)
      elements.push(...extracted)
    }
  }

  return deduplicateElements(elements)
}

/** Parse Memory MCP result into graph elements */
function parseMemoryResult(result: unknown, source: GraphElement['source']): GraphElement[] {
  const elements: GraphElement[] = []

  if (!result || typeof result !== 'object') return elements

  // Memory graph structure: { entities: [...], relations: [...] }
  const data = result as Record<string, unknown>

  // Parse entities as nodes
  if (Array.isArray(data.entities)) {
    for (const entity of data.entities) {
      if (entity && typeof entity === 'object') {
        const e = entity as Record<string, unknown>
        const id = String(e.name ?? e.id ?? `entity-${elements.length}`)
        elements.push({
          data: {
            id,
            label: String(e.name ?? id),
            type: String(e.entityType ?? 'Entity'),
            observations: e.observations,
            ...e
          },
          source
        })
      }
    }
  }

  // Parse relations as edges
  if (Array.isArray(data.relations)) {
    for (const relation of data.relations) {
      if (relation && typeof relation === 'object') {
        const r = relation as Record<string, unknown>
        const id = `${r.from}-${r.relationType}-${r.to}`
        elements.push({
          data: {
            id,
            source: String(r.from),
            target: String(r.to),
            label: String(r.relationType ?? 'RELATES_TO'),
            ...r
          },
          source
        })
      }
    }
  }

  return deduplicateElements(elements)
}

/** Extract graph entities from a value (recursive) */
function extractGraphEntities(value: unknown, source: GraphElement['source']): GraphElement[] {
  const elements: GraphElement[] = []

  if (!value || typeof value !== 'object') return elements

  // Check if it's a Neo4j Node
  if (isNeo4jNode(value)) {
    const node = value as Neo4jNode
    elements.push({
      data: {
        id: String(node.identity ?? node.elementId ?? `node-${Date.now()}`),
        label: node.properties?.name ?? node.labels?.[0] ?? 'Node',
        type: node.labels?.[0] ?? 'Node',
        ...node.properties
      },
      source
    })
  }

  // Check if it's a Neo4j Relationship
  if (isNeo4jRelationship(value)) {
    const rel = value as Neo4jRelationship
    elements.push({
      data: {
        id: String(rel.identity ?? rel.elementId ?? `rel-${Date.now()}`),
        source: String(rel.start ?? rel.startNodeElementId),
        target: String(rel.end ?? rel.endNodeElementId),
        label: rel.type ?? 'RELATES_TO',
        ...rel.properties
      },
      source
    })
  }

  // Check if it's a Neo4j Path
  if (isNeo4jPath(value)) {
    const path = value as Neo4jPath
    if (path.segments) {
      for (const segment of path.segments) {
        elements.push(...extractGraphEntities(segment.start, source))
        elements.push(...extractGraphEntities(segment.relationship, source))
        elements.push(...extractGraphEntities(segment.end, source))
      }
    }
  }

  // Recurse into arrays
  if (Array.isArray(value)) {
    for (const item of value) {
      elements.push(...extractGraphEntities(item, source))
    }
  }

  return elements
}

// ============================================================================
// Neo4j Type Guards
// ============================================================================

interface Neo4jNode {
  identity?: number | string
  elementId?: string
  labels?: string[]
  properties?: Record<string, unknown>
}

interface Neo4jRelationship {
  identity?: number | string
  elementId?: string
  type?: string
  start?: number | string
  end?: number | string
  startNodeElementId?: string
  endNodeElementId?: string
  properties?: Record<string, unknown>
}

interface Neo4jPath {
  segments?: Array<{
    start: Neo4jNode
    relationship: Neo4jRelationship
    end: Neo4jNode
  }>
}

function isNeo4jNode(value: unknown): value is Neo4jNode {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    ('identity' in v || 'elementId' in v) &&
    (Array.isArray(v.labels) || v.properties !== undefined)
  )
}

function isNeo4jRelationship(value: unknown): value is Neo4jRelationship {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    ('identity' in v || 'elementId' in v) &&
    ('type' in v || 'start' in v || 'end' in v)
  )
}

function isNeo4jPath(value: unknown): value is Neo4jPath {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return 'segments' in v && Array.isArray(v.segments)
}

// ============================================================================
// Deduplication
// ============================================================================

function deduplicateElements(elements: GraphElement[]): GraphElement[] {
  const seen = new Set<string>()
  return elements.filter(el => {
    const id = el.data?.id
    if (!id || seen.has(String(id))) return false
    seen.add(String(id))
    return true
  })
}

// ============================================================================
// Main Extractor
// ============================================================================

/** Event structure from harness context */
interface ToolResultEvent {
  type: 'tool_result'
  ts: number
  patternId: string
  data: {
    tool: string
    result: unknown
    success: boolean
    error?: string
  }
}

/** Extract graph elements from harness context events */
export function extractGraphElements(events: unknown[]): GraphElement[] {
  const elements: GraphElement[] = []

  for (const event of events) {
    if (!event || typeof event !== 'object') continue

    const e = event as Record<string, unknown>

    // Only process tool_result events
    if (e.type !== 'tool_result') continue

    const toolEvent = event as ToolResultEvent
    const { patternId, data } = toolEvent

    if (!data?.success || !data?.result) continue

    const toolName = data.tool ?? ''
    const result = data.result

    // Schema is metadata, not graph data — skip entirely. (Bug #14: the APOC schema
    // shape `{ Concept: { type: 'node', count, ... }, HAS_CONCEPT: { type: 'relationship', count } }`
    // would otherwise produce one fake node per top-level key.)
    if (toolName === 'get_neo4j_schema') continue

    // Determine source based on pattern ID and tool name
    let source = getSourceFromPattern(patternId)

    // Override source based on tool type if unknown
    if (source === 'unknown') {
      if (isNeo4jGraphResult(toolName, result)) {
        source = 'neo4j'
      } else if (isMemoryGraphResult(toolName, result)) {
        source = 'memory'
      }
    }

    // Parse based on tool type
    if (isNeo4jGraphResult(toolName, result)) {
      elements.push(...parseNeo4jResult(result, source))
    } else if (isMemoryGraphResult(toolName, result)) {
      elements.push(...parseMemoryResult(result, source))
    }
  }

  return deduplicateElements(elements)
}

/** Extract graph elements from a harness result */
export function extractGraphFromResult(result: {
  context?: { events?: unknown[] }
}): GraphElement[] {
  if (!result?.context?.events) return []
  return extractGraphElements(result.context.events)
}

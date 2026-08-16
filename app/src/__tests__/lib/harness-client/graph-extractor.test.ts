/**
 * graph-extractor tests — driven by real MCP responses captured against the
 * live `kg-agent-mcp-gateway`. Fixtures live in `./fixtures/`.
 *
 * Regression target: bug #14 (relationship types from `get_neo4j_schema`
 * being rendered as nodes), and the new `_neighborhood`/`_touched`
 * enrichment payload produced by `neo4j-enricher.server.ts`.
 */

import { describe, it, expect } from 'vitest'
import { extractGraphElements } from '../../../lib/harness-client/graph-extractor'

import schemaFixture from './fixtures/neo4j-schema.json'
import singleNodeFixture from './fixtures/cypher-single-node.json'
import neighborhoodFixture from './fixtures/cypher-redis-neighborhood.json'
import enrichedFixture from './fixtures/enriched-result.json'

function toolResultEvent(tool: string, result: unknown) {
  return {
    type: 'tool_result' as const,
    ts: Date.now(),
    patternId: 'neo4j-query',
    data: { tool, result, success: true },
  }
}

describe('graph-extractor — schema regression (#14)', () => {
  it('returns no elements for get_neo4j_schema (no fake nodes from APOC shape)', () => {
    const elements = extractGraphElements([toolResultEvent('get_neo4j_schema', schemaFixture)])
    expect(elements).toEqual([])
  })

  it('does not synthesize nodes from schema-info bags even via other tools', () => {
    // If a future tool happened to return a value shaped like { type: 'node', count: 37 },
    // the tightened fallback should still refuse to fabricate a node.
    const fakeResult = [{ Concept: { type: 'node', count: 37 } }]
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', fakeResult)])
    expect(elements).toEqual([])
  })
})

describe('graph-extractor — read_neo4j_cypher (MCP shape)', () => {
  it('extracts a single returned node with name as canonical id', () => {
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', singleNodeFixture)])
    expect(elements).toHaveLength(1)
    expect(elements[0].data?.id).toBe('Redis')
    expect(elements[0].data?.label).toBe('Redis')
    // GraphElement.source is the tab-routing tag (top-level field).
    expect(elements[0].source).toBe('neo4j')
    // No Cytoscape edge endpoints → it's a node, not an edge.
    expect(elements[0].data?.source).toBeUndefined()
    expect(elements[0].data?.target).toBeUndefined()
  })

  it('extracts nodes + edges from a 5-row 3-tuple neighborhood result', () => {
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', neighborhoodFixture)])

    const nodes = elements.filter(e => !isEdge(e))
    const edges = elements.filter(e => isEdge(e))

    // Redis + 5 unique neighbors
    expect(nodes.map(n => n.data?.id).sort()).toEqual([
      'C Programming Language',
      'In-Memory Data Platform',
      'Open Source',
      'Redis',
      'Redis 8.6.2',
      'vector embedding',
    ])

    // 5 edges (one per row), all connecting Redis to a neighbor
    expect(edges).toHaveLength(5)
    for (const edge of edges) {
      expect(edge.data?.source).toBe('Redis')
      expect(typeof edge.data?.target).toBe('string')
      expect(edge.data?.target).not.toBe('Redis')
      expect(typeof edge.data?.label).toBe('string')
    }
  })

  it('refuses to fabricate nodes from objects without a name/id/title', () => {
    const result = [{ count: { value: 42 }, summary: { rows: 1 } }]
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])
    expect(elements).toEqual([])
  })
})

describe('graph-extractor — enrichment payload', () => {
  it('processes rows + neighborhood and tags touched nodes', () => {
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', enrichedFixture)])

    const nodes = elements.filter(e => !isEdge(e))
    const edges = elements.filter(e => isEdge(e))

    const ids = nodes.map(n => n.data?.id).sort()
    expect(ids).toEqual(['Open Source', 'Redis', 'vector embedding'])

    // Only `Redis` is in `_touched` — should be tagged. Neighbors must not be.
    const redis = nodes.find(n => n.data?.id === 'Redis')
    const ve = nodes.find(n => n.data?.id === 'vector embedding')
    const os = nodes.find(n => n.data?.id === 'Open Source')
    expect(redis?.data?.touched).toBe(true)
    expect(ve?.data?.touched).toBeUndefined()
    expect(os?.data?.touched).toBeUndefined()

    // Both neighborhood edges land
    expect(edges).toHaveLength(2)
    expect(edges.every(e => e.data?.source === 'Redis')).toBe(true)
  })
})

function isEdge(element: { data?: Record<string, unknown> }): boolean {
  return element.data?.source !== undefined && element.data?.target !== undefined
}

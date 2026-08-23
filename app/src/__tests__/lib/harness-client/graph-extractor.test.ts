/**
 * graph-extractor tests — driven by real MCP responses captured against the
 * live `kg-agent-mcp-gateway`. Fixtures live in `./fixtures/`.
 *
 * Regression target: bug #14 (relationship types from `get_neo4j_schema`
 * being rendered as nodes), and the new `_neighborhood`/`_touched`
 * enrichment payload produced by `neo4j-enricher.server.ts`.
 */

import { describe, it, expect } from 'vitest'
import {
  extractGraphElements,
  isEdgeElement,
  isNodeElement,
} from '../../../lib/harness-client/graph-extractor'

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
    const elements = extractGraphElements([
      toolResultEvent('read_neo4j_cypher', neighborhoodFixture),
    ])

    const nodes = elements.filter((e) => !isEdge(e))
    const edges = elements.filter((e) => isEdge(e))

    // Redis + 5 unique neighbors
    expect(nodes.map((n) => n.data?.id).sort()).toEqual([
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

    const nodes = elements.filter((e) => !isEdge(e))
    const edges = elements.filter((e) => isEdge(e))

    const ids = nodes.map((n) => n.data?.id).sort()
    expect(ids).toEqual(['Open Source', 'Redis', 'vector embedding'])

    // Only `Redis` is in `_touched` — should be tagged. Neighbors must not be.
    const redis = nodes.find((n) => n.data?.id === 'Redis')
    const ve = nodes.find((n) => n.data?.id === 'vector embedding')
    const os = nodes.find((n) => n.data?.id === 'Open Source')
    expect(redis?.data?.touched).toBe(true)
    expect(ve?.data?.touched).toBeUndefined()
    expect(os?.data?.touched).toBeUndefined()

    // Both neighborhood edges land
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.data?.source === 'Redis')).toBe(true)
  })
})

function isEdge(element: { data?: Record<string, unknown> }): boolean {
  return isEdgeElement(element)
}

// ============================================================================
// SA-H9 / SA-M12 — element identity and node-vs-edge classification
// ============================================================================

describe('graph-extractor — element identity (SA-H9)', () => {
  // A Neo4j node may carry any property name, `id` included. The builders used
  // to spread properties AFTER pinning the computed id, so such a property
  // silently replaced it — Cytoscape then rejected the element and `cy.add()`
  // threw inside a createEffect, blanking the entire graph tab.
  it('keeps the derived id when a record property is also called id', () => {
    const result = [{ n: { name: 'Redis', id: 4711, label: 'not-a-label', type: 'not-a-type' } }]
    const [node] = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])

    expect(node.data?.id).toBe('Redis')
    expect(node.data?.label).toBe('Redis')
    expect(node.data?.type).toBe('Node')
    // The colliding property is not silently dropped either — it is preserved
    // under its own key for the property inspector.
    expect(node.data?.kind).toBe('node')
  })

  it('keeps derived ids on both endpoints of a relationship triple', () => {
    const result = [{ r: [{ name: 'A', id: 1 }, 'LINKS', { name: 'B', id: 2 }] }]
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])

    const nodes = elements.filter(isNodeElement)
    const edges = elements.filter(isEdgeElement)
    expect(nodes.map((n) => n.data?.id)).toEqual(['A', 'B'])
    expect(edges).toHaveLength(1)
    expect(edges[0].data?.id).toBe('A-LINKS-B')
    expect(edges[0].data?.source).toBe('A')
    expect(edges[0].data?.target).toBe('B')
  })

  it('keeps the derived id on a memory entity whose property is called id', () => {
    const result = { entities: [{ name: 'Ada', id: 99, entityType: 'Person' }], relations: [] }
    const [node] = extractGraphElements([toolResultEvent('read_graph', result)])
    expect(node.data?.id).toBe('Ada')
    expect(node.data?.type).toBe('Person')
  })

  it('keeps the derived label on a driver-shaped node with a label property', () => {
    const result = [
      { n: { identity: 7, labels: ['Concept'], properties: { name: 'Graphs', id: 'nope' } } },
    ]
    const [node] = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])
    expect(node.data?.id).toBe('7')
    expect(node.data?.label).toBe('Graphs')
    expect(node.data?.type).toBe('Concept')
  })
})

describe('graph-extractor — node vs edge (SA-M12)', () => {
  // `(:Chunk {source: …})` is a real shape in this repo's Data Stash schema.
  // Classification used to be "has a `source` key", so such a node was counted,
  // styled and (via Cytoscape's own inference) constructed as an edge.
  it('classifies a node with source/target properties as a node', () => {
    const result = [{ c: { name: 'chunk-1', source: 'report.pdf', target: 'irrelevant' } }]
    const [el] = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])

    expect(el.data?.kind).toBe('node')
    expect(el.group).toBe('nodes')
    expect(isNodeElement(el)).toBe(true)
    expect(isEdgeElement(el)).toBe(false)
    // The property survives for display — it is just no longer load-bearing.
    expect(el.data?.source).toBe('report.pdf')
  })

  it('stamps kind and group on memory relations', () => {
    const result = {
      entities: [{ name: 'A' }, { name: 'B' }],
      relations: [{ from: 'A', to: 'B', relationType: 'KNOWS' }],
    }
    const elements = extractGraphElements([toolResultEvent('read_graph', result)])
    const edge = elements.find((e) => e.data?.id === 'A-KNOWS-B')!
    expect(edge.data?.kind).toBe('edge')
    expect(edge.group).toBe('edges')
    expect(isEdgeElement(edge)).toBe(true)
  })

  it('falls back to the endpoint shape for elements with no kind stamp', () => {
    // Graphs restored from a session persisted before `kind` existed.
    expect(isEdgeElement({ data: { id: 'e', source: 'a', target: 'b' } })).toBe(true)
    expect(isNodeElement({ data: { id: 'n', label: 'x' } })).toBe(true)
    // A legacy node carrying only `source` is not an edge either.
    expect(isEdgeElement({ data: { id: 'n', source: 'report.pdf' } })).toBe(false)
  })

  it('prefers an explicit kind over the endpoint shape', () => {
    expect(isEdgeElement({ data: { id: 'n', kind: 'node', source: 'a', target: 'b' } })).toBe(false)
    expect(isEdgeElement({ data: { id: 'e', kind: 'edge' } })).toBe(true)
  })

  it('treats a data-less element as neither', () => {
    expect(isEdgeElement({})).toBe(false)
    expect(isNodeElement({})).toBe(false)
  })
})

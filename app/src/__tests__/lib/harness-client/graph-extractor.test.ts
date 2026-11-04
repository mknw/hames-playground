/**
 * graph-extractor tests — driven by real MCP responses captured against the
 * live MCP gateway (port 8811). Fixtures live in `./fixtures/`.
 *
 * Regression target: bug #14 (relationship types from `get_neo4j_schema`
 * being rendered as nodes), and the new `_neighborhood`/`_touched`
 * enrichment payload produced by `neo4j-enricher.server.ts`.
 */

import { describe, it, expect } from 'vitest'
import { extractGraphElements, isEdgeElement, isNodeElement } from '@hames-ai/agents'
import { FENCE, sanitizeUntrusted } from '@hames-ai/harness-patterns/guard'

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

// ============================================================================
// A read on a guarded route (general-next's info route)
// ============================================================================

/** What the info route's guard does to a graph read: every string leaf fenced
 *  (`spotlight: 'always'`), the fence naming the call that returned it. */
function fenced(data: unknown, item: string): unknown {
  return sanitizeUntrusted(
    data,
    { tool: 'read_neo4j_cypher', namespace: 'neo4j', item },
    { spotlight: 'always' },
  ).data
}

function infoEvent(result: unknown) {
  return { ...toolResultEvent('read_neo4j_cypher', result), patternId: 'info' }
}

describe('graph-extractor — a read on a guarded route', () => {
  // The shape the shipped few-shots teach: scalar columns, no node object.
  const rows = [{ name: 'Redis', description: 'An in-memory data store.' }]
  const neighborhood = [
    {
      n: { name: 'Redis' },
      r: [{ name: 'Redis' }, 'HAS_CONCEPT', { name: 'Streams' }],
      m: { name: 'Streams' },
    },
  ]

  it('characterisation: scalar rows alone give the tab nothing to draw', () => {
    // Why the route needs the enricher: without the neighbourhood there is no
    // node object in a `c.name AS name` row.
    expect(extractGraphElements([infoEvent(fenced(rows, 'call-1'))])).toEqual([])
  })

  it('draws a fenced, enriched read with readable ids and the touched node tagged', () => {
    const touched = (fenced(rows, 'call-1') as Array<{ name: string }>).map((r) => r.name)
    expect(touched[0]).toContain(FENCE.open)
    const result = {
      rows: fenced(rows, 'call-1'),
      _neighborhood: { rows: fenced(neighborhood, 'call-2') },
      _touched: touched,
    }
    // MUTATION: drop `unfence` in extractGraphElements — ids carry the fence
    // and the touched tag no longer matches.
    const elements = extractGraphElements([infoEvent(result)])
    const nodes = elements.filter(isNodeElement)
    expect(nodes.map((n) => n.data?.id).sort()).toEqual(['Redis', 'Streams'])
    expect(nodes.find((n) => n.data?.id === 'Redis')?.data?.touched).toBe(true)
    expect(nodes.find((n) => n.data?.id === 'Streams')?.data?.touched).toBeUndefined()
    const edges = elements.filter(isEdgeElement)
    expect(edges.map((e) => [e.data?.source, e.data?.label, e.data?.target])).toEqual([
      ['Redis', 'HAS_CONCEPT', 'Streams'],
    ])
    expect(JSON.stringify(elements)).not.toContain(FENCE.open)
  })

  it('one node read by two calls is one element, though each call fenced it differently', () => {
    const node = [{ c: { name: 'Redis' } }]
    const elements = extractGraphElements([
      infoEvent(fenced(node, 'call-1')),
      infoEvent(fenced(node, 'call-2')),
    ])
    expect(elements.map((e) => e.data?.id)).toEqual(['Redis'])
  })

  it('survives the persisted round trip a reload replays', () => {
    const result = {
      rows: fenced(rows, 'call-1'),
      _neighborhood: { rows: fenced(neighborhood, 'call-2') },
      _touched: (fenced(rows, 'call-1') as Array<{ name: string }>).map((r) => r.name),
    }
    const replayed = JSON.parse(JSON.stringify([infoEvent(result)])) as unknown[]
    expect(extractGraphElements(replayed).filter(isNodeElement)).toHaveLength(2)
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

  it('keeps the derived label on a driver-shaped node with a label property', () => {
    const result = [
      { n: { identity: 7, labels: ['Concept'], properties: { name: 'Graphs', id: 99 } } },
    ]
    const [node] = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])
    expect(node.data?.id).toBe('7')
    expect(node.data?.label).toBe('Graphs')
    expect(node.data?.type).toBe('Concept')
  })
})

// The org-knowledge graph gives every node a stable string `id`
// (docs/plan/org-knowledge-hook.md, "The Org.graph tab"): one key per node.
// Mutations, each verified red:
// - key the driver format by identity again → "both result formats" goes red.
// - stop rewriting a relationship's ends → "a driver relationship" goes red.
// - match `_touched` by id only → "still touched by name" goes red.
describe('graph-extractor — one key per node (org-knowledge slice 5)', () => {
  const plain = { n: { id: 'p-osprey', name: 'Osprey' } }
  const driver = {
    n: { identity: 7, labels: ['Project'], properties: { id: 'p-osprey', name: 'Osprey' } },
  }

  it('a node in both result formats yields one element, keyed by its id', () => {
    const elements = extractGraphElements([
      toolResultEvent('read_neo4j_cypher', [plain]),
      toolResultEvent('read_neo4j_cypher', [driver]),
    ])
    expect(elements.map((e) => e.data?.id)).toEqual(['p-osprey'])
    expect(elements[0].data?.label).toBe('Osprey')
  })

  it('a driver relationship names its ends by their stable keys', () => {
    const result = [
      {
        n: driver.n,
        rels: [{ identity: 31, type: 'IN_PILLAR', start: 7, end: 8 }],
        m: { identity: 8, labels: ['Pillar'], properties: { id: 'pl-A', name: 'Pillar A' } },
      },
    ]
    const edges = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)]).filter(
      isEdgeElement,
    )
    expect(edges.map((e) => [e.data?.source, e.data?.target])).toEqual([['p-osprey', 'pl-A']])
  })

  it('an MCP relationship triple keys its ends by id, labelled by name', () => {
    const result = [{ r: [plain.n, 'IN_PILLAR', { id: 'pl-A', name: 'Pillar A' }] }]
    const elements = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])
    expect(elements.filter(isNodeElement).map((n) => [n.data?.id, n.data?.label])).toEqual([
      ['p-osprey', 'Osprey'],
      ['pl-A', 'Pillar A'],
    ])
    expect(elements.filter(isEdgeElement)[0].data?.id).toBe('p-osprey-IN_PILLAR-pl-A')
  })

  it('an enriched read: a node keyed by id is still touched by name', () => {
    const result = { rows: [plain], _neighborhood: { rows: [] }, _touched: ['Osprey'] }
    const [node] = extractGraphElements([toolResultEvent('read_neo4j_cypher', result)])
    expect(node.data?.id).toBe('p-osprey')
    expect(node.data?.touched).toBe(true)
  })

  it('a legacy node without a string id keeps its name key', () => {
    const [node] = extractGraphElements([
      toolResultEvent('read_neo4j_cypher', [{ n: { name: 'Lantern' } }]),
    ])
    expect(node.data?.id).toBe('Lantern')
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

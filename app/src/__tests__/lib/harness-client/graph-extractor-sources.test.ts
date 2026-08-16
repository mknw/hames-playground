/**
 * graph-extractor — the paths the fixture-driven `graph-extractor.test.ts`
 * doesn't reach: Memory-MCP results, the Neo4j *driver* shape (node /
 * relationship / path objects), source routing by patternId vs. tool name,
 * and the event-level guards (failed calls, non-graph tools, dedup).
 */

import { describe, it, expect } from 'vitest'
import {
  extractGraphElements,
  extractGraphFromResult,
  isNeo4jGraphResult,
  isMemoryGraphResult,
} from '../../../lib/harness-client/graph-extractor'

function ev(tool: string, result: unknown, patternId = 'neo4j-query', success = true) {
  return { type: 'tool_result' as const, ts: 1, patternId, data: { tool, result, success } }
}

function isEdge(el: { data?: Record<string, unknown> }): boolean {
  return el.data?.source !== undefined && el.data?.target !== undefined
}

describe('tool classification', () => {
  it('recognises the three neo4j cypher/schema tools, namespaced or not', () => {
    expect(isNeo4jGraphResult('read_neo4j_cypher', null)).toBe(true)
    expect(isNeo4jGraphResult('mcp__gateway__write_neo4j_cypher', null)).toBe(true)
    expect(isNeo4jGraphResult('get_neo4j_schema', null)).toBe(true)
    expect(isNeo4jGraphResult('search', null)).toBe(false)
  })

  it('recognises the memory-graph tools', () => {
    for (const t of [
      'read_graph',
      'search_nodes',
      'open_nodes',
      'create_entities',
      'create_relations',
      'add_observations',
    ]) {
      expect(isMemoryGraphResult(t, null)).toBe(true)
    }
    expect(isMemoryGraphResult('fetch_content', null)).toBe(false)
  })
})

describe('memory MCP results', () => {
  const memoryGraph = {
    entities: [
      { name: 'Redis', entityType: 'Database', observations: ['in-memory'] },
      { name: 'Solid', entityType: 'Framework' },
    ],
    relations: [{ from: 'Solid', to: 'Redis', relationType: 'USES' }],
  }

  it('turns entities into nodes and relations into edges', () => {
    const elements = extractGraphElements([ev('read_graph', memoryGraph, 'memory-loop')])

    const nodes = elements.filter((e) => !isEdge(e))
    const edges = elements.filter((e) => isEdge(e))

    expect(nodes.map((n) => n.data?.id)).toEqual(['Redis', 'Solid'])
    expect(nodes[0].data).toMatchObject({
      label: 'Redis',
      type: 'Database',
      observations: ['in-memory'],
    })
    expect(nodes[1].data?.type).toBe('Framework')

    expect(edges).toHaveLength(1)
    expect(edges[0].data).toMatchObject({
      id: 'Solid-USES-Redis',
      source: 'Solid',
      target: 'Redis',
      label: 'USES',
    })
    expect(edges[0].source).toBe('memory')
  })

  it('falls back to a default entity type and RELATES_TO label', () => {
    const elements = extractGraphElements([
      ev(
        'read_graph',
        { entities: [{ name: 'X' }], relations: [{ from: 'X', to: 'Y' }] },
        'memory',
      ),
    ])
    expect(elements.find((e) => !isEdge(e))?.data?.type).toBe('Entity')
    expect(elements.find(isEdge)?.data?.label).toBe('RELATES_TO')
  })

  it('skips malformed entries instead of emitting broken elements', () => {
    const elements = extractGraphElements([
      ev(
        'read_graph',
        {
          entities: [null, 'nope', { name: 'Good' }],
          relations: [null, { from: 'Good', to: 'Good', relationType: 'SELF' }],
        },
        'memory',
      ),
    ])
    expect(elements.map((e) => e.data?.id)).toEqual(['Good', 'Good-SELF-Good'])
  })

  it('yields nothing for a result with neither entities nor relations', () => {
    expect(extractGraphElements([ev('read_graph', { ok: true }, 'memory')])).toEqual([])
    expect(extractGraphElements([ev('read_graph', 'a plain string', 'memory')])).toEqual([])
  })
})

describe('neo4j driver shapes', () => {
  it('extracts a driver Node with its labels and properties', () => {
    const result = [
      { n: { identity: 7, labels: ['Concept'], properties: { name: 'Vector Search', weight: 3 } } },
    ]
    const [node] = extractGraphElements([ev('read_neo4j_cypher', result)])

    expect(node.data).toMatchObject({ id: '7', label: 'Vector Search', type: 'Concept', weight: 3 })
    expect(node.source).toBe('neo4j')
  })

  it('labels a driver Node by its first label when it has no name property', () => {
    const result = [{ n: { elementId: '4:abc:1', labels: ['Chunk'], properties: { text: 'x' } } }]
    const [node] = extractGraphElements([ev('read_neo4j_cypher', result)])
    expect(node.data).toMatchObject({ id: '4:abc:1', label: 'Chunk', type: 'Chunk' })
  })

  it('extracts a driver Relationship inside a collection as an edge', () => {
    const result = [{ rels: [{ identity: 11, type: 'HAS_CONCEPT', start: 1, end: 2 }] }]
    const [edge] = extractGraphElements([ev('read_neo4j_cypher', result)])
    expect(edge.data).toMatchObject({ id: '11', source: '1', target: '2', label: 'HAS_CONCEPT' })
  })

  it('uses the elementId endpoints when the numeric ones are absent', () => {
    const result = [
      {
        rels: [
          { elementId: '5:r:1', type: 'LINKS', startNodeElementId: 'a', endNodeElementId: 'b' },
        ],
      },
    ]
    const [edge] = extractGraphElements([ev('read_neo4j_cypher', result)])
    expect(edge.data).toMatchObject({ id: '5:r:1', source: 'a', target: 'b', label: 'LINKS' })
  })

  it('walks a driver Path into its nodes and relationships', () => {
    const start = { identity: 1, labels: ['A'], properties: { name: 'Start' } }
    const end = { identity: 2, labels: ['B'], properties: { name: 'End' } }
    const relationship = { identity: 3, type: 'TO', start: 1, end: 2 }
    const result = [{ paths: [{ segments: [{ start, relationship, end }] }] }]
    const elements = extractGraphElements([ev('read_neo4j_cypher', result)])

    expect(elements.map((e) => e.data?.id)).toEqual(['1', '3', '2'])
    expect(elements.filter(isEdge)).toHaveLength(1)
  })

  it('drops a bare driver Relationship sitting directly under a record key', () => {
    // Documented limitation, not a desired behaviour: the MCP-node fallback
    // (graph-extractor.ts:182-193) claims the value first and requires a
    // string name/id/title, so a driver-shaped relationship never becomes an
    // edge unless it is nested in a collection. See the PR body.
    const result = [
      { r: { identity: 11, type: 'HAS_CONCEPT', start: 1, end: 2, properties: { score: 0.9 } } },
    ]
    expect(extractGraphElements([ev('read_neo4j_cypher', result)]).filter(isEdge)).toEqual([])
  })

  it('recurses into arrays of driver objects', () => {
    const nodes = [
      { identity: 1, labels: ['A'], properties: { name: 'One' } },
      { identity: 2, labels: ['A'], properties: { name: 'Two' } },
    ]
    const elements = extractGraphElements([ev('read_neo4j_cypher', [{ ns: nodes }])])
    expect(elements.map((e) => e.data?.label)).toEqual(['One', 'Two'])
  })

  it('deduplicates a node returned by several rows', () => {
    const node = { identity: 9, labels: ['A'], properties: { name: 'Same' } }
    const elements = extractGraphElements([ev('read_neo4j_cypher', [{ n: node }, { n: node }])])
    expect(elements).toHaveLength(1)
  })

  it('deduplicates across events, keeping the first occurrence', () => {
    const events = [
      ev('read_neo4j_cypher', [{ n: { name: 'Redis', note: 'first' } }]),
      ev('read_neo4j_cypher', [{ n: { name: 'Redis', note: 'second' } }]),
    ]
    const elements = extractGraphElements(events)
    expect(elements).toHaveLength(1)
    expect(elements[0].data?.note).toBe('first')
  })
})

describe('MCP 3-tuple relationships', () => {
  it('synthesizes ids for endpoint objects that carry neither name nor id', () => {
    const result = [{ row: [{ note: 'left' }, 'LINKS', { note: 'right' }] }]
    const elements = extractGraphElements([ev('read_neo4j_cypher', result)])

    expect(elements.map((e) => e.data?.id)).toEqual([
      'node-row-start',
      'node-row-end',
      'node-row-start-LINKS-node-row-end',
    ])
  })

  it('is not fooled by a 3-element array that is not a relationship', () => {
    const result = [{ row: ['a', 'b', 'c'] }]
    expect(extractGraphElements([ev('read_neo4j_cypher', result)])).toEqual([])
  })
})

describe('source routing', () => {
  it('routes by patternId when the pattern is known', () => {
    const [el] = extractGraphElements([ev('read_neo4j_cypher', [{ n: { name: 'A' } }], 'ontology')])
    expect(el.source).toBe('neo4j')
  })

  it('routes by a patternId that merely contains neo4j / memory', () => {
    const [neo] = extractGraphElements([
      ev('read_neo4j_cypher', [{ n: { name: 'A' } }], 'custom-neo4j-route'),
    ])
    expect(neo.source).toBe('neo4j')
    const [mem] = extractGraphElements([
      ev('read_graph', { entities: [{ name: 'B' }] }, 'custom-memory-route'),
    ])
    expect(mem.source).toBe('memory')
  })

  it('falls back to the tool name when the patternId says nothing', () => {
    const [neo] = extractGraphElements([ev('read_neo4j_cypher', [{ n: { name: 'A' } }], 'router')])
    expect(neo.source).toBe('neo4j')
    const [mem] = extractGraphElements([ev('read_graph', { entities: [{ name: 'B' }] }, 'router')])
    expect(mem.source).toBe('memory')
  })
})

describe('event-level guards', () => {
  it('ignores everything that is not a successful tool_result with a payload', () => {
    const elements = extractGraphElements([
      null,
      'not an event',
      { type: 'assistant_message', data: { content: 'hi' } },
      ev('read_neo4j_cypher', [{ n: { name: 'Nope' } }], 'neo4j-query', false),
      {
        type: 'tool_result',
        ts: 1,
        patternId: 'neo4j-query',
        data: { tool: 'read_neo4j_cypher', success: true },
      },
    ])
    expect(elements).toEqual([])
  })

  it('ignores tools that produce no graph data at all', () => {
    expect(
      extractGraphElements([ev('search', { results: [{ title: 'x' }] }, 'web-search')]),
    ).toEqual([])
  })

  it('never derives graph elements from get_neo4j_schema, whatever it returns', () => {
    const schemaish = {
      Concept: { type: 'node', count: 37 },
      HAS_CONCEPT: { type: 'relationship', count: 12 },
    }
    expect(extractGraphElements([ev('get_neo4j_schema', schemaish)])).toEqual([])
  })
})

describe('extractGraphFromResult', () => {
  it('reads the events off a harness result', () => {
    const result = {
      context: { events: [ev('read_graph', { entities: [{ name: 'E' }] }, 'memory')] },
    }
    expect(extractGraphFromResult(result).map((e) => e.data?.id)).toEqual(['E'])
  })

  it('returns nothing for a result with no context or no events', () => {
    expect(extractGraphFromResult({})).toEqual([])
    expect(extractGraphFromResult({ context: {} })).toEqual([])
  })
})

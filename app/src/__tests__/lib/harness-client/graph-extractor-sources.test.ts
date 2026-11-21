/**
 * graph-extractor — the paths the fixture-driven `graph-extractor.test.ts`
 * doesn't reach: the Neo4j *driver* shape (node /
 * relationship / path objects), source routing by patternId vs. tool name,
 * and the event-level guards (failed calls, non-graph tools, dedup).
 */

import { describe, it, expect } from 'vitest'
import {
  extractGraphElements,
  extractGraphFromResult,
  isNeo4jGraphResult,
  isEdgeElement,
  isNodeElement,
} from '@hames-ai/agents'

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
})

// The shared memory graph was retired: its results are not graph data, whatever
// pattern or tool name carries them, and the module no longer exports a probe.
describe('retired memory-graph results', () => {
  const memoryGraph = {
    entities: [{ name: 'Redis', entityType: 'Database' }],
    relations: [{ from: 'Solid', to: 'Redis', relationType: 'USES' }],
  }

  it.each(['memory', 'memory-loop', 'neo4j-query'])('extracts nothing under pattern %s', (id) => {
    expect(extractGraphElements([ev('read_graph', memoryGraph, id)])).toEqual([])
  })

  it('no longer exports isMemoryGraphResult', async () => {
    expect(await import('@hames-ai/agents')).not.toHaveProperty('isMemoryGraphResult')
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
    expect(edge.data).toMatchObject({
      id: 'neo4j-rel:11',
      source: '1',
      target: '2',
      label: 'HAS_CONCEPT',
    })
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
    expect(edge.data).toMatchObject({
      id: 'neo4j-rel:5:r:1',
      source: 'a',
      target: 'b',
      label: 'LINKS',
    })
  })

  it('walks a driver Path into its nodes and relationships', () => {
    const start = { identity: 1, labels: ['A'], properties: { name: 'Start' } }
    const end = { identity: 2, labels: ['B'], properties: { name: 'End' } }
    const relationship = { identity: 3, type: 'TO', start: 1, end: 2 }
    const result = [{ paths: [{ segments: [{ start, relationship, end }] }] }]
    const elements = extractGraphElements([ev('read_neo4j_cypher', result)])

    expect(elements.map((e) => e.data?.id)).toEqual(['1', 'neo4j-rel:3', '2'])
    expect(elements.filter(isEdge)).toHaveLength(1)
  })

  it.each([
    ['without properties', { identity: 11, type: 'HAS_CONCEPT', start: 1, end: 2 }],
    [
      'with properties',
      { identity: 11, type: 'HAS_CONCEPT', start: 1, end: 2, properties: { score: 0.9 } },
    ],
    [
      'with a name property',
      { identity: 11, type: 'HAS_CONCEPT', start: 1, end: 2, properties: { name: 'relname' } },
    ],
    [
      'with elementId endpoints',
      {
        elementId: '5:r:1',
        type: 'HAS_CONCEPT',
        startNodeElementId: '1',
        endNodeElementId: '2',
        properties: { score: 0.9 },
      },
    ],
  ])('extracts a bare driver Relationship %s as exactly one edge (#14)', (_name, rel) => {
    const elements = extractGraphElements([ev('read_neo4j_cypher', [{ r: rel }])])
    expect(elements).toEqual([
      {
        group: 'edges',
        source: 'neo4j',
        data: {
          ...('properties' in rel ? rel.properties : {}),
          id: 'identity' in rel ? 'neo4j-rel:11' : 'neo4j-rel:5:r:1',
          source: '1',
          target: '2',
          label: 'HAS_CONCEPT',
          kind: 'edge',
        },
      },
    ])
  })

  it.each(['record', 'collection', 'path'])(
    'keeps both nodes and the relationship through %s extraction and deduplication (#14)',
    (shape) => {
      const start = { identity: 1, labels: ['Concept'], properties: { name: 'Start' } }
      const end = { identity: 2, labels: ['Concept'], properties: { name: 'End' } }
      const relationship = {
        identity: 11,
        type: 'HAS_CONCEPT',
        start: 1,
        end: 2,
        properties: { score: 0.9 },
      }
      const row =
        shape === 'record'
          ? { start, r: relationship, end }
          : shape === 'collection'
            ? { values: [start, relationship, end] }
            : { paths: [{ segments: [{ start, relationship, end }] }] }
      // Repeated rows and events must retain one edge, never its phantom node.
      const event = ev('read_neo4j_cypher', [row, row])
      const elements = extractGraphElements([event, event])
      expect(elements).toHaveLength(3)
      expect(elements.filter(isNodeElement).map((el) => el.data?.id)).toEqual(['1', '2'])
      expect(elements.filter(isEdgeElement)).toEqual([
        {
          group: 'edges',
          source: 'neo4j',
          data: {
            id: 'neo4j-rel:11',
            source: '1',
            target: '2',
            label: 'HAS_CONCEPT',
            kind: 'edge',
            score: 0.9,
          },
        },
      ])
    },
  )

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

  it('routes by a patternId that merely contains neo4j', () => {
    const [neo] = extractGraphElements([
      ev('read_neo4j_cypher', [{ n: { name: 'A' } }], 'custom-neo4j-route'),
    ])
    expect(neo.source).toBe('neo4j')
  })

  it('falls back to the tool name when the patternId says nothing', () => {
    const [neo] = extractGraphElements([ev('read_neo4j_cypher', [{ n: { name: 'A' } }], 'router')])
    expect(neo.source).toBe('neo4j')
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
      context: { events: [ev('read_neo4j_cypher', [{ n: { name: 'E' } }])] },
    }
    expect(extractGraphFromResult(result).map((e) => e.data?.name ?? e.data?.id)).toEqual(['E'])
  })

  it('returns nothing for a result with no context or no events', () => {
    expect(extractGraphFromResult({})).toEqual([])
    expect(extractGraphFromResult({ context: {} })).toEqual([])
  })
})

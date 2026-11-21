/** Driver and flat-record regressions; synthetic inputs, no external service. */
import { describe, expect, it } from 'vitest'
import neo4j from 'neo4j-driver'
import cytoscape from 'cytoscape'
import { extractGraphElements, isEdgeElement, isNodeElement } from '@hames-ai/agents'

const event = (result: unknown, tool = 'read_neo4j_cypher', success = true) => ({
  type: 'tool_result',
  ts: 1,
  patternId: 'info',
  data: { tool, result, success },
})
const start = { identity: 101, labels: ['Concept'], properties: { name: 'First' } }
const end = { identity: 102, labels: ['Concept'], properties: { name: 'Second' } }
const rel = { identity: 201, type: 'CONNECTS', start: 101, end: 102 }
const edge = (properties: Record<string, unknown> = {}, identity = '201') => ({
  group: 'edges',
  source: 'neo4j',
  data: {
    ...properties,
    id: `neo4j-rel:${identity}`,
    source: '101',
    target: '102',
    label: 'CONNECTS',
    kind: 'edge',
  },
})
const node = (id: string, name: string) => ({
  group: 'nodes',
  source: 'neo4j',
  data: { name, id, label: name, type: 'Concept', kind: 'node' },
})

describe('graph-extractor — driver relationships and identity', () => {
  it('bare relationship without properties reaches driver dispatch', () => {
    expect(extractGraphElements([event([{ r: rel }])])).toEqual([edge()])
  })
  it.each(['record', 'collection', 'path'])(
    'properties do not create a phantom node in %s',
    (shape) => {
      const relationship = { ...rel, properties: { name: 'A relationship', score: 0.875 } }
      const row =
        shape === 'record'
          ? { n: start, r: relationship, m: end }
          : shape === 'collection'
            ? { values: [start, relationship, end] }
            : { paths: [{ segments: [{ start, relationship, end }] }] }
      const elements = extractGraphElements([event([row, row]), event([row])])
      expect(elements.filter(isNodeElement).map((el) => el.data?.id)).toEqual(['101', '102'])
      expect(elements.filter(isEdgeElement)).toEqual([edge(relationship.properties)])
      expect(elements).toHaveLength(3)
    },
  )
  it('object-record/enriched wrappers preserve modern endpoints and pinned edge fields', () => {
    const properties = {
      id: 'untrusted',
      source: 'bad',
      target: 'bad',
      label: 'bad',
      kind: 'node',
      score: 0.8,
    }
    const r = {
      elementId: 'r-201',
      type: 'CONNECTS',
      startNodeElementId: 'n-101',
      endNodeElementId: 'n-102',
      properties,
    }
    const elements = extractGraphElements([
      event({ rows: { r }, _neighborhood: { rows: [] }, _touched: [] }),
    ])
    expect(elements).toEqual([
      {
        group: 'edges',
        source: 'neo4j',
        data: {
          ...properties,
          id: 'neo4j-rel:r-201',
          source: 'n-101',
          target: 'n-102',
          label: 'CONNECTS',
          kind: 'edge',
        },
      },
    ])
  })
  it.each(['node', 'relationship'])('schema %s metadata never creates nodes', (type) => {
    expect(
      extractGraphElements([event([{ C: { type, count: 4, name: 'Looks named', id: 'schema' } }])]),
    ).toEqual([])
  })
  it('schema tool is suppressed even if its payload looks like real graph data', () => {
    expect(
      extractGraphElements([event([{ n: start, r: rel, m: end }], 'get_neo4j_schema')]),
    ).toEqual([])
  })
  it('non-graph and failed tool results never contaminate graph sources', () => {
    const rows = [{ n: start, r: rel, m: end }]
    expect(
      extractGraphElements([event(rows, 'search'), event(rows, 'read_neo4j_cypher', false)]),
    ).toEqual([])
  })
  it('flat MCP node properties named identity and type remain node data', () => {
    const properties = { name: 'Acme', identity: 'customer-id', type: 'organization' }
    expect(extractGraphElements([event([{ n: properties }])])).toEqual([
      {
        group: 'nodes',
        source: 'neo4j',
        data: { ...properties, id: 'Acme', label: 'Acme', type: 'Node', kind: 'node' },
      },
    ])
  })
  it('actual Neo4j-driver Integer identities and endpoints produce distinct graph elements', () => {
    const n = new neo4j.types.Node(neo4j.int(101), ['Concept'], { name: 'First' })
    const m = new neo4j.types.Node(neo4j.int(102), ['Concept'], { name: 'Second' })
    const r = new neo4j.types.Relationship(
      neo4j.int(201),
      neo4j.int(101),
      neo4j.int(102),
      'CONNECTS',
      { score: 0.8 },
    )
    const elements = extractGraphElements([event([{ n, r, m }])])
    expect(elements.filter(isNodeElement)).toEqual([node('101', 'First'), node('102', 'Second')])
    expect(elements.filter(isEdgeElement)).toEqual([edge({ score: 0.8 })])
    expect(elements).toHaveLength(3)
  })
  it('distinct node and relationship identity namespaces do not displace each other', () => {
    const r = { ...rel, identity: 101, properties: { score: 0.8 } }
    const elements = extractGraphElements([event([{ n: start, r, m: end }])])
    expect(elements.filter(isNodeElement)).toEqual([node('101', 'First'), node('102', 'Second')])
    expect(elements.filter(isEdgeElement)).toEqual([edge({ score: 0.8 }, '101')])
    expect(elements).toHaveLength(3)
  })
  it('keeps colliding native identities independently selectable on the canvas', () => {
    const elements = extractGraphElements([
      event([{ n: start, r: { ...rel, identity: 101 }, m: end }]),
    ])
    const graph = cytoscape({ headless: true, elements })
    try {
      const relationship = graph.$id('neo4j-rel:101')
      expect(relationship.isEdge()).toBe(true)
      expect(relationship.source().id()).toBe('101')
      expect(relationship.target().id()).toBe('102')
      relationship.select()
      expect(graph.$(':selected').map((el) => el.id())).toEqual(['neo4j-rel:101'])
      expect(graph.$id('101').data('name')).toBe('First')
      graph.$id('101').select()
      expect(
        graph
          .$(':selected')
          .map((el) => el.id())
          .sort(),
      ).toEqual(['101', 'neo4j-rel:101'])
    } finally {
      graph.destroy()
    }
  })
  it('normalizes large driver identities exactly and maps both endpoint forms to stable node ids', () => {
    const first = neo4j.int('9007199254740993')
    const second = neo4j.int('9007199254740994')
    const n = new neo4j.types.Node(first, ['Concept'], { id: 'first', name: 'First' }, 'n-1')
    const m = new neo4j.types.Node(second, ['Concept'], { id: 'second', name: 'Second' }, 'n-2')
    const r = new neo4j.types.Relationship(first, first, second, 'CONNECTS', { score: 0.8 })
    const modern = {
      elementId: 'r-2',
      startNodeElementId: 'n-1',
      endNodeElementId: 'n-2',
      type: 'CONNECTS',
      properties: { score: 0.9 },
    }
    const elements = extractGraphElements([event([{ r, modern, n, m }])])
    expect(elements.filter(isNodeElement)).toEqual([
      node('first', 'First'),
      node('second', 'Second'),
    ])
    expect(elements.filter(isEdgeElement)).toEqual([
      {
        ...edge({ score: 0.8 }, '9007199254740993'),
        data: {
          ...edge({ score: 0.8 }, '9007199254740993').data,
          source: 'first',
          target: 'second',
        },
      },
      {
        ...edge({ score: 0.9 }, 'r-2'),
        data: { ...edge({ score: 0.9 }, 'r-2').data, source: 'first', target: 'second' },
      },
    ])
  })
  it('accepts zero-valued relationship identities and endpoints without properties', () => {
    expect(
      extractGraphElements([event([{ r: { identity: 0, start: 0, end: 1, type: 'LINKS' } }])]),
    ).toEqual([
      {
        group: 'edges',
        source: 'neo4j',
        data: { id: 'neo4j-rel:0', source: '0', target: '1', label: 'LINKS', kind: 'edge' },
      },
    ])
  })
})

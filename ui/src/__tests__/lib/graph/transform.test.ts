/**
 * Tests for the Neo4j → Cytoscape transform layer.
 *
 * Everything here is a pure function, so the tests assert on the shape the
 * graph component actually consumes (`data.id` / `data.source` / `classes`)
 * rather than on how the transform gets there.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  transformNeo4jToCytoscape,
  parseNeo4jResults,
  createSampleGraph,
  type Neo4jNode,
  type Neo4jRelationship,
} from '../../../lib/graph/transform'

/** The transform is chatty by design; keep the test log readable. */
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const node = (over: Partial<Neo4jNode> = {}): Neo4jNode => ({
  identity: 1,
  labels: ['Person'],
  properties: { name: 'Alice' },
  ...over,
})

const rel = (over: Partial<Neo4jRelationship> = {}): Neo4jRelationship => ({
  identity: 10,
  type: 'KNOWS',
  start: 1,
  end: 2,
  properties: {},
  ...over,
})

describe('transformNeo4jToCytoscape', () => {
  it('emits one element per node then one per relationship', () => {
    const elements = transformNeo4jToCytoscape(
      [node({ identity: 1 }), node({ identity: 2, properties: { name: 'Bob' } })],
      [rel()],
    )
    expect(elements.map((e) => e.data.id)).toEqual(['1', '2', '10'])
  })

  it('returns an empty array when there is nothing to draw', () => {
    expect(transformNeo4jToCytoscape([], [])).toEqual([])
  })

  describe('nodes', () => {
    it('prefers the Neo4j 5.x elementId over the legacy identity', () => {
      const [el] = transformNeo4jToCytoscape([node({ identity: 7, elementId: '4:abc:7' })], [])
      expect(el.data.id).toBe('4:abc:7')
      // The legacy identity stays available for callers that still key on it.
      expect(el.data.neo4jId).toBe(7)
    })

    it('carries labels through as both a joined type and a class list', () => {
      const [el] = transformNeo4jToCytoscape([node({ labels: ['Person', 'User'] })], [])
      expect(el.data.type).toBe('Person,User')
      expect(el.data.labels).toEqual(['Person', 'User'])
      expect(el.classes).toBe('label-person label-user')
    })

    it('exposes the raw properties untouched', () => {
      const props = { name: 'Alice', age: 30 }
      const [el] = transformNeo4jToCytoscape([node({ properties: props })], [])
      expect(el.data.properties).toEqual(props)
    })

    describe('display label', () => {
      const labelOf = (properties: Record<string, unknown>, labels = ['Person']) =>
        transformNeo4jToCytoscape([node({ labels, properties })], [])[0].data.label

      it('follows the name > title > id > label precedence', () => {
        expect(labelOf({ name: 'N', title: 'T', id: 'I', label: 'L' })).toBe('N')
        expect(labelOf({ title: 'T', id: 'I', label: 'L' })).toBe('T')
        expect(labelOf({ id: 'I', label: 'L' })).toBe('I')
        expect(labelOf({ label: 'L' })).toBe('L')
      })

      it('coerces non-string label properties to strings', () => {
        expect(labelOf({ id: 42 })).toBe('42')
      })

      it('falls back to the first short, non-empty string property', () => {
        expect(labelOf({ age: 30, empty: '', nickname: 'Ally' })).toBe('Ally')
      })

      it('ignores string properties too long to render as a label', () => {
        expect(labelOf({ bio: 'x'.repeat(60) })).toBe('Person')
      })

      it('falls back to the first node label, then to "Node"', () => {
        expect(labelOf({ age: 30 }, ['Person', 'User'])).toBe('Person')
        expect(labelOf({}, [])).toBe('Node')
      })
    })
  })

  describe('relationships', () => {
    it('prefers the elementId endpoints when Neo4j 5.x supplies them', () => {
      const [edge] = transformNeo4jToCytoscape(
        [],
        [
          rel({
            startNodeElementId: '4:abc:1',
            endNodeElementId: '4:abc:2',
            startNode: 'ignored-start',
            endNode: 'ignored-end',
          }),
        ],
      )
      expect(edge.data.source).toBe('4:abc:1')
      expect(edge.data.target).toBe('4:abc:2')
    })

    it('falls back to startNode/endNode, then to start/end', () => {
      const [viaNode] = transformNeo4jToCytoscape([], [rel({ startNode: 'sn', endNode: 'en' })])
      expect([viaNode.data.source, viaNode.data.target]).toEqual(['sn', 'en'])

      const [viaIdentity] = transformNeo4jToCytoscape([], [rel({ start: 5, end: 6 })])
      expect([viaIdentity.data.source, viaIdentity.data.target]).toEqual(['5', '6'])
    })

    it('renders SNAKE_CASE types as Title Case labels and kebab classes', () => {
      const [edge] = transformNeo4jToCytoscape([], [rel({ type: 'WORKS_AT' })])
      expect(edge.data.label).toBe('Works At')
      expect(edge.data.type).toBe('WORKS_AT')
      expect(edge.classes).toBe('rel-works-at')
    })

    it('uses the relationship elementId as the edge id when present', () => {
      const [edge] = transformNeo4jToCytoscape([], [rel({ identity: 10, elementId: '5:abc:10' })])
      expect(edge.data.id).toBe('5:abc:10')
      expect(edge.data.neo4jId).toBe(10)
    })
  })
})

describe('parseNeo4jResults', () => {
  const alice = node({ identity: 1, properties: { name: 'Alice' } })
  const bob = node({ identity: 2, properties: { name: 'Bob' } })

  it('passes through a response that is already nodes + relationships', () => {
    const shaped = { nodes: [alice], relationships: [rel()] }
    expect(parseNeo4jResults(shaped)).toBe(shaped)
  })

  it('extracts nodes and relationships out of a records array', () => {
    const result = parseNeo4jResults({ records: [{ n: alice, r: rel(), m: bob }] })
    expect(result.nodes?.map((n) => n.identity)).toEqual([1, 2])
    expect(result.relationships).toHaveLength(1)
  })

  it('accepts a bare array of records', () => {
    const result = parseNeo4jResults([{ n: alice }])
    expect(result.nodes).toHaveLength(1)
    expect(result.relationships).toEqual([])
  })

  it('unwraps driver Record objects via toObject()', () => {
    const record = {
      keys: () => ['n'],
      toObject: () => ({ n: alice }),
    }
    const result = parseNeo4jResults({ records: [record] })
    expect(result.nodes?.map((n) => n.identity)).toEqual([1])
  })

  it('reads array-shaped records positionally', () => {
    const result = parseNeo4jResults({ records: [[alice, rel()]] })
    expect(result.nodes).toHaveLength(1)
    expect(result.relationships).toHaveLength(1)
  })

  it('deduplicates nodes that appear in several records', () => {
    const result = parseNeo4jResults({ records: [{ n: alice }, { n: { ...alice } }] })
    expect(result.nodes).toHaveLength(1)
  })

  it('keys nodes by elementId when they carry one', () => {
    const a = node({ identity: 1, elementId: '4:abc:1' })
    const b = node({ identity: 1, elementId: '4:abc:2' })
    const result = parseNeo4jResults({ records: [{ a, b }] })
    expect(result.nodes).toHaveLength(2)
  })

  it('ignores scalar values that are neither node, relationship nor path', () => {
    const result = parseNeo4jResults({ records: [{ count: 3, name: 'x', nothing: null }] })
    expect(result).toEqual({ nodes: [], relationships: [] })
  })

  it('walks a path, collecting its endpoints and every segment', () => {
    const carol = node({ identity: 3, properties: { name: 'Carol' } })
    const path = {
      start: alice,
      end: carol,
      segments: [
        { start: alice, end: bob, relationship: rel({ identity: 10, start: 1, end: 2 }) },
        { start: bob, end: carol, relationship: rel({ identity: 11, start: 2, end: 3 }) },
      ],
    }
    const result = parseNeo4jResults({ records: [{ p: path }] })
    expect(result.nodes?.map((n) => n.identity).sort()).toEqual([1, 2, 3])
    expect(result.relationships?.map((r) => r.identity)).toEqual([10, 11])
  })

  it('tolerates a path with no segments and no endpoints', () => {
    const result = parseNeo4jResults({ records: [{ p: { segments: undefined, start: alice } }] })
    // `segments: undefined` is not a path, so nothing is extracted.
    expect(result).toEqual({ nodes: [], relationships: [] })
  })

  it('skips path segments that are missing their pieces', () => {
    const path = { segments: [{ start: undefined, end: undefined, relationship: undefined }] }
    const result = parseNeo4jResults({ records: [{ p: path }] })
    expect(result).toEqual({ nodes: [], relationships: [] })
  })

  it('returns an empty graph for unrecognised responses', () => {
    expect(parseNeo4jResults(null)).toEqual({ nodes: [], relationships: [] })
    expect(parseNeo4jResults({ something: 'else' })).toEqual({ nodes: [], relationships: [] })
    expect(parseNeo4jResults('a string')).toEqual({ nodes: [], relationships: [] })
  })

  it('handles an empty records array without touching the first-record logging path', () => {
    expect(parseNeo4jResults({ records: [] })).toEqual({ nodes: [], relationships: [] })
  })
})

describe('createSampleGraph', () => {
  it('produces a connected demo graph whose edges point at real nodes', () => {
    const elements = createSampleGraph()
    const nodeIds = new Set(elements.filter((e) => !e.data.source).map((e) => e.data.id))
    const edges = elements.filter((e) => e.data.source)
    expect(nodeIds.size).toBe(3)
    expect(edges).toHaveLength(3)
    for (const edge of edges) {
      expect(nodeIds.has(edge.data.source as string)).toBe(true)
      expect(nodeIds.has(edge.data.target as string)).toBe(true)
    }
  })

  it('is renderable by the same consumer as a transformed graph (unique ids)', () => {
    const ids = createSampleGraph().map((e) => e.data.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

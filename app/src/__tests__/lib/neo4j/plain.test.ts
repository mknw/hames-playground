/**
 * Tests for `toPlainNeo4jValue` — the projection that makes driver values
 * survive the `'use server'` RPC boundary (#237 follow-up).
 *
 * These build *real* neo4j-driver instances (`neo4j.types.Node`, `neo4j.int`,
 * …) rather than plain look-alikes, because the bug is precisely about the
 * prototype: seroval, the serializer SolidStart uses for server-function
 * results, refuses a class instance it does not know and aborts the response
 * stream mid-flight — which the browser reports as
 * `Malformed server function stream header`.
 *
 * So the suite pins the projection twice: structurally (nothing in the output
 * has a prototype other than Object/Array) and against seroval itself.
 */

import { describe, it, expect } from 'vitest'
import neo4j from 'neo4j-driver'
import { serializeAsync, deserialize } from 'seroval'
import { toPlainNeo4jValue, CIRCULAR_PLACEHOLDER } from '../../../lib/neo4j/plain'

const node = (id: number, labels: string[], properties: Record<string, unknown>) =>
  new neo4j.types.Node(neo4j.int(id), labels, properties, `4:db:${id}`)

const relationship = (id: number, type: string, start: number, end: number) =>
  new neo4j.types.Relationship(
    neo4j.int(id),
    neo4j.int(start),
    neo4j.int(end),
    type,
    { since: neo4j.int(2020) },
    `5:db:${id}`,
    `4:db:${start}`,
    `4:db:${end}`,
  )

/** Every object reachable in `value` is a bare object or array — the property
 *  seroval needs, asserted without seroval so a nested miss is located. */
const assertPlain = (value: unknown, path = '$'): void => {
  if (value === null || typeof value !== 'object') return
  const proto = Object.getPrototypeOf(value)
  expect(
    proto === Object.prototype || proto === Array.prototype,
    `${path} is a ${value.constructor?.name ?? 'non-plain object'}`,
  ).toBe(true)
  for (const [key, entry] of Object.entries(value)) assertPlain(entry, `${path}.${key}`)
}

describe('toPlainNeo4jValue — scalars', () => {
  it('passes primitives through untouched', () => {
    expect(toPlainNeo4jValue('x')).toBe('x')
    expect(toPlainNeo4jValue(4)).toBe(4)
    expect(toPlainNeo4jValue(false)).toBe(false)
    expect(toPlainNeo4jValue(null)).toBe(null)
    expect(toPlainNeo4jValue(undefined)).toBe(undefined)
  })

  it('unwraps an Integer inside the safe range to a number', () => {
    expect(toPlainNeo4jValue(neo4j.int(42))).toBe(42)
    expect(toPlainNeo4jValue(neo4j.int(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('renders an int64 past 2^53 as a decimal string rather than rounding it', () => {
    // toNumber() here would silently lose the last digits, which is worse than
    // handing the UI a string it can display verbatim.
    expect(toPlainNeo4jValue(neo4j.int('9007199254740993'))).toBe('9007199254740993')
    expect(toPlainNeo4jValue(neo4j.int('-9007199254740993'))).toBe('-9007199254740993')
  })

  it('applies the same rule to a native bigint', () => {
    expect(toPlainNeo4jValue(7n)).toBe(7)
    expect(toPlainNeo4jValue(9007199254740993n)).toBe('9007199254740993')
  })

  it('stringifies the temporal types', () => {
    expect(toPlainNeo4jValue(new neo4j.types.Date(2026, 8, 24))).toBe('2026-08-24')
    expect(toPlainNeo4jValue(new neo4j.types.Duration(0, 1, 0, 0))).toBe('P1DT')
    expect(typeof toPlainNeo4jValue(new neo4j.types.LocalTime(12, 30, 0, 0))).toBe('string')
  })

  it('breaks a Point into its components', () => {
    expect(toPlainNeo4jValue(new neo4j.types.Point(neo4j.int(7203), 1.5, 2.5))).toEqual({
      srid: 7203,
      x: 1.5,
      y: 2.5,
      z: undefined,
    })
  })
})

describe('toPlainNeo4jValue — graph entities', () => {
  it('projects a Node onto the fields the Cytoscape transform reads', () => {
    const plain = toPlainNeo4jValue(node(1, ['Person'], { name: 'Alice', age: neo4j.int(30) }))

    expect(plain).toEqual({
      elementId: '4:db:1',
      identity: 1,
      labels: ['Person'],
      properties: { name: 'Alice', age: 30 },
    })
    assertPlain(plain)
  })

  it('projects a Relationship with both endpoints', () => {
    expect(toPlainNeo4jValue(relationship(9, 'KNOWS', 1, 2))).toEqual({
      elementId: '5:db:9',
      identity: 9,
      type: 'KNOWS',
      start: 1,
      end: 2,
      startNodeElementId: '4:db:1',
      endNodeElementId: '4:db:2',
      properties: { since: 2020 },
    })
  })

  it('projects an UnboundRelationship', () => {
    const unbound = new neo4j.types.UnboundRelationship(
      neo4j.int(9),
      'KNOWS',
      { weight: neo4j.int(3) },
      '5:db:9',
    )
    expect(toPlainNeo4jValue(unbound)).toEqual({
      elementId: '5:db:9',
      identity: 9,
      type: 'KNOWS',
      properties: { weight: 3 },
    })
  })

  it('projects a Path into plain segments', () => {
    const alice = node(1, ['Person'], { name: 'Alice' })
    const bob = node(2, ['Person'], { name: 'Bob' })
    const segment = new neo4j.types.PathSegment(alice, relationship(9, 'KNOWS', 1, 2), bob)
    const path = new neo4j.types.Path(alice, bob, [segment])

    const plain = toPlainNeo4jValue(path) as Record<string, unknown>

    expect(plain.length).toBe(1)
    expect((plain.start as Record<string, unknown>).properties).toEqual({ name: 'Alice' })
    expect(plain.segments).toEqual([
      {
        start: expect.objectContaining({ identity: 1 }),
        relationship: expect.objectContaining({ type: 'KNOWS' }),
        end: expect.objectContaining({ identity: 2 }),
      },
    ])
    assertPlain(plain)
  })

  it('recurses through list and map properties', () => {
    const plain = toPlainNeo4jValue(
      node(1, ['Dataset'], {
        counts: [neo4j.int(1), neo4j.int(2)],
        nested: { deep: { at: new neo4j.types.Date(2026, 1, 2) } },
      }),
    ) as { properties: Record<string, unknown> }

    expect(plain.properties.counts).toEqual([1, 2])
    expect(plain.properties.nested).toEqual({ deep: { at: '2026-01-02' } })
    assertPlain(plain)
  })
})

describe('toPlainNeo4jValue — hostile shapes', () => {
  it('replaces a reference that points back into its own ancestry', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic

    expect(toPlainNeo4jValue(cyclic)).toEqual({ name: 'root', self: CIRCULAR_PLACEHOLDER })
  })

  it('keeps a shared (non-cyclic) reference on both branches', () => {
    // The cycle guard tracks the current path only, so a value appearing twice
    // as a sibling must still be emitted twice.
    const shared = { id: 1 }
    expect(toPlainNeo4jValue({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } })
  })

  it('degrades an unanticipated class instance to its own enumerable properties', () => {
    class Surprise {
      kept = neo4j.int(5)
      method() {
        return 'never serialized'
      }
    }
    const plain = toPlainNeo4jValue(new Surprise())
    expect(plain).toEqual({ kept: 5 })
    assertPlain(plain)
  })
})

describe('the RPC serializer accepts the projection (#237 follow-up)', () => {
  const rows = [
    {
      n: node(1, ['Person'], { name: 'Alice', age: neo4j.int(30) }),
      r: relationship(9, 'KNOWS', 1, 2),
      count: neo4j.int(2),
    },
  ]

  it('refuses the driver values themselves — the bug this projection fixes', async () => {
    // seroval is what SolidStart runs over a `'use server'` return value. It
    // throws *after* the response headers are out, so the browser reports
    // `Malformed server function stream header` rather than an error envelope.
    await expect(serializeAsync({ success: true, raw: rows })).rejects.toThrow(
      /cannot be parsed\/serialized/,
    )
  })

  it('round-trips a node-returning row through seroval unchanged', async () => {
    const projected = toPlainNeo4jValue(rows) as unknown[]

    const roundTripped = deserialize(await serializeAsync({ success: true, raw: projected }))

    expect(roundTripped).toEqual({ success: true, raw: projected })
    assertPlain(projected)
  })
})

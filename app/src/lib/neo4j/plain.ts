/**
 * Plain projections of neo4j-driver values.
 *
 * Everything the driver hands back is a class instance — `Node`, `Relationship`,
 * `Path`, `Integer`, the temporal types — and SolidStart serialises a
 * `'use server'` return value with seroval, which refuses any object whose
 * prototype it does not know:
 *
 *   SerovalUnsupportedTypeError: The value [object Object] of type "object"
 *   cannot be parsed/serialized.
 *
 * That throw lands *after* the response headers are on the wire, so the browser
 * never sees an error envelope — it sees a truncated stream and reports
 * `Malformed server function stream header`. Which is why a query returning
 * scalars worked while `MATCH (n) RETURN n LIMIT 5` did not (#237 follow-up).
 *
 * `toPlainNeo4jValue` walks a driver value into arrays, plain objects and
 * primitives. The unknown-object fallback is deliberate: a driver type nobody
 * anticipated degrades to its own enumerable properties instead of killing the
 * response.
 */

import neo4j, { type Integer } from 'neo4j-driver'

/** Stands in for a reference that points back into its own ancestry. */
export const CIRCULAR_PLACEHOLDER = '[Circular]'

/**
 * Project a neo4j-driver value into something seroval (and `JSON.stringify`)
 * can encode.
 *
 * - `Integer`/`bigint` → a `number` when it fits exactly, otherwise a decimal
 *   string. Silently rounding an int64 past 2^53 would be worse than a string.
 * - `Node` → `{ elementId, identity, labels, properties }`, `Relationship` →
 *   the same plus `type` and its endpoints, `Path` → `{ start, end, segments }`.
 *   These keep the field names `graph/transform.ts` duck-types on, so the
 *   Cytoscape projection is built from the plain form too.
 * - temporal types and points → their `toString()` / component form.
 * - anything else object-shaped → its own enumerable keys, recursively.
 */
export function toPlainNeo4jValue(value: unknown): unknown {
  return project(value, new Set())
}

function project(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return fromBigInt(value)
  if (typeof value !== 'object') return value

  if (neo4j.isInt(value)) return fromInteger(value)

  if (
    neo4j.isDate(value) ||
    neo4j.isDateTime(value) ||
    neo4j.isLocalDateTime(value) ||
    neo4j.isTime(value) ||
    neo4j.isLocalTime(value) ||
    neo4j.isDuration(value)
  ) {
    return String(value)
  }

  // A reference already open further up the walk: emitting it again would
  // recurse forever. Siblings that merely share a reference are unaffected —
  // `ancestors` only holds the current path (see the `delete` below).
  if (ancestors.has(value)) return CIRCULAR_PLACEHOLDER
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => project(item, ancestors))

    if (neo4j.isPoint(value)) {
      return {
        srid: project(value.srid, ancestors),
        x: value.x,
        y: value.y,
        z: value.z,
      }
    }

    if (neo4j.isNode(value)) {
      return {
        elementId: value.elementId,
        identity: project(value.identity, ancestors),
        labels: [...value.labels],
        properties: projectProperties(value.properties, ancestors),
      }
    }

    if (neo4j.isRelationship(value)) {
      return {
        elementId: value.elementId,
        identity: project(value.identity, ancestors),
        type: value.type,
        start: project(value.start, ancestors),
        end: project(value.end, ancestors),
        startNodeElementId: value.startNodeElementId,
        endNodeElementId: value.endNodeElementId,
        properties: projectProperties(value.properties, ancestors),
      }
    }

    if (neo4j.isUnboundRelationship(value)) {
      return {
        elementId: value.elementId,
        identity: project(value.identity, ancestors),
        type: value.type,
        properties: projectProperties(value.properties, ancestors),
      }
    }

    if (neo4j.isPathSegment(value)) {
      return {
        start: project(value.start, ancestors),
        relationship: project(value.relationship, ancestors),
        end: project(value.end, ancestors),
      }
    }

    if (neo4j.isPath(value)) {
      return {
        start: project(value.start, ancestors),
        end: project(value.end, ancestors),
        length: value.length,
        segments: value.segments.map((segment) => project(segment, ancestors)),
      }
    }

    return projectProperties(value as Record<string, unknown>, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function projectProperties(
  properties: Record<string, unknown> | undefined,
  ancestors: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(properties ?? {})) {
    out[key] = project(entry, ancestors)
  }
  return out
}

function fromInteger(value: Integer): number | string {
  return value.inSafeRange() ? value.toNumber() : value.toString()
}

function fromBigInt(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString()
}

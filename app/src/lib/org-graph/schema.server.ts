/**
 * Org-graph schema setup — Server Only.
 *
 * Two functions with deliberately unequal ergonomics:
 *
 *  - {@link ensureOrgGraphSchema} applies the ontology's constraints and is
 *    safe to run on every boot. It **never** deletes anything. Every statement
 *    is `IF NOT EXISTS`, so a second run is a no-op.
 *  - {@link wipeAndApplyOrgGraphSchema} clears the graph first. It is the
 *    one-shot migration authorised for the switch to an organisational-only
 *    graph and nothing else, so it refuses to run unless the caller passes the
 *    literal confirmation phrase. There is no flag, env var or default that
 *    turns the wipe on: making it a required *argument* is what stops it from
 *    ever becoming a side effect of ordinary setup.
 *
 * ## Not a `'use server'` module, deliberately
 * Every export of a `'use server'` file is an RPC the browser can call, and a
 * function that drops the graph must not be reachable that way at any privilege
 * level (SD-13's rule, and `neo4j/queries.ts`'s closing comment on #228/#230
 * is the precedent). These are `.server.ts` + `assertServerOnImport()` and are
 * invoked from the CLI scripts under `scripts/` — or, later, from a routine.
 * If a UI ever needs the setup path, it gets an intent-shaped, authenticated
 * `'use server'` wrapper of its own around {@link ensureOrgGraphSchema} only.
 *
 * Mirrors the Postgres house pattern (`auth/session-store.server.ts`): schema
 * is bootstrapped idempotently on first use, memoized per process, and the
 * memo is cleared on failure so the next call retries.
 */
import neo4j from 'neo4j-driver'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getNeo4jDriver } from '../neo4j/client'
import {
  CONSTRAINT_NAMES,
  CONSTRAINT_STATEMENTS,
  NON_CONFORMING_CYPHER,
  conformanceParams,
} from './ontology'

assertServerOnImport()

/**
 * The phrase {@link wipeAndApplyOrgGraphSchema} requires. Spelled out rather
 * than a boolean so it cannot be reached by a stray truthy value, and so the
 * call site reads as a decision at the point of the call.
 */
export const WIPE_CONFIRMATION = 'WIPE-AND-REBUILD-ORG-GRAPH' as const

export interface SchemaReport {
  /** Constraint names present after the run — should equal `CONSTRAINT_NAMES`. */
  constraints: string[]
  /** Constraints found that this ontology does not declare. */
  leftoverConstraints: string[]
  /** Nodes deleted; 0 unless the wipe ran. */
  nodesDeleted: number
  /** Constraints dropped; 0 unless the wipe ran. */
  constraintsDropped: number
}

let _schemaReady: Promise<void> | null = null

/**
 * Apply the ontology's constraints, once per process.
 *
 * Read the guarantee narrowly: this creates constraints and never removes
 * data. If pre-ontology nodes are present, the constraints still apply — a
 * uniqueness constraint on `Member.entraId` says nothing about a `Concept`
 * node — so a partial graph is left alone rather than being "cleaned up"
 * behind the caller's back. Use {@link countNonConforming} to see what is
 * there.
 *
 * Throws if a constraint cannot be created. That is the intended failure
 * policy: a fail-open schema apply would leave the ingest writing into a graph
 * with no identity guarantee, and the identity guarantee is the only part of
 * this ontology the database enforces at all.
 */
export function ensureOrgGraphSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = applyConstraints().catch((err) => {
      _schemaReady = null // allow retry on next call
      throw err
    })
  }
  return _schemaReady
}

async function applyConstraints(): Promise<void> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    // Sequentially, not Promise.all: Neo4j serialises schema changes anyway and
    // a parallel apply turns one clear failure into an unordered pile of them.
    for (const statement of CONSTRAINT_STATEMENTS) {
      await session.run(statement)
    }
  } finally {
    await session.close()
  }
}

/** Constraint names currently defined in the database. */
export async function listConstraintNames(): Promise<string[]> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run('SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name')
    return result.records.map((r) => String(r.get('name')))
  } finally {
    await session.close()
  }
}

/**
 * Where the graph does not conform to the ontology, by count. Never throws on
 * non-conformance — reporting is the point; the caller decides what a non-zero
 * count means.
 */
export async function countNonConforming(): Promise<
  { kind: string; detail: string[]; count: number }[]
> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(NON_CONFORMING_CYPHER, conformanceParams())
    return result.records.map((r) => ({
      kind: String(r.get('kind')),
      detail: (r.get('detail') as string[]) ?? [],
      count: toCount(r.get('count')),
    }))
  } finally {
    await session.close()
  }
}

/**
 * Clear the graph and apply the ontology. **Authorised once**, for the
 * migration to an organisational-only graph (owner decision, 2026-08-25).
 *
 * @param confirmation must equal {@link WIPE_CONFIRMATION}; anything else
 *        throws before a session is opened.
 *
 * What it deletes: every node and relationship, and every constraint — the
 * pre-ontology constraints (`class_iri`, `change_id`, …) belong to labels that
 * cease to exist, and leaving them behind would make `SHOW CONSTRAINTS`
 * unreadable against {@link CONSTRAINT_NAMES}. Indexes owned by a dropped
 * constraint go with it.
 *
 * `DETACH DELETE` is issued in batches so a large graph does not build one
 * transaction the size of the store.
 */
export async function wipeAndApplyOrgGraphSchema(confirmation: string): Promise<SchemaReport> {
  if (confirmation !== WIPE_CONFIRMATION) {
    throw new Error(
      `[org-graph] refusing to wipe: pass the literal confirmation ${JSON.stringify(
        WIPE_CONFIRMATION,
      )}. The ordinary setup path is ensureOrgGraphSchema(), which never deletes.`,
    )
  }

  const constraintsDropped = await dropAllConstraints()
  const nodesDeleted = await deleteAllNodes()

  // Reset the memo: this process may have applied constraints that were just
  // dropped, and a memoized "ready" would skip re-creating them.
  _schemaReady = null
  await ensureOrgGraphSchema()

  const constraints = await listConstraintNames()
  return {
    constraints,
    leftoverConstraints: constraints.filter((n) => !CONSTRAINT_NAMES.includes(n)),
    nodesDeleted,
    constraintsDropped,
  }
}

async function dropAllConstraints(): Promise<number> {
  const existing = await listConstraintNames()
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    for (const name of existing) {
      // The name comes from SHOW CONSTRAINTS, not from a caller, and cannot be
      // a Cypher parameter (it is an identifier) — backtick-quoted, and any
      // backtick in it is doubled per Cypher's own escaping rule.
      await session.run(`DROP CONSTRAINT \`${name.replace(/`/g, '``')}\` IF EXISTS`)
    }
    return existing.length
  } finally {
    await session.close()
  }
}

/** Batch size for the wipe. Large enough to be one transaction on a laptop
 *  graph, small enough that a big one does not exhaust the heap. */
const WIPE_BATCH = 10_000

async function deleteAllNodes(): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  let total = 0
  try {
    for (;;) {
      const result = await session.run(
        `MATCH (n) WITH n LIMIT $batch DETACH DELETE n RETURN count(*) AS deleted`,
        { batch: neo4j.int(WIPE_BATCH) },
      )
      const deleted = toCount(result.records[0]?.get('deleted'))
      total += deleted
      if (deleted === 0) return total
    }
  } finally {
    await session.close()
  }
}

/** `count(*)` comes back as a driver `Integer`; a graph never has more nodes
 *  than `Number.MAX_SAFE_INTEGER`, so the narrowing is safe here. */
function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (neo4j.isInt(value)) return value.toNumber()
  return Number(value ?? 0)
}

/**
 * The setup path's two guarantees, pinned against a driver double.
 *
 *  1. `ensureOrgGraphSchema` NEVER deletes. Not "does not today" — the
 *     assertion below reads every statement it issues and fails on a write
 *     clause, so a future addition cannot smuggle a cleanup in.
 *  2. The wipe is unreachable without the literal confirmation phrase, and the
 *     refusal happens before a session is opened.
 *
 * The wipe is authorised once, for one migration. Everything that makes that
 * true is here rather than in prose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

/** Rows a queued `session.run` answer produces. */
type Row = Record<string, unknown>

const queue: Row[][] = []
const sessionRun = vi.fn(async (..._args: unknown[]) => ({
  records: (queue.shift() ?? []).map((row) => ({ get: (k: string) => row[k] })),
}))
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn((_opts?: unknown) => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const mod = () => import('../../../lib/org-graph/schema.server')

const statements = (): string[] => sessionRun.mock.calls.map((c) => String(c[0]))

beforeEach(async () => {
  vi.clearAllMocks()
  queue.length = 0
  vi.resetModules()
})

describe('ensureOrgGraphSchema', () => {
  it('applies every declared constraint', async () => {
    const { ensureOrgGraphSchema } = await mod()
    const { CONSTRAINT_STATEMENTS } = await import('../../../lib/org-graph/ontology')

    await ensureOrgGraphSchema()

    expect(statements()).toEqual([...CONSTRAINT_STATEMENTS])
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('never issues a write clause other than CREATE CONSTRAINT', async () => {
    // The guarantee in one assertion: this path may create schema and may not
    // touch data. A cleanup added here in future fails the test rather than
    // deleting a graph.
    const { ensureOrgGraphSchema } = await mod()
    await ensureOrgGraphSchema()

    for (const statement of statements()) {
      expect(statement).toMatch(/^CREATE CONSTRAINT /)
      expect(statement).not.toMatch(/\b(DELETE|DETACH|REMOVE|DROP|MERGE|SET)\b/i)
    }
  })

  it('is idempotent within a process — the second call runs nothing', async () => {
    const { ensureOrgGraphSchema } = await mod()
    await ensureOrgGraphSchema()
    const first = sessionRun.mock.calls.length
    await ensureOrgGraphSchema()
    expect(sessionRun.mock.calls.length).toBe(first)
  })

  it('retries after a failure instead of caching it', async () => {
    // A memoized rejection would make one transient Neo4j hiccup permanent for
    // the life of the process (the house pattern in session-store.server.ts).
    const { ensureOrgGraphSchema } = await mod()
    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))

    await expect(ensureOrgGraphSchema()).rejects.toThrow('neo4j down')
    await expect(ensureOrgGraphSchema()).resolves.toBeUndefined()
  })

  it('closes the session even when a statement throws', async () => {
    const { ensureOrgGraphSchema } = await mod()
    sessionRun.mockRejectedValueOnce(new Error('boom'))
    await expect(ensureOrgGraphSchema()).rejects.toThrow('boom')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('wipeAndApplyOrgGraphSchema', () => {
  it('refuses without the exact confirmation phrase, before opening a session', async () => {
    const { wipeAndApplyOrgGraphSchema, WIPE_CONFIRMATION } = await mod()

    for (const wrong of [
      '',
      'yes',
      'true',
      WIPE_CONFIRMATION.toLowerCase(),
      ' ' + WIPE_CONFIRMATION,
    ]) {
      await expect(wipeAndApplyOrgGraphSchema(wrong)).rejects.toThrow(/refusing to wipe/)
    }
    expect(driverSession).not.toHaveBeenCalled()
  })

  it('drops constraints, deletes in batches until empty, then re-applies', async () => {
    const { wipeAndApplyOrgGraphSchema, WIPE_CONFIRMATION } = await mod()
    const { CONSTRAINT_NAMES } = await import('../../../lib/org-graph/ontology')

    queue.push([{ name: 'class_iri' }, { name: 'change_id' }]) // SHOW CONSTRAINTS
    queue.push([]) // DROP class_iri
    queue.push([]) // DROP change_id
    queue.push([{ deleted: 7 }]) // first delete batch
    queue.push([{ deleted: 0 }]) // drained
    for (const _ of CONSTRAINT_NAMES) queue.push([]) // constraint applies
    queue.push(CONSTRAINT_NAMES.map((name) => ({ name }))) // SHOW CONSTRAINTS again

    const report = await wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION)

    expect(report.constraintsDropped).toBe(2)
    expect(report.nodesDeleted).toBe(7)
    expect(report.leftoverConstraints).toEqual([])
    expect(report.constraints).toEqual([...CONSTRAINT_NAMES])

    const issued = statements()
    expect(issued).toContain('DROP CONSTRAINT `class_iri` IF EXISTS')
    expect(issued.filter((s) => s.includes('DETACH DELETE'))).toHaveLength(2)
  })

  it('re-applies constraints even when this process already applied them', async () => {
    // The memo would otherwise skip the re-create after the drop, leaving the
    // graph with no uniqueness guarantee and the report claiming success.
    const { ensureOrgGraphSchema, wipeAndApplyOrgGraphSchema, WIPE_CONFIRMATION } = await mod()
    const { CONSTRAINT_STATEMENTS } = await import('../../../lib/org-graph/ontology')

    await ensureOrgGraphSchema()
    sessionRun.mockClear()

    queue.push([]) // SHOW CONSTRAINTS → none
    queue.push([{ deleted: 0 }]) // nothing to delete
    for (const _ of CONSTRAINT_STATEMENTS) queue.push([])
    queue.push([])

    await wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION)

    const applied = statements().filter((s) => s.startsWith('CREATE CONSTRAINT'))
    expect(applied).toEqual([...CONSTRAINT_STATEMENTS])
  })

  it('reports a constraint the ontology does not declare as a leftover', async () => {
    const { wipeAndApplyOrgGraphSchema, WIPE_CONFIRMATION } = await mod()
    const { CONSTRAINT_NAMES } = await import('../../../lib/org-graph/ontology')

    queue.push([]) // SHOW CONSTRAINTS → none to drop
    queue.push([{ deleted: 0 }])
    for (const _ of CONSTRAINT_NAMES) queue.push([])
    queue.push([...CONSTRAINT_NAMES.map((name) => ({ name })), { name: 'stray_thing' }])

    const report = await wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION)
    expect(report.leftoverConstraints).toEqual(['stray_thing'])
  })

  it('escapes a backtick in a constraint name rather than breaking the quoting', async () => {
    const { wipeAndApplyOrgGraphSchema, WIPE_CONFIRMATION } = await mod()
    const { CONSTRAINT_NAMES } = await import('../../../lib/org-graph/ontology')

    queue.push([{ name: 'we`ird' }])
    queue.push([])
    queue.push([{ deleted: 0 }])
    for (const _ of CONSTRAINT_NAMES) queue.push([])
    queue.push([])

    await wipeAndApplyOrgGraphSchema(WIPE_CONFIRMATION)
    expect(statements()).toContain('DROP CONSTRAINT `we``ird` IF EXISTS')
  })
})

describe('countNonConforming', () => {
  it('returns the drift rows and never throws on non-conformance', async () => {
    const { countNonConforming } = await mod()
    queue.push([
      { kind: 'node_label', detail: ['Concept'], count: 51 },
      { kind: 'relation_type', detail: ['CAN_BE'], count: 14 },
    ])

    await expect(countNonConforming()).resolves.toEqual([
      { kind: 'node_label', detail: ['Concept'], count: 51 },
      { kind: 'relation_type', detail: ['CAN_BE'], count: 14 },
    ])
  })

  it('opens its session in READ mode', async () => {
    const { countNonConforming } = await mod()
    queue.push([])
    await countNonConforming()
    expect(driverSession).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAccessMode: 'READ' }),
    )
  })
})

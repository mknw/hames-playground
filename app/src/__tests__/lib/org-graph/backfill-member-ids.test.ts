/**
 * The one-off Member id backfill (`scripts/backfill-member-ids.ts`),
 * hermetically: what it sends, in which order, and what it refuses. The
 * behaviour against a real database is `backfill-member-ids-neo4j.test.ts`
 * (disposable only).
 *
 * Mutations that redden it: drop `WHERE m.id IS NULL` (ids are overwritten);
 * add a DELETE / REMOVE / MERGE / CREATE to the backfill; move the constraint
 * inside the transaction or before the backfill; apply the constraint without
 * re-reading the missing count; drop the after-count refusal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Driver } from 'neo4j-driver'
import {
  BACKFILL_MEMBER_IDS_CYPHER,
  BackfillRefused,
  LEGACY_KNOWLEDGE_CYPHER,
  dryRunMemberIds,
  MEMBER_ID_CONSTRAINT,
  MEMBER_ID_COUNTS_CYPHER,
  backfillMemberIds,
} from '../../../lib/org-graph/scripts/backfill-member-ids'
import {
  MEMBERS_WITHOUT_ID_CYPHER,
  MEMBER_ID_CONSTRAINT_STATEMENT,
} from '../../../lib/org-graph/ontology'

type Row = Record<string, unknown>
const answer = (rows: Row[]) => ({ records: rows.map((row) => ({ get: (k: string) => row[k] })) })

/**
 * A driver with one write transaction. `tx` answers the two counts and the
 * backfill; `auto` answers the statements run outside it, in order.
 */
function fakeDriver(opts: {
  before: Row
  assigned: number
  after: Row
  missingAfterCommit?: Row[]
  shown?: Row[]
}) {
  const log: string[] = []
  let counts = 0
  const txRun = vi.fn(async (cypher: string) => {
    log.push(`tx:${cypher}`)
    if (cypher === MEMBER_ID_COUNTS_CYPHER)
      return answer([counts++ === 0 ? opts.before : opts.after])
    if (cypher === BACKFILL_MEMBER_IDS_CYPHER) return answer([{ assigned: opts.assigned }])
    throw new Error(`unexpected tx statement: ${cypher}`)
  })
  const autoRun = vi.fn(async (cypher: string) => {
    log.push(`auto:${cypher}`)
    if (cypher === MEMBERS_WITHOUT_ID_CYPHER)
      return answer(opts.missingAfterCommit ?? [{ missing: 0 }])
    if (cypher === MEMBER_ID_CONSTRAINT_STATEMENT) return answer([])
    if (cypher.startsWith('SHOW CONSTRAINTS'))
      return answer(opts.shown ?? [{ name: MEMBER_ID_CONSTRAINT }])
    throw new Error(`unexpected statement: ${cypher}`)
  })
  const executeWrite = vi.fn(async (work: (tx: unknown) => unknown) => work({ run: txRun }))
  const close = vi.fn(async () => undefined)
  const driver = {
    session: () => ({ executeWrite, run: autoRun, close }),
  } as unknown as Driver
  return { driver, log, executeWrite, close }
}

describe('backfill-member-ids', () => {
  it('sets an id only where none is, and never deletes, merges or creates', () => {
    const backfill = BACKFILL_MEMBER_IDS_CYPHER.replace(/\s+/g, ' ').trim()
    expect(backfill).toBe(
      'MATCH (m:Member) WHERE m.id IS NULL SET m.id = coalesce(m.id, randomUUID()) RETURN count(m) AS assigned',
    )
    expect(MEMBER_ID_COUNTS_CYPHER).not.toMatch(/\b(SET|DELETE|DETACH|REMOVE|MERGE|CREATE)\b/i)
    expect(MEMBER_ID_CONSTRAINT).toBe('org_member_id')
  })

  it('counts, backfills and counts again in ONE transaction, then applies the constraint', async () => {
    const { driver, log, executeWrite, close } = fakeDriver({
      before: { members: 5, withId: 0 },
      assigned: 5,
      after: { members: 5, withId: 5 },
    })
    const report = await backfillMemberIds(driver)
    expect(report).toEqual({
      before: { members: 5, withId: 0 },
      assigned: 5,
      after: { members: 5, withId: 5 },
      constraint: true,
    })
    expect(executeWrite).toHaveBeenCalledTimes(1)
    expect(log).toEqual([
      `tx:${MEMBER_ID_COUNTS_CYPHER}`,
      `tx:${BACKFILL_MEMBER_IDS_CYPHER}`,
      `tx:${MEMBER_ID_COUNTS_CYPHER}`,
      `auto:${MEMBERS_WITHOUT_ID_CYPHER}`,
      `auto:${MEMBER_ID_CONSTRAINT_STATEMENT}`,
      'auto:SHOW CONSTRAINTS YIELD name WHERE name = $name RETURN name',
    ])
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('is a no-op on a second run: assigns 0 and still reports the constraint', async () => {
    const { driver } = fakeDriver({
      before: { members: 5, withId: 5 },
      assigned: 0,
      after: { members: 5, withId: 5 },
    })
    expect(await backfillMemberIds(driver)).toMatchObject({ assigned: 0, constraint: true })
  })

  it('refuses to commit while a member would still lack an id, and applies no constraint', async () => {
    const { driver, log, close } = fakeDriver({
      before: { members: 5, withId: 0 },
      assigned: 4,
      after: { members: 5, withId: 4 },
    })
    await expect(backfillMemberIds(driver)).rejects.toThrow(BackfillRefused)
    expect(log.some((l) => l.includes('CREATE CONSTRAINT'))).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('defers the constraint when a member arrived without an id after the commit', async () => {
    const { driver, log } = fakeDriver({
      before: { members: 2, withId: 0 },
      assigned: 2,
      after: { members: 2, withId: 2 },
      missingAfterCommit: [{ missing: 1 }],
      shown: [],
    })
    expect(await backfillMemberIds(driver)).toMatchObject({ assigned: 2, constraint: false })
    expect(log.some((l) => l.includes('CREATE CONSTRAINT'))).toBe(false)
  })
})

// Review of #988, terms 3 and 4: a read-only dry run that also counts pre-v2
// Knowledge nodes. Mutations: open the session in WRITE mode, or run it through
// executeWrite → red; report 0 when the legacy count returns no row → red.
describe('backfill-member-ids --dry-run', () => {
  function readDriver(legacy: Row[] = [{ legacy: 2 }], shown: Row[] = []) {
    const modes: unknown[] = []
    const log: string[] = []
    const run = vi.fn(async (cypher: string) => {
      log.push(cypher)
      if (cypher === MEMBER_ID_COUNTS_CYPHER) return answer([{ members: 5, withId: 1 }])
      if (cypher === LEGACY_KNOWLEDGE_CYPHER) return answer(legacy)
      if (cypher.startsWith('SHOW CONSTRAINTS')) return answer(shown)
      throw new Error(`unexpected statement: ${cypher}`)
    })
    const executeRead = vi.fn(async (work: (tx: unknown) => unknown) => work({ run }))
    const executeWrite = vi.fn()
    const close = vi.fn(async () => undefined)
    const driver = {
      session: (opts: { defaultAccessMode?: unknown }) => {
        modes.push(opts?.defaultAccessMode)
        return { executeRead, executeWrite, run: vi.fn(), close }
      },
    } as unknown as Driver
    return { driver, modes, log, executeRead, executeWrite, close }
  }

  it('reports counts, ids it would assign, legacy Knowledge and the constraint, writing nothing', async () => {
    const { driver, modes, log, executeRead, executeWrite, close } = readDriver()
    expect(await dryRunMemberIds(driver)).toEqual({
      counts: { members: 5, withId: 1 },
      wouldAssign: 4,
      legacyKnowledge: 2,
      constraint: false,
    })
    expect(modes).toEqual(['READ'])
    expect(executeRead).toHaveBeenCalledTimes(1)
    expect(executeWrite).not.toHaveBeenCalled()
    for (const cypher of log) {
      expect(cypher).not.toMatch(/\b(SET|CREATE|MERGE|DELETE|DETACH|REMOVE|DROP)\b/i)
    }
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('counts a Knowledge node with no name as pre-v2', () => {
    expect(LEGACY_KNOWLEDGE_CYPHER.replace(/\s+/g, ' ').trim()).toBe(
      'MATCH (k:Knowledge) WHERE k.name IS NULL RETURN count(k) AS legacy',
    )
  })

  it('refuses rather than report no legacy Knowledge when the count returns no row', async () => {
    const { driver } = readDriver([])
    await expect(dryRunMemberIds(driver)).rejects.toThrow(BackfillRefused)
  })
})

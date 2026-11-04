/**
 * The local seed of the ten invented members (`scripts/seed-eval-members.ts`),
 * hermetically: what it sends, and what it can never do. The behaviour against a
 * real database is `seed-eval-members-neo4j.test.ts` (disposable only).
 *
 * Mutations that redden it: add a `DELETE` / `DETACH` / `REMOVE` clause; drop the
 * `createdBy` guard before the `SET`; merge on `mail` instead of `entraId`; seed
 * any row the fixture does not hold; drop the foreign-member refusal (or let it
 * count only members with no `createdBy`); accept a missing or mismatched
 * `--target`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Driver } from 'neo4j-driver'
import {
  EVAL_SEED_CREATED_BY,
  FOREIGN_MEMBERS_CYPHER,
  SEED_MEMBERS_CYPHER,
  SeedRefused,
  checkTarget,
  seedEvalMembers,
  seedRows,
} from '../../../lib/org-graph/scripts/seed-eval-members'
import { SYNTHETIC_MEMBERS } from '../../../lib/eval-support/synthetic-org-graph'

/** A driver whose one write transaction answers the foreign-member count, then the write. */
function fakeDriver(foreign: number, written = 10) {
  const run = vi.fn(async (cypher: string) => ({
    records: [{ get: () => (cypher === FOREIGN_MEMBERS_CYPHER ? foreign : written) }],
  }))
  const close = vi.fn(async () => undefined)
  const driver = {
    session: () => ({ executeWrite: (work: (tx: unknown) => unknown) => work({ run }), close }),
  } as unknown as Driver
  return { driver, run, close }
}

describe('seed-eval-members', () => {
  it('never deletes: no DELETE, DETACH or REMOVE clause', () => {
    expect(SEED_MEMBERS_CYPHER).not.toMatch(/\b(DELETE|DETACH|REMOVE)\b/i)
    expect(FOREIGN_MEMBERS_CYPHER).not.toMatch(/\b(DELETE|DETACH|REMOVE|SET|MERGE|CREATE)\b/i)
  })

  it('merges on the invented entraId and updates only what it created', () => {
    expect(SEED_MEMBERS_CYPHER).toMatch(/MERGE \(m:Member \{entraId: row\.entraId\}\)/)
    expect(SEED_MEMBERS_CYPHER).toMatch(
      /ON CREATE SET m\.createdBy = \$createdBy[\s\S]*WITH m, row WHERE m\.createdBy = \$createdBy\s+SET /,
    )
    expect(EVAL_SEED_CREATED_BY).toBe('eval-seed')
  })

  it('counts every member it did not write, including one with no createdBy', () => {
    expect(FOREIGN_MEMBERS_CYPHER).toMatch(
      /MATCH \(m:Member\) WHERE m\.createdBy IS NULL OR m\.createdBy <> \$createdBy/,
    )
  })

  it('seeds exactly the fixture’s ten members', () => {
    expect(seedRows()).toEqual(
      SYNTHETIC_MEMBERS.map((m) => ({
        entraId: m.entraId,
        displayName: m.displayName,
        mail: m.mail,
        jobTitle: m.jobTitle ?? null,
      })),
    )
    expect(seedRows()).toHaveLength(10)
  })

  it('checks for directory data, then writes, in one transaction', async () => {
    const { driver, run, close } = fakeDriver(0)
    await expect(seedEvalMembers(driver)).resolves.toEqual({ written: 10, skipped: 0 })
    expect(run.mock.calls).toEqual([
      [FOREIGN_MEMBERS_CYPHER, { createdBy: 'eval-seed' }],
      [SEED_MEMBERS_CYPHER, { rows: seedRows(), createdBy: 'eval-seed' }],
    ])
    expect(close).toHaveBeenCalled()
  })

  it('refuses a graph holding any member it did not write, and writes nothing', async () => {
    const { driver, run, close } = fakeDriver(3)
    await expect(seedEvalMembers(driver)).rejects.toThrow(SeedRefused)
    await expect(seedEvalMembers(driver)).rejects.toThrow(/holds 3 Member node/)
    expect(run.mock.calls.map(([cypher]) => cypher)).not.toContain(SEED_MEMBERS_CYPHER)
    expect(close).toHaveBeenCalled()
  })

  it('requires --target naming the resolved Neo4j host', () => {
    expect(() => checkTarget([], 'localhost:7687')).toThrow(/pass --target localhost:7687/)
    expect(() => checkTarget(['--target'], 'localhost:7687')).toThrow(SeedRefused)
    expect(() => checkTarget(['--target', 'neo4j-relay:7687'], 'localhost:7687')).toThrow(
      /--target neo4j-relay:7687 is not the resolved Neo4j localhost:7687/,
    )
    expect(() => checkTarget(['--target', 'localhost:7687'], 'localhost:7687')).not.toThrow()
  })
})

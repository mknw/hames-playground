/**
 * The local seed of the ten pseudonymised members (`scripts/seed-eval-members.ts`),
 * hermetically: what it sends, and what it can never do. The behaviour against a
 * real database is `seed-eval-members-neo4j.test.ts` (disposable only).
 *
 * Mutations that redden it: add a `DELETE` / `DETACH` / `REMOVE` clause; drop the
 * `createdBy` guard before the `SET`; merge on `mail` instead of `entraId`; seed
 * any row the fixture does not hold.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Driver } from 'neo4j-driver'
import {
  EVAL_SEED_CREATED_BY,
  SEED_MEMBERS_CYPHER,
  seedEvalMembers,
  seedRows,
} from '../../../lib/org-graph/scripts/seed-eval-members'
import { SYNTHETIC_MEMBERS } from '../../../lib/eval-support/synthetic-org-graph'

describe('seed-eval-members', () => {
  it('never deletes: no DELETE, DETACH or REMOVE clause', () => {
    expect(SEED_MEMBERS_CYPHER).not.toMatch(/\b(DELETE|DETACH|REMOVE)\b/i)
  })

  it('merges on the pseudonymous entraId and updates only what it created', () => {
    expect(SEED_MEMBERS_CYPHER).toMatch(/MERGE \(m:Member \{entraId: row\.entraId\}\)/)
    expect(SEED_MEMBERS_CYPHER).toMatch(
      /ON CREATE SET m\.createdBy = \$createdBy[\s\S]*WITH m, row WHERE m\.createdBy = \$createdBy\s+SET /,
    )
    expect(EVAL_SEED_CREATED_BY).toBe('eval-seed')
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

  it('writes in one transaction and reports what it skipped', async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 9 }] }))
    const close = vi.fn(async () => undefined)
    const driver = {
      session: () => ({ executeWrite: (work: (tx: unknown) => unknown) => work({ run }), close }),
    } as unknown as Driver
    await expect(seedEvalMembers(driver)).resolves.toEqual({ written: 9, skipped: 1 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(SEED_MEMBERS_CYPHER, {
      rows: seedRows(),
      createdBy: 'eval-seed',
    })
    expect(close).toHaveBeenCalled()
  })
})

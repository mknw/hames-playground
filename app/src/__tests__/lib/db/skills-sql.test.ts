/**
 * Skills repository (#415), WITHOUT a database: the owner scoping and the
 * encryption are pinned on the statements each function sends.
 *
 * Why both this and `skills.test.ts`: CI has no Postgres, so the behavioural
 * suite skips there — and a guard that only runs on a developer's machine is
 * not the merge gate's. This file is what CI sees. It asserts on the SHAPE of
 * the SQL a function sends (the owner clause, the param it binds) and on what
 * lands in the params (ciphertext, never the plaintext), which is exactly where
 * each guard lives. `skills.test.ts` proves the same guards by behaviour where a
 * Postgres exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

interface Sent {
  sql: string
  params: unknown[]
}
const sent: Sent[] = []
let reply: (sql: string) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] })
vi.mock('../../../lib/db/client.server', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    return reply(sql)
  }),
}))

const repo = await import('../../../lib/db/skills.server')
const { decryptField, looksEncrypted } = await import('../../../lib/db/crypto.server')

/** The statements that are not the schema bootstrap. */
const statements = () => sent.filter((s) => !s.sql.startsWith('CREATE TABLE'))
const only = () => {
  const s = statements()
  expect(s).toHaveLength(1)
  return s[0]
}

beforeEach(() => {
  sent.length = 0
  reply = () => ({ rows: [], rowCount: 1 })
})

describe('every write to a skill row is scoped to its author', () => {
  it('setSkillGlobal: WHERE id = $1 AND user_id = $2, bound to the caller', async () => {
    await repo.setSkillGlobal('skill-1', 'user-a', true)
    const { sql, params } = only()
    expect(sql).toMatch(
      /^UPDATE skills SET is_global = \$3, updated_at = NOW\(\) WHERE id = \$1 AND user_id = \$2$/,
    )
    expect(params).toEqual(['skill-1', 'user-a', true])
  })

  it('deleteSkill: WHERE id = $1 AND user_id = $2, bound to the caller', async () => {
    await repo.deleteSkill('skill-1', 'user-a')
    const { sql, params } = only()
    expect(sql).toBe('DELETE FROM skills WHERE id = $1 AND user_id = $2')
    expect(params).toEqual(['skill-1', 'user-a'])
  })

  it('a wrong owner reads as not-found, not as an error', async () => {
    reply = () => ({ rows: [], rowCount: 0 })
    expect(await repo.setSkillGlobal('skill-1', 'intruder', true)).toBe(false)
    expect(await repo.deleteSkill('skill-1', 'intruder')).toBe(false)
  })
})

describe('reads are scoped to what the caller may see', () => {
  it('listSkillsVisibleTo: own rows or global ones, hides joined on the caller', async () => {
    await repo.listSkillsVisibleTo('user-a')
    const { sql, params } = only()
    expect(sql).toContain('LEFT JOIN skill_hides h ON h.skill_id = s.id AND h.user_id = $1')
    expect(sql).toContain('WHERE s.user_id = $1 OR s.is_global')
    // The file is not part of a listing.
    expect(sql).not.toMatch(/\bcontent\b/)
    expect(params).toEqual(['user-a'])
  })

  it('getSkillContents: own or global, by id', async () => {
    await repo.getSkillContents('user-a', ['skill-1'])
    const { sql, params } = only()
    expect(sql).toContain('WHERE id = ANY($2::text[]) AND (user_id = $1 OR is_global)')
    expect(params).toEqual(['user-a', ['skill-1']])
  })

  it('getSkillContents with no ids sends nothing', async () => {
    expect(await repo.getSkillContents('user-a', [])).toEqual(new Map())
    expect(statements()).toHaveLength(0)
  })
})

describe('hiding is the one write a non-author makes', () => {
  it('checks the skill is global and NOT the caller’s before touching skill_hides', async () => {
    reply = (sql) =>
      sql.includes('SELECT id FROM skills') ? { rows: [{ id: 'skill-1' }] } : { rows: [] }
    expect(await repo.setSkillHidden('user-b', 'skill-1', true)).toBe(true)
    const [check, write] = statements()
    expect(check.sql).toBe('SELECT id FROM skills WHERE id = $1 AND is_global AND user_id <> $2')
    expect(check.params).toEqual(['skill-1', 'user-b'])
    expect(write.sql).toBe(
      'INSERT INTO skill_hides (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    )
    expect(write.params).toEqual(['user-b', 'skill-1'])
  })

  it('writes nothing for a skill that is not eligible', async () => {
    reply = () => ({ rows: [] })
    expect(await repo.setSkillHidden('user-b', 'skill-1', true)).toBe(false)
    expect(statements()).toHaveLength(1)
  })

  it('unhide deletes only the caller’s own hide row', async () => {
    reply = (sql) =>
      sql.includes('SELECT id FROM skills') ? { rows: [{ id: 'skill-1' }] } : { rows: [] }
    await repo.setSkillHidden('user-b', 'skill-1', false)
    const write = statements()[1]
    expect(write.sql).toBe('DELETE FROM skill_hides WHERE user_id = $1 AND skill_id = $2')
    expect(write.params).toEqual(['user-b', 'skill-1'])
  })
})

describe('createSkill encrypts through the seam', () => {
  it('binds envelopes for name, description and content — the plaintext never reaches SQL', async () => {
    reply = (sql) =>
      sql.includes('INSERT INTO skills')
        ? {
            rows: [
              {
                id: 'skill-1',
                user_id: 'user-a',
                name: sent.at(-1)!.params[2],
                description: sent.at(-1)!.params[3],
                is_global: false,
                hidden: false,
                created_at: new Date(0),
                updated_at: new Date(0),
              },
            ],
          }
        : { rows: [] }
    const created = await repo.createSkill({
      id: 'skill-1',
      userId: 'user-a',
      name: 'merger-review',
      description: 'Review the Acme merger.',
      content: 'CONFIDENTIAL BODY',
    })
    const insert = statements().find((s) => s.sql.startsWith('INSERT INTO skills'))!
    const [id, userId, name, description, content] = insert.params
    expect([id, userId]).toEqual(['skill-1', 'user-a'])
    for (const v of [name, description, content]) expect(looksEncrypted(v)).toBe(true)
    expect(decryptField(name as string, 't')).toBe('merger-review')
    expect(decryptField(description as string, 't')).toBe('Review the Acme merger.')
    expect(decryptField(content as string, 't')).toBe('CONFIDENTIAL BODY')
    expect(JSON.stringify(sent)).not.toContain('CONFIDENTIAL BODY')
    expect(JSON.stringify(sent)).not.toContain('merger-review')
    // …and the record handed back is decrypted.
    expect(created.name).toBe('merger-review')
  })

  it('counts and de-duplicates against the AUTHOR’s own rows only', async () => {
    reply = () => ({ rows: [] })
    await repo
      .createSkill({ id: 's', userId: 'user-a', name: 'n', description: 'd', content: 'c' })
      .catch(() => {})
    const check = statements()[0]
    expect(check.sql).toBe('SELECT name FROM skills WHERE user_id = $1')
    expect(check.params).toEqual(['user-a'])
  })
})

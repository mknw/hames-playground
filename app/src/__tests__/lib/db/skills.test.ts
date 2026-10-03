/**
 * Skills repository (#415) against a real Postgres: owner scoping, the
 * global/hidden logic and encryption at rest, by behaviour.
 *
 * Skips gracefully when Postgres is not reachable, like every DB-backed suite
 * here. CI has no Postgres, so the same guards are ALSO pinned without one, on
 * the SQL each function sends: `skills-sql.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  MAX_SKILLS_PER_USER,
  SkillRejectedError,
  createSkill,
  deleteSkill,
  getSkillContents,
  listSkillsVisibleTo,
  setSkillGlobal,
  setSkillHidden,
} from '../../../lib/db/skills.server'
import { closePool, query } from '../../../lib/db/client.server'
import { DataDecryptionError, looksEncrypted } from '../../../lib/db/crypto.server'

const tag = Math.random().toString(36).slice(2, 10)
const AUTHOR = `skills-author-${tag}`
const READER = `skills-reader-${tag}`
const OTHER = `skills-other-${tag}`
let dbAvailable = true
let n = 0
const sid = () => `skill-${tag}-${++n}`

const seed = (
  userId: string,
  name: string,
  content = `---\nname: ${name}\n---\nbody of ${name}\n`,
) => createSkill({ id: sid(), userId, name, description: `Use for ${name}.`, content })

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[skills.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM skills WHERE user_id = ANY($1)', [[AUTHOR, READER, OTHER]])
  await closePool()
})

describe('skills repository — encryption at rest', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('stores name, description and content as envelopes, and reads them back', async () => {
    const created = await seed(AUTHOR, 'secret-merger-plan', 'TOP SECRET BODY')
    const { rows } = await query<Record<string, unknown>>(
      'SELECT user_id, name, description, content, is_global FROM skills WHERE id = $1',
      [created.id],
    )
    const raw = rows[0]
    for (const column of ['name', 'description', 'content']) {
      expect(looksEncrypted(raw[column]), `${column} is not an envelope`).toBe(true)
    }
    expect(JSON.stringify(raw)).not.toContain('secret-merger-plan')
    expect(JSON.stringify(raw)).not.toContain('TOP SECRET BODY')
    // What SQL needs stays readable.
    expect(raw.user_id).toBe(AUTHOR)
    expect(raw.is_global).toBe(false)

    expect(created.name).toBe('secret-merger-plan')
    const [listed] = (await listSkillsVisibleTo(AUTHOR)).filter((s) => s.id === created.id)
    expect(listed.description).toBe('Use for secret-merger-plan.')
    expect((await getSkillContents(AUTHOR, [created.id])).get(created.id)).toBe('TOP SECRET BODY')
  })
})

describe('skills repository — owner scoping and the global flag', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('a private skill is invisible to every other user', async () => {
    const s = await seed(AUTHOR, 'private-one')
    expect((await listSkillsVisibleTo(READER)).map((x) => x.id)).not.toContain(s.id)
    expect((await getSkillContents(READER, [s.id])).has(s.id)).toBe(false)
  })

  it('only the author makes a skill global or private', async () => {
    const s = await seed(AUTHOR, 'shareable')
    expect(await setSkillGlobal(s.id, READER, true)).toBe(false)
    expect((await listSkillsVisibleTo(READER)).map((x) => x.id)).not.toContain(s.id)

    expect(await setSkillGlobal(s.id, AUTHOR, true)).toBe(true)
    const seen = (await listSkillsVisibleTo(READER)).find((x) => x.id === s.id)!
    expect(seen.isGlobal).toBe(true)
    expect(seen.userId).toBe(AUTHOR) // the author rides along, for the panel's byline
    expect((await getSkillContents(READER, [s.id])).has(s.id)).toBe(true)

    expect(await setSkillGlobal(s.id, AUTHOR, false)).toBe(true)
    expect((await listSkillsVisibleTo(READER)).map((x) => x.id)).not.toContain(s.id)
  })

  it('only the author deletes, and a delete takes every user’s hide with it', async () => {
    const s = await seed(AUTHOR, 'deletable')
    await setSkillGlobal(s.id, AUTHOR, true)
    expect(await setSkillHidden(READER, s.id, true)).toBe(true)

    expect(await deleteSkill(s.id, READER)).toBe(false)
    expect((await listSkillsVisibleTo(AUTHOR)).map((x) => x.id)).toContain(s.id)

    expect(await deleteSkill(s.id, AUTHOR)).toBe(true)
    const { rows } = await query('SELECT 1 FROM skill_hides WHERE skill_id = $1', [s.id])
    expect(rows).toHaveLength(0)
  })

  it('lists the viewer’s own skills first, then others’ global skills oldest first', async () => {
    const g = await seed(OTHER, 'order-global')
    await setSkillGlobal(g.id, OTHER, true)
    const mine = await seed(READER, 'order-mine')
    const ids = (await listSkillsVisibleTo(READER)).map((x) => x.id)
    expect(ids.indexOf(mine.id)).toBeLessThan(ids.indexOf(g.id))
  })
})

describe('skills repository — hiding another user’s global skill', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('is per viewer, and only for a global skill someone else wrote', async () => {
    const g = await seed(AUTHOR, 'hide-me')
    await setSkillGlobal(g.id, AUTHOR, true)
    const priv = await seed(OTHER, 'hide-private')
    const own = await seed(READER, 'hide-own')

    expect(await setSkillHidden(READER, g.id, true)).toBe(true)
    expect(await setSkillHidden(READER, g.id, true)).toBe(true) // idempotent
    expect((await listSkillsVisibleTo(READER)).find((x) => x.id === g.id)!.hidden).toBe(true)
    // Another viewer is unaffected.
    expect((await listSkillsVisibleTo(OTHER)).find((x) => x.id === g.id)!.hidden).toBe(false)
    // The author never sees their own skill as hidden.
    expect((await listSkillsVisibleTo(AUTHOR)).find((x) => x.id === g.id)!.hidden).toBe(false)

    expect(await setSkillHidden(READER, priv.id, true)).toBe(false)
    expect(await setSkillHidden(READER, own.id, true)).toBe(false)
    expect(await setSkillHidden(READER, 'skill-no-such', true)).toBe(false)

    expect(await setSkillHidden(READER, g.id, false)).toBe(true)
    expect((await listSkillsVisibleTo(READER)).find((x) => x.id === g.id)!.hidden).toBe(false)
  })
})

describe('skills repository — the rules createSkill owns', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('refuses a name the author already uses, but not another user’s', async () => {
    await seed(AUTHOR, 'same-name')
    await expect(seed(AUTHOR, 'same-name')).rejects.toBeInstanceOf(SkillRejectedError)
    await expect(seed(READER, 'same-name')).resolves.toMatchObject({ name: 'same-name' })
  })

  it(`refuses the ${MAX_SKILLS_PER_USER + 1}th skill of one user`, async () => {
    const user = `skills-cap-${tag}`
    try {
      for (let i = 0; i < MAX_SKILLS_PER_USER; i++) await seed(user, `cap-${i}`)
      await expect(seed(user, 'one-too-many')).rejects.toThrow(
        `You already have ${MAX_SKILLS_PER_USER} skills`,
      )
    } finally {
      await query('DELETE FROM skills WHERE user_id = $1', [user])
    }
  })
})

describe('skills repository — a row that will not decrypt', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('another user’s global row is skipped; the owner’s own listing fails loudly', async () => {
    // A user with no other rows, so the create's own duplicate check (which
    // decrypts that user's names) runs under the foreign key without tripping.
    const stranger = `skills-stranger-${tag}`
    const key = process.env.DATA_ENCRYPTION_KEY
    process.env.DATA_ENCRYPTION_KEY = 'a-different-key-for-this-test'
    let bad
    try {
      bad = await seed(stranger, 'unreadable')
    } finally {
      process.env.DATA_ENCRYPTION_KEY = key
    }
    await query('UPDATE skills SET is_global = TRUE WHERE id = $1', [bad.id])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await listSkillsVisibleTo(READER)).map((x) => x.id)).not.toContain(bad.id)
      expect((await getSkillContents(READER, [bad.id])).has(bad.id)).toBe(false)
      await expect(listSkillsVisibleTo(stranger)).rejects.toBeInstanceOf(DataDecryptionError)
    } finally {
      error.mockRestore()
      await query('DELETE FROM skills WHERE id = $1', [bad.id])
    }
  })
})

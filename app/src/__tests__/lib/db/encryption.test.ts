/**
 * At-rest encryption, end to end against Postgres.
 *
 * Two things are asserted for every encrypted column, and the second is the one
 * that matters: that the repository round-trips the value, **and** that what is
 * physically in the table is ciphertext. A round-trip test alone passes just as
 * happily when nothing is encrypted at all.
 *
 * Skips gracefully when Postgres isn't reachable, like the other DB suites.
 * `global-setup.ts` points these at a throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { closePool, query } from '../../../lib/db/client.server'
import {
  listConversationEvents,
  listConversations,
  loadConversation,
  saveConversation,
  updateConversationTitle,
} from '../../../lib/db/conversations.server'
import { createRoutine, getRoutine, updateRoutine } from '../../../lib/db/routines.server'
import { createSession, getSession } from '../../../lib/auth/session-store.server'
import { getUser, upsertUser } from '../../../lib/auth/users.server'
import {
  assertKeyOpensStoredData,
  encryptExistingRows,
  sampleEncryptedColumns,
  type QueryRunner,
} from '../../../lib/db/migrate-encryption.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const TEST_USER = `enc-user-${SUFFIX}`
const OTHER_USER = `enc-legacy-${SUFFIX}`

const SECRET_TITLE = 'Q3 salary review for Alex Doe'
const SECRET_BODY = 'alex.doe@example.com asked about the acquisition'
const SECRET_EMAIL = `alex.doe.${SUFFIX}@example.com`
const SECRET_NAME = 'Alex Doe'
const SECRET_INPUT = 'Summarise my unread mail about the acquisition'
const SECRET_LABEL = 'Morning mail digest'

const context = (extra = ''): string =>
  JSON.stringify({
    status: 'done',
    events: [{ type: 'user_message', data: { content: `${SECRET_BODY}${extra}` } }],
  })

/** The migration talks to the pool through a runner; outside init, `query` is one. */
const runner: QueryRunner = (text, params) => query(text, params) as never

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
    // The auth/routine schemas bootstrap from their own modules; touch them so
    // the raw assertions below have tables to read.
    await createSession({
      userId: TEST_USER,
      email: SECRET_EMAIL,
      displayName: SECRET_NAME,
      homeAccountId: null,
    })
  } catch (err) {
    dbAvailable = false
    console.warn('[encryption.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM conversations WHERE user_id = ANY($1)', [[TEST_USER, OTHER_USER]])
  await query('DELETE FROM routines WHERE user_id = ANY($1)', [[TEST_USER, OTHER_USER]])
  await query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [[TEST_USER, OTHER_USER]])
  await query('DELETE FROM users WHERE id = ANY($1)', [[TEST_USER, OTHER_USER]])
  await closePool()
})

describe('conversations', () => {
  it('round-trips title and context, and stores both as ciphertext', async () => {
    if (!dbAvailable) return
    const id = `enc-conv-${SUFFIX}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'general',
      title: SECRET_TITLE,
      serializedContext: context(),
      status: 'done',
    })

    const loaded = await loadConversation(id, TEST_USER)
    expect(loaded?.title).toBe(SECRET_TITLE)
    expect(JSON.parse(loaded!.serializedContext)).toEqual(JSON.parse(context()))

    // What is actually in the table.
    const { rows } = await query<{ title: string; ctx: string; kind: string; agent_id: string }>(
      `SELECT title, context::text AS ctx, jsonb_typeof(context) AS kind, agent_id
         FROM conversations WHERE id = $1`,
      [id],
    )
    expect(looksEncrypted(rows[0].title)).toBe(true)
    expect(rows[0].kind).toBe('string')
    expect(rows[0].ctx).not.toContain(SECRET_BODY)
    expect(rows[0].ctx).not.toContain('user_message')
    expect(rows[0].title).not.toContain('salary')
    // Plaintext by design, so joins and filters keep working.
    expect(rows[0].agent_id).toBe('general')
  })

  it('decrypts titles in the sidebar listing', async () => {
    if (!dbAvailable) return
    const items = await listConversations(TEST_USER)
    expect(items.map((i) => i.title)).toContain(SECRET_TITLE)
  })

  it('re-encrypts an authoritative title override', async () => {
    if (!dbAvailable) return
    const id = `enc-conv-title-${SUFFIX}`
    await saveConversation({
      id,
      userId: TEST_USER,
      agentId: 'general',
      title: null,
      serializedContext: context(),
    })
    await updateConversationTitle(id, TEST_USER, 'Renamed: Alex Doe 1:1')

    const { rows } = await query<{ title: string }>(
      'SELECT title FROM conversations WHERE id = $1',
      [id],
    )
    expect(looksEncrypted(rows[0].title)).toBe(true)
    expect((await loadConversation(id, TEST_USER))?.title).toBe('Renamed: Alex Doe 1:1')
  })

  it('still yields the event stream for the metrics dashboard', async () => {
    if (!dbAvailable) return
    const rows = await listConversationEvents(TEST_USER)
    const mine = rows.find((r) => r.id === `enc-conv-${SUFFIX}`)
    expect(mine?.title).toBe(SECRET_TITLE)
    expect(mine?.events).toEqual([{ type: 'user_message', data: { content: SECRET_BODY } }])
  })
})

describe('auth_sessions', () => {
  it('round-trips email and display name, and stores both as ciphertext', async () => {
    if (!dbAvailable) return
    const id = await createSession({
      userId: TEST_USER,
      email: SECRET_EMAIL,
      displayName: SECRET_NAME,
      homeAccountId: 'acct-1',
    })
    const record = await getSession(id)
    expect(record?.email).toBe(SECRET_EMAIL)
    expect(record?.displayName).toBe(SECRET_NAME)

    const { rows } = await query<{ email: string; display_name: string; user_id: string }>(
      'SELECT email, display_name, user_id FROM auth_sessions WHERE id = $1',
      [id],
    )
    expect(looksEncrypted(rows[0].email)).toBe(true)
    expect(looksEncrypted(rows[0].display_name)).toBe(true)
    expect(rows[0].email).not.toContain('@')
    expect(rows[0].user_id).toBe(TEST_USER)
  })
})

describe('users', () => {
  it('round-trips email and display name, and stores both as ciphertext', async () => {
    if (!dbAvailable) return
    await upsertUser({
      id: TEST_USER,
      email: SECRET_EMAIL,
      displayName: SECRET_NAME,
      tenantId: 'tenant-1',
    })
    const user = await getUser(TEST_USER)
    expect(user?.email).toBe(SECRET_EMAIL)
    expect(user?.displayName).toBe(SECRET_NAME)

    const { rows } = await query<{ email: string; display_name: string; tid: string }>(
      'SELECT email, display_name, tid FROM users WHERE id = $1',
      [TEST_USER],
    )
    expect(looksEncrypted(rows[0].email)).toBe(true)
    expect(looksEncrypted(rows[0].display_name)).toBe(true)
    expect(rows[0].tid).toBe('tenant-1')
  })
})

describe('routines', () => {
  it('round-trips input and label, and stores both as ciphertext', async () => {
    if (!dbAvailable) return
    const id = `enc-routine-${SUFFIX}`
    const created = await createRoutine({
      id,
      userId: TEST_USER,
      agentId: 'general',
      trigger: { kind: 'interval', intervalSeconds: 3600 },
      input: SECRET_INPUT,
      label: SECRET_LABEL,
    })
    expect(created.input).toBe(SECRET_INPUT)
    expect(created.label).toBe(SECRET_LABEL)
    expect((await getRoutine(id, TEST_USER))?.input).toBe(SECRET_INPUT)

    const { rows } = await query<{ input: string; label: string; trigger_kind: string }>(
      'SELECT input, label, trigger_kind FROM routines WHERE id = $1',
      [id],
    )
    expect(looksEncrypted(rows[0].input)).toBe(true)
    expect(looksEncrypted(rows[0].label)).toBe(true)
    expect(rows[0].input).not.toContain('acquisition')
    // The scheduler filters on this in SQL, so it must stay readable.
    expect(rows[0].trigger_kind).toBe('interval')
  })

  it('re-encrypts a patched input', async () => {
    if (!dbAvailable) return
    const id = `enc-routine-patch-${SUFFIX}`
    await createRoutine({
      id,
      userId: TEST_USER,
      agentId: 'general',
      trigger: { kind: 'interval', intervalSeconds: 3600 },
      input: SECRET_INPUT,
    })
    const patched = await updateRoutine(id, TEST_USER, { input: 'New secret prompt' })
    expect(patched?.input).toBe('New secret prompt')

    const { rows } = await query<{ input: string }>('SELECT input FROM routines WHERE id = $1', [
      id,
    ])
    expect(looksEncrypted(rows[0].input)).toBe(true)
    expect(rows[0].input).not.toContain('New secret prompt')
  })
})

describe('boot probes, against real SQL', () => {
  // The unit tests drive these through a fake runner, which cannot catch a
  // wrong operator. `context #>> '{}'` in particular is the only way to pull a
  // JSONB string scalar back out as text, and nothing else in the repo uses it.
  it('samples a real envelope from every encrypted column, JSONB included', async () => {
    if (!dbAvailable) return
    const samples = await sampleEncryptedColumns(runner)
    const byColumn = new Map(samples.map((s) => [s.where, s.value]))

    for (const where of ['conversations.title', 'conversations.context', 'auth_sessions.email']) {
      expect(byColumn.has(where), `no sample for ${where}`).toBe(true)
      expect(looksEncrypted(byColumn.get(where))).toBe(true)
    }
  })

  it('accepts the key that wrote those rows', async () => {
    if (!dbAvailable) return
    await expect(assertKeyOpensStoredData(runner)).resolves.toBeUndefined()
  })
})

describe('backfill migration', () => {
  /** Write a row the way the pre-encryption build did: straight plaintext. */
  async function seedLegacyRows(id: string): Promise<void> {
    await query(
      `INSERT INTO conversations (id, user_id, agent_id, title, context, status)
       VALUES ($1, $2, 'general', $3, $4::jsonb, 'done')`,
      [id, OTHER_USER, SECRET_TITLE, context('-legacy')],
    )
    await query(
      `INSERT INTO users (id, email, display_name, tid) VALUES ($1, $2, $3, 'tenant-1')`,
      [OTHER_USER, SECRET_EMAIL, SECRET_NAME],
    )
  }

  it('encrypts legacy plaintext rows and leaves them readable', async () => {
    if (!dbAvailable) return
    const id = `enc-legacy-conv-${SUFFIX}`
    await seedLegacyRows(id)

    // Characterise the starting state: genuinely plaintext in the table.
    const before = await query<{ title: string; kind: string }>(
      'SELECT title, jsonb_typeof(context) AS kind FROM conversations WHERE id = $1',
      [id],
    )
    expect(before.rows[0].title).toBe(SECRET_TITLE)
    expect(before.rows[0].kind).toBe('object')

    const report = await encryptExistingRows(runner)
    expect(report.totalRowsEncrypted).toBeGreaterThanOrEqual(2)

    const after = await query<{ title: string; kind: string }>(
      'SELECT title, jsonb_typeof(context) AS kind FROM conversations WHERE id = $1',
      [id],
    )
    expect(looksEncrypted(after.rows[0].title)).toBe(true)
    expect(after.rows[0].kind).toBe('string')

    const loaded = await loadConversation(id, OTHER_USER)
    expect(loaded?.title).toBe(SECRET_TITLE)
    expect(JSON.parse(loaded!.serializedContext)).toEqual(JSON.parse(context('-legacy')))
    expect((await getUser(OTHER_USER))?.email).toBe(SECRET_EMAIL)
  })

  it('is idempotent: a second run converts nothing and rewrites nothing', async () => {
    if (!dbAvailable) return
    const id = `enc-legacy-conv-${SUFFIX}`
    const snapshot = await query<{ title: string; ctx: string }>(
      'SELECT title, context::text AS ctx FROM conversations WHERE id = $1',
      [id],
    )

    const report = await encryptExistingRows(runner)
    expect(report.totalRowsEncrypted).toBe(0)

    const again = await query<{ title: string; ctx: string }>(
      'SELECT title, context::text AS ctx FROM conversations WHERE id = $1',
      [id],
    )
    // Byte-identical: nothing was re-encrypted under a fresh IV, so the
    // predicate really did recognise its own output.
    expect(again.rows[0]).toEqual(snapshot.rows[0])
  })

  it('skips tables that do not exist in this database', async () => {
    if (!dbAvailable) return
    const report = await encryptExistingRows(runner)
    // `routines` is created lazily; whether it is absent depends on test order,
    // so only assert the shape: every table is either absent or converged.
    for (const table of report.tables) {
      expect(table.incomplete).toBe(false)
      if (table.absent) expect(table.rowsEncrypted).toBe(0)
    }
  })
})

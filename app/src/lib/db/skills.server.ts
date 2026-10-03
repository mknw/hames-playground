/**
 * Skills repository (Postgres) — Server Only (#415).
 *
 * One row per uploaded `SKILL.md`, owned by the user who uploaded it. The
 * author may make it GLOBAL; a global skill is visible to — and, unless they
 * hide it, mounted in the sandbox of — every user (owner decision, 2026-10-03:
 * who may make a skill global is "anybody"). Hiding is per user and is a row in
 * `skill_hides`, so one user's choice never changes what another sees.
 *
 * ## Encryption at rest
 *
 * `name`, `description` and `content` are user content and are encrypted
 * through this module (`db/crypto.server.ts`) — the name too, because a skill's
 * name can say as much about the work as its body does ("acme-merger-review").
 * What stays plaintext is what SQL needs: `id`, `user_id`, the `is_global`
 * flag (a lifted boolean the listing filters on) and the timestamps.
 * `skill_hides` holds ids and a timestamp only, so it is plaintext like
 * `session_claims`.
 *
 * Because the name is ciphertext, per-user name uniqueness cannot be a SQL
 * `UNIQUE` constraint; {@link createSkill} enforces it by reading the owner's
 * own rows. Two uploads of the same name racing each other can both pass —
 * the consequence is bounded and visible (the sandbox mounts one name once,
 * first by creation time, and the panel marks the other "shadowed"), so the
 * read-then-write is a deliberate trade, not an oversight.
 *
 * ## Owner scoping
 *
 * Every statement that changes a skill row carries `AND user_id = $n`: only
 * the author edits, deletes or toggles one, and a wrong owner reads as
 * "not found" (`false`), never as an error that confirms the id exists.
 * Hiding is the one write a non-author makes, and it touches only the
 * caller's own `skill_hides` row, for a skill that is global and not theirs.
 *
 * ## What an unreadable row does
 *
 * The caller's OWN rows fail closed, as `routines` does for a listing a user
 * is shown: a silently shorter list is how a key incident becomes "my skills
 * are gone". Another user's GLOBAL row that will not decrypt is skipped and
 * logged instead: it is not this user's data, and failing closed would let one
 * bad row take every user's panel and every sandbox's skills down with it.
 *
 * Deliberately NOT a `'use server'` module: every function takes a `userId`,
 * which a browser-reachable export would let the caller choose (SD-13). The
 * RPC surface is `lib/skills/actions.server.ts`.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { query } from './client.server'
import {
  DataDecryptionError,
  MissingDataEncryptionKeyError,
  decryptField,
  encryptField,
} from './crypto.server'

assertServerOnImport()

/** Most skills one user may own. Equal to the sandbox's mount ceiling, so a
 *  user's own skills always all fit; global skills take the remaining room. */
export const MAX_SKILLS_PER_USER = 20

/** A skill as listings see it — everything but the file. */
export interface SkillRecord {
  id: string
  /** The author. */
  userId: string
  name: string
  description: string
  isGlobal: boolean
  /** Whether the VIEWER hid it. Only ever true for another user's global skill. */
  hidden: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateSkillInput {
  id: string
  userId: string
  name: string
  description: string
  content: string
}

/** A create that broke a rule the repository owns. Its message is for the user. */
export class SkillRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillRejectedError'
  }
}

interface DbRow {
  id: string
  user_id: string
  name: string
  description: string
  is_global: boolean
  hidden: boolean
  created_at: Date
  updated_at: Date
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    content     TEXT NOT NULL,
    is_global   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS skills_user_created_idx ON skills (user_id, created_at);
  CREATE INDEX IF NOT EXISTS skills_global_created_idx ON skills (created_at) WHERE is_global;

  CREATE TABLE IF NOT EXISTS skill_hides (
    user_id    TEXT NOT NULL,
    skill_id   TEXT NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, skill_id)
  );
`

let _schemaReady: Promise<void> | null = null
function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        _schemaReady = null // allow retry on next call
        throw err
      })
  }
  return _schemaReady
}

function toRecord(row: DbRow): SkillRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: decryptField(row.name, 'skills.name'),
    description: decryptField(row.description, 'skills.description'),
    isGlobal: row.is_global,
    hidden: row.hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const unreadable = (err: unknown): boolean =>
  err instanceof DataDecryptionError || err instanceof MissingDataEncryptionKeyError

/** Map rows for `viewerId`: own rows fail closed, others' rows are skipped. */
function toRecords(rows: DbRow[], viewerId: string): SkillRecord[] {
  const out: SkillRecord[] = []
  for (const row of rows) {
    try {
      out.push(toRecord(row))
    } catch (err) {
      if (!unreadable(err) || row.user_id === viewerId) throw err
      console.error(
        `[skills] global skill ${row.id} (author ${row.user_id}) cannot be decrypted and is ` +
          'left out of every other user’s list and sandbox:',
        err instanceof Error ? err.message : err,
      )
    }
  }
  return out
}

/**
 * Every skill `userId` can see: all of their own, and every other user's
 * global skill with whether `userId` hid it. Their own first, then oldest
 * first — the order the sandbox mounts in, so an established skill is never
 * displaced by a newer one of the same name. Capped at 500 rows; the own rows
 * are never the ones the cap cuts, because they sort first and number at most
 * {@link MAX_SKILLS_PER_USER}.
 */
export async function listSkillsVisibleTo(userId: string): Promise<SkillRecord[]> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT s.id, s.user_id, s.name, s.description, s.is_global, s.created_at, s.updated_at,
            (h.skill_id IS NOT NULL AND s.user_id <> $1) AS hidden
       FROM skills s
       LEFT JOIN skill_hides h ON h.skill_id = s.id AND h.user_id = $1
      WHERE s.user_id = $1 OR s.is_global
      ORDER BY (s.user_id = $1) DESC, s.created_at ASC, s.id ASC
      LIMIT 500`,
    [userId],
  )
  return toRecords(rows, userId)
}

/**
 * The files of the given skills, for those `userId` may read — their own, or
 * global. An id outside that set is simply absent from the result.
 */
export async function getSkillContents(
  userId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  await ensureSchema()
  const { rows } = await query<{ id: string; user_id: string; content: string }>(
    `SELECT id, user_id, content FROM skills
      WHERE id = ANY($2::text[]) AND (user_id = $1 OR is_global)`,
    [userId, [...ids]],
  )
  const out = new Map<string, string>()
  for (const row of rows) {
    try {
      out.set(row.id, decryptField(row.content, 'skills.content'))
    } catch (err) {
      if (!unreadable(err) || row.user_id === userId) throw err
      console.error(`[skills] global skill ${row.id} content cannot be decrypted; skipped`)
    }
  }
  return out
}

/**
 * Store a new skill for its author. Refuses (with {@link SkillRejectedError})
 * a name the author already uses and an author already at
 * {@link MAX_SKILLS_PER_USER}.
 */
export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  await ensureSchema()
  const { rows: own } = await query<{ name: string }>(
    `SELECT name FROM skills WHERE user_id = $1`,
    [input.userId],
  )
  if (own.length >= MAX_SKILLS_PER_USER) {
    throw new SkillRejectedError(
      `You already have ${MAX_SKILLS_PER_USER} skills, the most one user can keep. ` +
        'Delete one to upload another.',
    )
  }
  if (own.some((r) => decryptField(r.name, 'skills.name') === input.name)) {
    throw new SkillRejectedError(
      `You already have a skill named "${input.name}". Delete it first to replace it.`,
    )
  }
  const { rows } = await query<DbRow>(
    `INSERT INTO skills (id, user_id, name, description, content)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, name, description, is_global, FALSE AS hidden, created_at, updated_at`,
    [
      input.id,
      input.userId,
      encryptField(input.name),
      encryptField(input.description),
      encryptField(input.content),
    ],
  )
  return toRecord(rows[0])
}

/** Make the author's skill global or private. `false` when it is not theirs. */
export async function setSkillGlobal(
  id: string,
  userId: string,
  isGlobal: boolean,
): Promise<boolean> {
  await ensureSchema()
  const { rowCount } = await query(
    `UPDATE skills SET is_global = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, userId, isGlobal],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Hide or unhide another user's global skill, for `userId` only. `false` when
 * `skillId` is not a global skill someone else wrote — a user cannot hide
 * their own skill (they delete or un-globalise it) or a private one.
 */
export async function setSkillHidden(
  userId: string,
  skillId: string,
  hidden: boolean,
): Promise<boolean> {
  await ensureSchema()
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM skills WHERE id = $1 AND is_global AND user_id <> $2`,
    [skillId, userId],
  )
  if (rows.length === 0) return false
  if (hidden) {
    await query(
      `INSERT INTO skill_hides (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, skillId],
    )
  } else {
    await query(`DELETE FROM skill_hides WHERE user_id = $1 AND skill_id = $2`, [userId, skillId])
  }
  return true
}

/** Delete the author's skill (and every user's hide of it). `false` when not theirs. */
export async function deleteSkill(id: string, userId: string): Promise<boolean> {
  await ensureSchema()
  const { rowCount } = await query('DELETE FROM skills WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ])
  return (rowCount ?? 0) > 0
}

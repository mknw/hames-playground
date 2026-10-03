/**
 * Skills — server actions (#415): the Sandbox panel's Skills sub-tab.
 *
 * Six RPCs: list what the caller can see, upload a `SKILL.md`, make one of
 * their own skills global or private, hide or unhide another user's global
 * skill, delete one of their own, and read one skill's file.
 *
 * ## The gate, and why it is a copy
 *
 * Every export of a `'use server'` module is an RPC the browser can call, so
 * EVERY export below starts with `const user = await requireUser()` — before
 * it reads an argument, before it opens a resource. `requireUser()` is
 * duplicated here rather than imported, for the reason each other copy exists:
 * a `'use server'` file cannot export a shared helper without also exporting
 * it as an RPC (SD-13). `skills-actions-gate.test.ts` pins both halves — every
 * export is gated on its first line, and none takes an owner argument.
 *
 * **No function here takes an owner id.** The owner is the session's user;
 * every argument is a skill id, a flag or the uploaded text, and each is
 * type-checked before use, because an RPC argument is whatever the caller sent.
 * Whether the caller may act on a given skill is decided by the repository's
 * owner-scoped SQL, so a wrong id and someone else's id read the same: "not
 * found".
 */
'use server'

import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { getUser } from '../auth/users.server'
import {
  SkillRejectedError,
  createSkill,
  deleteSkill as dbDeleteSkill,
  getSkillContents,
  listSkillsVisibleTo,
  setSkillGlobal as dbSetSkillGlobal,
  setSkillHidden as dbSetSkillHidden,
  type SkillRecord,
} from '../db/skills.server'
import { parseSkillFile, utf8Bytes } from './skill-file'
import { resolveSkillStatuses, type SkillMountStatus } from './active-skills'
import { SKILL_FILE_MAX_BYTES } from '@hames-ai/sandbox/skills'

async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const u = await getAuthenticatedUser()
  return { id: u.id }
}

/** One skill as the panel shows it. */
export interface SkillView {
  id: string
  name: string
  description: string
  /** The caller wrote it. */
  mine: boolean
  isGlobal: boolean
  /** The caller hid it (only ever true for another user's global skill). */
  hidden: boolean
  /** Whether the caller's sandbox mounts it, and if not, why. */
  status: SkillMountStatus
  /** The author's name, for another user's global skill; null for the caller's own. */
  author: string | null
  createdAt: string
}

export type SkillActionResult = { ok: true } | { ok: false; error: string }
export type UploadSkillResult = { ok: true; skill: SkillView } | { ok: false; error: string }

const NOT_FOUND: SkillActionResult = { ok: false, error: 'That skill was not found.' }

/** A skill id as this module mints them. Anything else cannot be a row id. */
const isSkillId = (v: unknown): v is string =>
  typeof v === 'string' && /^skill-[0-9a-f-]{36}$/.test(v)

/** The author label shown on another user's global skill. */
async function authorNames(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of new Set(ids)) {
    if (id === BYPASS_USER.id) {
      out.set(id, BYPASS_USER.email)
      continue
    }
    const u = await getUser(id)
    out.set(id, u?.displayName || u?.email || 'Unknown author')
  }
  return out
}

function toView(
  s: SkillRecord,
  viewerId: string,
  status: SkillMountStatus,
  authors: Map<string, string>,
): SkillView {
  const mine = s.userId === viewerId
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    mine,
    isGlobal: s.isGlobal,
    hidden: !mine && s.hidden,
    status,
    author: mine ? null : (authors.get(s.userId) ?? 'Unknown author'),
    createdAt: s.createdAt.toISOString(),
  }
}

/** Everything the caller can see: their own skills, then other users' global skills. */
export async function listSkills(): Promise<SkillView[]> {
  const user = await requireUser()
  const skills = await listSkillsVisibleTo(user.id)
  const statuses = resolveSkillStatuses(skills, user.id)
  const authors = await authorNames(skills.filter((s) => s.userId !== user.id).map((s) => s.userId))
  return skills.map((s) => toView(s, user.id, statuses.get(s.id) ?? 'mounted', authors))
}

/** Store an uploaded `SKILL.md` as one of the caller's own (private) skills. */
export async function uploadSkill(text: unknown): Promise<UploadSkillResult> {
  const user = await requireUser()
  // Length first, before any parse: the cap is the sandbox's write-path limit.
  if (typeof text !== 'string') return { ok: false, error: 'Upload a SKILL.md text file.' }
  if (utf8Bytes(text) > SKILL_FILE_MAX_BYTES) {
    return { ok: false, error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES} bytes (64 KiB).` }
  }
  const parsed = parseSkillFile(text)
  if (!parsed.ok) return parsed
  try {
    const record = await createSkill({
      id: `skill-${crypto.randomUUID()}`,
      userId: user.id,
      ...parsed.skill,
    })
    // Its status in the caller's sandbox needs the rest of their list (a new
    // skill can be over the ceiling or shadow a global one), so re-resolve.
    const statuses = resolveSkillStatuses(await listSkillsVisibleTo(user.id), user.id)
    return {
      ok: true,
      skill: toView(record, user.id, statuses.get(record.id) ?? 'mounted', new Map()),
    }
  } catch (err) {
    if (err instanceof SkillRejectedError) return { ok: false, error: err.message }
    throw err
  }
}

/** Make one of the caller's skills global (every user's sandbox) or private again. */
export async function setSkillGlobal(
  skillId: unknown,
  isGlobal: unknown,
): Promise<SkillActionResult> {
  const user = await requireUser()
  if (!isSkillId(skillId) || typeof isGlobal !== 'boolean') return NOT_FOUND
  return (await dbSetSkillGlobal(skillId, user.id, isGlobal)) ? { ok: true } : NOT_FOUND
}

/** Hide or unhide another user's global skill in the caller's own sandbox and list. */
export async function setSkillHidden(
  skillId: unknown,
  hidden: unknown,
): Promise<SkillActionResult> {
  const user = await requireUser()
  if (!isSkillId(skillId) || typeof hidden !== 'boolean') return NOT_FOUND
  return (await dbSetSkillHidden(user.id, skillId, hidden)) ? { ok: true } : NOT_FOUND
}

/** Delete one of the caller's skills. */
export async function deleteSkill(skillId: unknown): Promise<SkillActionResult> {
  const user = await requireUser()
  if (!isSkillId(skillId)) return NOT_FOUND
  return (await dbDeleteSkill(skillId, user.id)) ? { ok: true } : NOT_FOUND
}

/** One skill's whole `SKILL.md`, if the caller may read it (their own, or global). */
export async function getSkillContent(skillId: unknown): Promise<string | null> {
  const user = await requireUser()
  if (!isSkillId(skillId)) return null
  return (await getSkillContents(user.id, [skillId])).get(skillId) ?? null
}

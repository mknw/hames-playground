/**
 * Skills in the sandbox — the server half (#415): make `/skills` match the set a
 * host resolved for this run.
 *
 * `syncSkills` is called by `withSandbox` once per run, after the transport is
 * open and before the pattern runs. It is a SYNC, not a write: an id-addressable
 * container outlives the turn, so a skill the user deleted or hid since the last
 * turn must leave the container, and a skill whose stored text changed must be
 * rewritten. The diff key is the content hash, computed in-VM (`listWorkFiles`),
 * so a steady-state turn costs one `find` and writes nothing, and a file the
 * agent edited inside the container is restored from the stored copy on the next
 * turn.
 *
 * ## What it refuses, before anything reaches the container
 *
 * Whatever a host passes, the package checks what it is about to write
 * (`skills.ts` has the reasons for each bound):
 *
 *   - a name that fails the specification's rule — which is also what keeps it
 *     a single safe path segment, so there is no traversal to guard separately;
 *   - a second skill of a name already selected (first wins — the host orders
 *     its list by precedence);
 *   - a file over {@link SKILL_FILE_MAX_BYTES};
 *   - anything past {@link MAX_MOUNTED_SKILLS}.
 *
 * Each refusal is RETURNED, never dropped: the caller reports it as a run event.
 * The same goes for a write that fails in the container. Only what actually
 * landed is returned as `mounted`, and only that goes into the index, so the
 * model is never told about a file that is not there.
 *
 * ## The write path
 *
 * Every command here is harness plumbing, so it is sent `internal` and bypasses
 * the bash guard (the work-sync precedent). Content travels base64-encoded inside
 * a single-quoted argument — the base64 alphabet has no quote — and is decoded
 * in-VM, so no byte of a skill is ever interpreted by the shell. The target is
 * removed before it is written, so a symlink the agent left in its place is
 * replaced rather than followed.
 *
 * ## What it does not do
 *
 * It makes nothing read-only. `/skills` is writable by the same uid the agent
 * runs as (exactly like `/work/in`), so "the agent does not edit skills" is a
 * convention; the hash diff is what puts the stored text back each turn.
 */

import { createHash } from 'node:crypto'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { McpTransport } from './types'
import { bash, listWorkFiles, shq } from './work-sync.server'
import {
  MAX_MOUNTED_SKILLS,
  SKILLS_DIR,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_NAME,
  isSkillName,
  type SandboxSkill,
} from './skills'

assertServerOnImport()

/** A skill that was not mounted, and why. */
export interface SkippedSkill {
  name: string
  error: string
}

/** What one sync did. `removalError` is set when stale files could not be
 *  removed — a skill the user withdrew may still be readable in the container. */
export interface SkillsSyncResult {
  mounted: SandboxSkill[]
  skipped: SkippedSkill[]
  removalError?: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The relative path `listWorkFiles` reports for a skill's file. */
function relPath(name: string): string {
  return `${name}/${SKILL_FILE_NAME}`
}

/** Apply the package's bounds, in the host's order. */
function select(skills: readonly SandboxSkill[]): {
  selected: SandboxSkill[]
  skipped: SkippedSkill[]
} {
  const selected: SandboxSkill[] = []
  const skipped: SkippedSkill[] = []
  const names = new Set<string>()
  for (const skill of skills) {
    const name = String(skill?.name ?? '')
    if (!isSkillName(name)) {
      skipped.push({ name, error: 'not a valid skill name' })
    } else if (names.has(name)) {
      skipped.push({ name, error: 'another skill with this name is already mounted' })
    } else if (typeof skill.content !== 'string') {
      skipped.push({ name, error: 'no SKILL.md text' })
    } else if (Buffer.byteLength(skill.content, 'utf8') > SKILL_FILE_MAX_BYTES) {
      skipped.push({ name, error: `larger than ${SKILL_FILE_MAX_BYTES} bytes` })
    } else if (selected.length >= MAX_MOUNTED_SKILLS) {
      skipped.push({ name, error: `more than ${MAX_MOUNTED_SKILLS} skills in one sandbox` })
    } else {
      names.add(name)
      selected.push(skill)
    }
  }
  return { selected, skipped }
}

/**
 * Make {@link SKILLS_DIR} hold exactly `skills` (after the package's bounds).
 * Throws only when the container cannot be listed at all; every per-skill and
 * per-file failure is returned.
 */
export async function syncSkills(
  transport: McpTransport,
  skills: readonly SandboxSkill[],
): Promise<SkillsSyncResult> {
  const { selected, skipped } = select(skills)
  const desired = new Map(selected.map((s) => [relPath(s.name), sha256(s.content)]))
  const present = await listWorkFiles(transport, SKILLS_DIR)

  // Remove everything that is not in the desired set — skills withdrawn since
  // the last turn, and anything else that appeared under /skills.
  let removalError: string | undefined
  const stale = [...present.keys()].filter((rel) => !desired.has(rel))
  if (stale.length > 0) {
    const targets = stale.map((rel) => shq(`${SKILLS_DIR}/${rel}`)).join(' ')
    const removed = await bash(
      transport,
      `rm -f -- ${targets} && find ${shq(SKILLS_DIR)} -mindepth 1 -type d -empty -delete`,
    )
    if (!removed.ok) {
      removalError = `could not remove ${stale.length} stale file(s): ${removed.stderr || `exit ${removed.code}`}`
    }
  }

  const mounted: SandboxSkill[] = []
  for (const skill of selected) {
    const rel = relPath(skill.name)
    if (present.get(rel) === desired.get(rel)) {
      mounted.push(skill)
      continue
    }
    const dir = shq(`${SKILLS_DIR}/${skill.name}`)
    const file = shq(`${SKILLS_DIR}/${rel}`)
    const b64 = Buffer.from(skill.content, 'utf8').toString('base64')
    const wrote = await bash(
      transport,
      `rm -f -- ${file} && mkdir -p -- ${dir} && printf '%s' '${b64}' | base64 -d > ${file}`,
    )
    if (wrote.ok) mounted.push(skill)
    else skipped.push({ name: skill.name, error: wrote.stderr || `exit ${wrote.code}` })
  }
  return { mounted, skipped, ...(removalError ? { removalError } : {}) }
}

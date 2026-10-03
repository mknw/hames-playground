/**
 * Parse and validate an uploaded `SKILL.md` (#415) — pure, no I/O.
 *
 * The format is agentskills.io's (https://agentskills.io/specification, read
 * 2026-10-03): YAML frontmatter between two `---` lines, then a Markdown body.
 * The frontmatter is held to the specification's field table exactly, and
 * anything outside it is REFUSED with a message that names the problem, rather
 * than repaired or dropped — the stored file is what the author wrote, and it
 * is what lands in every sandbox that mounts it.
 *
 *   - `name` (required): 1–64 characters; lowercase `a-z`, `0-9` and `-` only;
 *     no leading or trailing hyphen; no `--`. The "must match the parent
 *     directory name" rule is satisfied by construction: the sandbox creates
 *     the directory FROM the name (`/skills/<name>/SKILL.md`).
 *   - `description` (required): 1–1024 characters, non-empty. Counted in
 *     Unicode code points. A whitespace-only value is refused as empty.
 *   - `license` (optional): a string.
 *   - `compatibility` (optional): 1–500 characters.
 *   - `metadata` (optional): a map of string keys to string values.
 *   - `allowed-tools` (optional, experimental): a string. Stored with the file
 *     and interpreted by nothing — it never widens what a sandbox may run.
 *   - any other field: refused. The reference validator (`skills-ref`) refuses
 *     the same set.
 *
 * The body is text and nothing else: no format rules (the specification has
 * none), but no NUL byte either, and nothing in it is ever resolved — no link
 * is fetched, no relative path is read.
 *
 * Hardening on the YAML itself: one document only, unique keys, and no aliases
 * (an alias is how a few bytes of YAML expand into gigabytes). Parser warnings
 * — an unresolvable custom tag, say — are refused like errors, since the value
 * the author meant is then unknowable.
 *
 * Size is checked FIRST, before any normalising or parsing, against the
 * sandbox's own per-file cap, so the stored file always fits the write path
 * (`SKILL_FILE_MAX_BYTES` in `@hames-ai/sandbox/skills` has the reason). Line
 * endings are normalised to `\n` and a byte-order mark is dropped; that is the
 * only change made to what was uploaded.
 *
 * Client-safe on purpose (no `node:` import), but the server is where it runs:
 * the upload action calls it, and a browser that skipped it changes nothing.
 */
import { parseDocument } from 'yaml'
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  isSkillName,
} from '@hames-ai/sandbox/skills'

/** The specification's bound, owned by the sandbox package, which enforces it
 *  again on what it mounts — one number, so the two checks cannot disagree. */
export { SKILL_DESCRIPTION_MAX_CHARS }
export const SKILL_COMPATIBILITY_MAX_CHARS = 500

/** The specification's frontmatter fields — the whole set. */
export const SKILL_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
] as const

export interface ParsedSkillFile {
  name: string
  description: string
  /** The whole file as stored and mounted, frontmatter included. */
  content: string
}

export type SkillFileResult = { ok: true; skill: ParsedSkillFile } | { ok: false; error: string }

const fail = (error: string): SkillFileResult => ({ ok: false, error })

/** UTF-8 byte length without `node:buffer`. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Unicode code points — what "characters" means in the specification. */
const chars = (text: string): number => [...text].length

/** The specific reason a `name` fails the rule, for the error message. */
function nameProblem(name: string): string {
  const length = chars(name)
  if (length < 1 || length > SKILL_NAME_MAX_LENGTH) {
    return `must be 1-${SKILL_NAME_MAX_LENGTH} characters (it is ${length})`
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return 'may contain only lowercase letters a-z, digits 0-9 and hyphens'
  }
  if (name.startsWith('-') || name.endsWith('-')) return 'must not start or end with a hyphen'
  return 'must not contain consecutive hyphens (--)'
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype

/** Validate an uploaded `SKILL.md`. */
export function parseSkillFile(raw: unknown): SkillFileResult {
  if (typeof raw !== 'string') return fail('A skill must be uploaded as a text file.')
  const bytes = utf8Bytes(raw)
  if (bytes > SKILL_FILE_MAX_BYTES) {
    return fail(
      `SKILL.md is ${bytes.toLocaleString('en')} bytes; the limit is ` +
        `${SKILL_FILE_MAX_BYTES.toLocaleString('en')} bytes (64 KiB).`,
    )
  }
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (content.includes('\u0000')) {
    return fail('SKILL.md contains a NUL byte. A skill must be a text file.')
  }

  const lines = content.split('\n')
  if (lines[0].trimEnd() !== '---') {
    return fail('SKILL.md must begin with YAML frontmatter: its first line must be "---".')
  }
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
  if (close === -1) {
    return fail('The frontmatter is not closed: add a line "---" after the last field.')
  }

  const doc = parseDocument(lines.slice(1, close).join('\n'), {
    uniqueKeys: true,
    schema: 'core',
    prettyErrors: false,
  })
  const problem = doc.errors[0] ?? doc.warnings[0]
  if (problem) return fail(`The frontmatter is not valid YAML: ${problem.message}`)
  let fm: unknown
  try {
    fm = doc.toJS({ maxAliasCount: 0 })
  } catch {
    return fail('The frontmatter uses a YAML alias (*name). Aliases are not allowed.')
  }
  if (!isPlainObject(fm)) {
    return fail('The frontmatter must be a set of "field: value" lines.')
  }

  const unknown = Object.keys(fm).filter((k) => !(SKILL_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    return fail(
      `The frontmatter has field${unknown.length === 1 ? '' : 's'} the Agent Skills ` +
        `specification does not define: ${unknown.join(', ')}. ` +
        `Allowed: ${SKILL_FIELDS.join(', ')}.`,
    )
  }

  const { name, description, license, compatibility, metadata } = fm
  if (name === undefined) return fail('The frontmatter needs a "name".')
  if (typeof name !== 'string') return fail('"name" must be a string.')
  if (!isSkillName(name)) return fail(`"name" ${nameProblem(name)}.`)

  if (description === undefined) return fail('The frontmatter needs a "description".')
  if (typeof description !== 'string') return fail('"description" must be a string.')
  if (description.trim() === '') return fail('"description" must not be empty.')
  if (chars(description) > SKILL_DESCRIPTION_MAX_CHARS) {
    return fail(
      `"description" must be at most ${SKILL_DESCRIPTION_MAX_CHARS} characters ` +
        `(it is ${chars(description)}).`,
    )
  }

  if (license !== undefined && typeof license !== 'string') {
    return fail('"license" must be a string.')
  }
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string') return fail('"compatibility" must be a string.')
    const n = chars(compatibility)
    if (n < 1 || n > SKILL_COMPATIBILITY_MAX_CHARS) {
      return fail(
        `"compatibility" must be 1-${SKILL_COMPATIBILITY_MAX_CHARS} characters (it is ${n}).`,
      )
    }
  }
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) return fail('"metadata" must be a map of keys to values.')
    const bad = Object.entries(metadata).find(([, v]) => typeof v !== 'string')
    if (bad) {
      return fail(`"metadata" values must be strings; "${bad[0]}" is not (quote it, e.g. "1.0").`)
    }
  }
  if (fm['allowed-tools'] !== undefined && typeof fm['allowed-tools'] !== 'string') {
    return fail('"allowed-tools" must be a space-separated string.')
  }

  return { ok: true, skill: { name, description, content } }
}

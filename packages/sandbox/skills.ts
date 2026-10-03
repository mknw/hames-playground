/**
 * Skills in the sandbox — the pure half (#415).
 *
 * A skill is an agentskills.io `SKILL.md`: YAML frontmatter with a `name` and a
 * `description`, then Markdown instructions. `withSandbox({ skills })` writes the
 * skills a host resolves for a run into the container as
 * `/skills/<name>/SKILL.md` (`skills.server.ts`), and shows the model a short
 * index of them — name and description only. The actor reads a file only when a
 * task matches its description. That is the specification's progressive
 * disclosure: metadata always, the body on activation.
 *
 * ## Where the index goes, and why not the tool catalog
 *
 * It rides the sandbox's scoped transport as `promptContext` (core's
 * `ToolTransport`), which the adapters render in the request's `user`-role
 * CONTEXT block. It used to be appended to `sandbox_bash`'s description, and
 * review of #423 found two defects in that: the catalog renders each tool as
 * `- name: description` followed by its `Args:` line, so a skill line had the
 * catalog's own entry shape and `sandbox_bash`'s argument schema landed under
 * the LAST skill — a skill read like a tool; and the actor's catalog sits in
 * its `system` message, so a description another user wrote rode with the
 * deployment's own instructions on every call. Now the tool list is the
 * transport's own, byte for byte, and the index is a delimited `<skills>`
 * block whose every value is escaped, so no description can close it or open
 * a tag of its own.
 *
 * ## What the package owns, and what the host does
 *
 * The host decides WHICH skills a run gets — its storage, its owner scoping, its
 * sharing rules. The package owns what it writes into a container and into the
 * prompt, so it enforces the rules that keep both bounded whatever the host
 * passes: a name that is safe as a directory (the specification's own name rule,
 * which admits no `/`, `.` or leading `-`), a description within the
 * specification's 1–1024 characters (it is shown on every model call of the
 * run), a per-file byte cap the write path can carry, and a ceiling on how
 * many skills one run mounts.
 *
 * Client-safe on purpose — types and constants only, no `node:` imports and no
 * server assertion — so a host's browser code can read the same limits it is
 * held to (the app's Skills panel pre-checks an upload against
 * {@link SKILL_FILE_MAX_BYTES}).
 */

/** Where skills are mounted. A `noexec` tmpfs of its own (see the Docker
 *  backend's hardening argv): the root filesystem is read-only. */
export const SKILLS_DIR = '/skills'

/** The one file v1 mounts per skill. */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Largest `SKILL.md` the package mounts, in UTF-8 bytes (64 KiB).
 *
 * Bounded by the write path, not only by taste: the file crosses into the
 * container base64-encoded inside ONE `bash -lc` argument, and Linux caps a
 * single argument at 128 KiB (`MAX_ARG_STRLEN`). 64 KiB encodes to ~87 KiB, so
 * it fits with room for the command around it; raising this past ~95 KiB breaks
 * every write. The specification recommends far less — a body under 5 000
 * tokens and 500 lines — so this is a ceiling, not a target.
 */
export const SKILL_FILE_MAX_BYTES = 64 * 1024

/** Most skills one run mounts. Every mounted skill costs its index line on
 *  every model call of the run, so the index — not the container — is what
 *  this bounds: at the description cap of 1 024 characters, 20 lines is about
 *  5 000 tokens in the worst case. */
export const MAX_MOUNTED_SKILLS = 20

/** The specification's `name` length bound. */
export const SKILL_NAME_MAX_LENGTH = 64

/** The specification's `description` bound, in characters (Unicode code
 *  points): 1–1024. The package enforces it because every mounted skill's
 *  description is in every model call of the run. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024

/** Whether `description` is within the specification's bound: a string of
 *  1–{@link SKILL_DESCRIPTION_MAX_CHARS} characters that is not blank. */
export function isSkillDescription(description: unknown): description is string {
  return (
    typeof description === 'string' &&
    description.trim() !== '' &&
    [...description].length <= SKILL_DESCRIPTION_MAX_CHARS
  )
}

/**
 * The specification's `name` rule: 1–64 characters, lowercase ASCII letters,
 * digits and single hyphens, no leading or trailing hyphen. The same rule makes
 * the name safe as a directory, which is why the package re-checks it.
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `name` satisfies the specification's `name` rule. */
export function isSkillName(name: unknown): name is string {
  return (
    typeof name === 'string' && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_RE.test(name)
  )
}

/** One skill to mount, as a host hands it to `withSandbox({ skills })`. */
export interface SandboxSkill {
  /** Directory name under {@link SKILLS_DIR}; must pass {@link isSkillName}. */
  name: string
  /** The frontmatter `description` — the skill's one line in the index. */
  description: string
  /** The whole `SKILL.md` as UTF-8 text, frontmatter included. */
  content: string
  /**
   * True when another user wrote it (a skill shared with this run's user).
   * The index marks such a line `(shared)`, so the model can tell the user's
   * own instructions from instructions someone else published.
   */
  shared?: boolean
}

/**
 * Resolves the skills for ONE run. A function, not a list, for the reason
 * `WithSandboxConfig.tenantId` is one: a host builds its patterns once per
 * conversation, while the user and their skills are known only inside a turn.
 */
export type SandboxSkillsResolver = () => readonly SandboxSkill[] | Promise<readonly SandboxSkill[]>

/** The tool a skill is mounted and read with. A sandbox without it gets none. */
export const SKILLS_INDEX_TOOL = 'sandbox_bash'

/** Escape text for an XML-ish element body or attribute: after this, a value
 *  cannot close the `<skills>` block, open a tag, or end its attribute. */
function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The index for the skills that were actually mounted, or `undefined` when
 * there are none (so a run without skills renders no index at all).
 *
 * A `<skills>` block of one `<skill>` element per skill, so it cannot be
 * mistaken for the tool catalog's `- name: description` entries, and every
 * value escaped ({@link escapeMarkup}) so a description cannot end it early.
 * The header says what the block is and that a `shared` skill was written by
 * someone other than the user the agent is working for.
 */
export function renderSkillsIndex(
  skills: ReadonlyArray<Pick<SandboxSkill, 'name' | 'description' | 'shared'>>,
): string | undefined {
  if (skills.length === 0) return undefined
  const entries = skills.map(
    (s) =>
      `<skill name="${escapeMarkup(s.name)}"${s.shared ? ' shared="true"' : ''}>` +
      `${escapeMarkup(oneLine(s.description))}</skill>`,
  )
  return [
    '<skills>',
    `The sandbox has ${skills.length} skill${skills.length === 1 ? '' : 's'} installed under ` +
      `${SKILLS_DIR}: each is a ${SKILL_FILE_NAME} of instructions for the kind of task its ` +
      `description names. This list is not a tool. When the task in front of you matches a ` +
      `description, read that file first with ${SKILLS_INDEX_TOOL} ` +
      `(cat ${SKILLS_DIR}/<name>/${SKILL_FILE_NAME}). A skill marked shared="true" was ` +
      `written by another user of this app, not by the user you are working for.`,
    ...entries,
    '</skills>',
  ].join('\n')
}

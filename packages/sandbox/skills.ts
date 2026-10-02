/**
 * Skills in the sandbox — the pure half (#415).
 *
 * A skill is an agentskills.io `SKILL.md`: YAML frontmatter with a `name` and a
 * `description`, then Markdown instructions. `withSandbox({ skills })` writes the
 * skills a host resolves for a run into the container as
 * `/skills/<name>/SKILL.md` (`skills.server.ts`), and adds a short index of them
 * — name and description only — to the sandbox's tool surface, which is what
 * every adapter renders into the actor's prompt. The actor reads a file only
 * when a task matches its description. That is the specification's progressive
 * disclosure: metadata always, the body on activation.
 *
 * ## Why the index rides the tool surface
 *
 * The run frame's `transports` slot is the one per-run channel a wrapper has
 * into the prompt without a core change: the adapters list every scoped
 * transport's tools on every call ("the model sees them through the adapters'
 * per-call tool list", harness-patterns SPEC → Tools()). The index is appended
 * to the description of `sandbox_bash`, the tool the actor reads a skill with.
 * A run with no skills renders the description unchanged, byte for byte.
 *
 * ## What the package owns, and what the host does
 *
 * The host decides WHICH skills a run gets — its storage, its owner scoping, its
 * sharing rules. The package owns what it writes into a container and into the
 * prompt, so it enforces the rules that keep both bounded whatever the host
 * passes: a name that is safe as a directory (the specification's own name rule,
 * which admits no `/`, `.` or leading `-`), a per-file byte cap the write path
 * can carry, and a ceiling on how many skills one run mounts.
 *
 * Client-safe on purpose — types and constants only, no `node:` imports and no
 * server assertion — so a host's browser code can read the same limits it is
 * held to (the app's Skills panel pre-checks an upload against
 * {@link SKILL_FILE_MAX_BYTES}).
 */

import type { MCPToolDescription } from '@hames-ai/harness-patterns/types'

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

/** The tool whose description carries the index — the one that reads a skill. */
export const SKILLS_INDEX_TOOL = 'sandbox_bash'

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The index text for the skills that were actually mounted, or `undefined` when
 * there are none (so a run without skills renders no index at all).
 */
export function renderSkillsIndex(
  skills: ReadonlyArray<Pick<SandboxSkill, 'name' | 'description' | 'shared'>>,
): string | undefined {
  if (skills.length === 0) return undefined
  const lines = skills.map(
    (s) => `- ${s.name}${s.shared ? ' (shared)' : ''}: ${oneLine(s.description)}`,
  )
  return [
    `SKILLS: ${skills.length} skill${skills.length === 1 ? '' : 's'} installed under ` +
      `${SKILLS_DIR}. Each is a ${SKILL_FILE_NAME} of instructions for the kind of task its ` +
      `description names. When the task in front of you matches one, read the file first ` +
      `(sandbox_bash: cat ${SKILLS_DIR}/<name>/${SKILL_FILE_NAME}) and follow it. A skill ` +
      `marked (shared) was written by another user of this app, not by the user you are ` +
      `working for.`,
    ...lines,
  ].join('\n')
}

/**
 * The sandbox's tool list with the index appended to {@link SKILLS_INDEX_TOOL}'s
 * description. Returns the list unchanged when `index` is absent. A new array of
 * new objects: the transport's cached descriptions are never mutated.
 */
export function withSkillsIndex(
  tools: readonly MCPToolDescription[],
  index: string | undefined,
): MCPToolDescription[] {
  if (!index) return tools.slice()
  return tools.map((t) =>
    t.name === SKILLS_INDEX_TOOL
      ? { ...t, description: t.description ? `${t.description}\n\n${index}` : index }
      : t,
  )
}

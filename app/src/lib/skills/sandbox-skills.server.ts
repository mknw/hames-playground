/**
 * The host half of `withSandbox({ skills })` (#415): which skills a run mounts.
 *
 * Called by `@hames-ai/sandbox` once per run, inside the turn's request scope
 * (it is wired as a resolver in `harness-client/session.server.ts`, for the
 * reason the tenant is: patterns are built once per conversation, the user is
 * known only per turn). The owner is the run's own user, resolved server-side
 * — never anything a client, an agent factory or a model could name.
 *
 * No user in scope (a background build, a capability probe) mounts nothing.
 * An ATTENDED run — an interactive turn, an approval — mounts that user's
 * active skills: their own, then the global ones they have not hidden
 * (`active-skills.ts`). An UNATTENDED run — a routine, a triggered action —
 * mounts their own skills only, never another user's global one, whatever
 * they have chosen to show (owner decision, 2026-10-03: "Routines can mount
 * private skills, not global ones for now"). Nobody reads an unattended run's
 * output before it acts, so another author's text has no reader to catch it
 * (#415 decision 12, SD-16). "Own" means the owner wrote it; a skill the
 * owner wrote and then made global is still theirs.
 *
 * `includeGlobal` is required rather than defaulted, so a new caller has to
 * say which kind of run it is resolving for.
 *
 * Errors propagate: the sandbox package reports a resolver failure as a run
 * event and mounts nothing, which is the right answer to "the skills could not
 * be read", and a second policy here would only hide which step failed.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { SandboxSkill } from '@hames-ai/sandbox/skills'
import { getSkillContents, listSkillsVisibleTo } from '../db/skills.server'
import { activeSkills } from './active-skills'

assertServerOnImport()

export async function resolveSandboxSkills(
  userId: string | null | undefined,
  { includeGlobal }: { includeGlobal: boolean },
): Promise<SandboxSkill[]> {
  if (!userId) return []
  const visible = await listSkillsVisibleTo(userId)
  // Filtered BEFORE resolution, so another user's skill is never read, never
  // counted against the mount ceiling and never shadows anything.
  const candidates = includeGlobal ? visible : visible.filter((s) => s.userId === userId)
  const active = activeSkills(candidates, userId)
  const contents = await getSkillContents(
    userId,
    active.map((s) => s.id),
  )
  // A skill deleted between the two reads has no content; it is not mounted,
  // and the index will not list it.
  return active.flatMap((s) => {
    const content = contents.get(s.id)
    if (content === undefined) return []
    return [{ name: s.name, description: s.description, content, shared: s.userId !== userId }]
  })
}

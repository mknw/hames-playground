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
 * Every run with a user — an interactive turn, a routine, a triggered action —
 * mounts that user's active skills: their own, then the global ones they have
 * not hidden (`active-skills.ts`).
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
): Promise<SandboxSkill[]> {
  if (!userId) return []
  const active = activeSkills(await listSkillsVisibleTo(userId), userId)
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

/**
 * Which of the skills a user can see are ACTIVE — mounted in their sandbox —
 * and why each of the others is not (#415). Pure, so the sandbox and the Skills
 * panel ask the same function and cannot disagree about what is mounted.
 *
 * Active means: the user's own skills, then other users' global skills the
 * user has not hidden, in that order and oldest first within each group, one
 * skill per name (the first wins — so a user's own skill always beats a global
 * one of the same name, and an established global beats a newer namesake),
 * and at most `MAX_MOUNTED_SKILLS` in all. That ceiling is the sandbox
 * package's, which enforces it again on its side; applying it here as well is
 * what lets the panel say which skills did not fit instead of the sandbox
 * silently dropping them.
 */
import { MAX_MOUNTED_SKILLS } from '@hames-ai/sandbox/skills'

/** Why a visible skill is or is not in the sandbox. */
export type SkillMountStatus =
  /** Mounted at `/skills/<name>/SKILL.md` and listed in the actor's index. */
  | 'mounted'
  /** Another user's global skill this user hid. */
  | 'hidden'
  /** Another skill of the same name is mounted instead. */
  | 'shadowed'
  /** The sandbox's ceiling was reached before this skill. */
  | 'over-limit'

/** The fields resolution reads — a subset of the repository's record. */
export interface VisibleSkill {
  id: string
  userId: string
  name: string
  hidden: boolean
  createdAt: Date
}

/** Resolve every visible skill's status, preserving the input array. */
export function resolveSkillStatuses<S extends VisibleSkill>(
  skills: readonly S[],
  viewerId: string,
): Map<string, SkillMountStatus> {
  const byAge = (a: S, b: S) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const own = skills.filter((s) => s.userId === viewerId).sort(byAge)
  const shared = skills.filter((s) => s.userId !== viewerId).sort(byAge)

  const status = new Map<string, SkillMountStatus>()
  const names = new Set<string>()
  let mounted = 0
  for (const s of [...own, ...shared]) {
    if (s.userId !== viewerId && s.hidden) status.set(s.id, 'hidden')
    else if (names.has(s.name)) status.set(s.id, 'shadowed')
    else if (mounted >= MAX_MOUNTED_SKILLS) status.set(s.id, 'over-limit')
    else {
      names.add(s.name)
      mounted++
      status.set(s.id, 'mounted')
    }
  }
  return status
}

/** The active skills, in mount order. */
export function activeSkills<S extends VisibleSkill>(skills: readonly S[], viewerId: string): S[] {
  const status = resolveSkillStatuses(skills, viewerId)
  const order = [...status.keys()]
  const byId = new Map(skills.map((s) => [s.id, s]))
  return order.filter((id) => status.get(id) === 'mounted').map((id) => byId.get(id)!)
}

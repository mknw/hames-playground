/**
 * Which visible skills a user's sandbox mounts (#415) — the one rule the
 * sandbox resolver and the Skills panel both read.
 */
import { describe, it, expect } from 'vitest'
import { activeSkills, resolveSkillStatuses } from '../../../lib/skills/active-skills'
import { MAX_MOUNTED_SKILLS } from '@hames-ai/sandbox/skills'

const ME = 'user-me'
let clock = 0
const skill = (name: string, userId = ME, extra: { hidden?: boolean; at?: number } = {}) => ({
  id: `${userId}:${name}:${clock}`,
  userId,
  name,
  hidden: extra.hidden ?? false,
  createdAt: new Date(extra.at ?? ++clock * 1000),
})

describe('resolveSkillStatuses', () => {
  it('mounts own skills and other users’ global skills that are not hidden', () => {
    const mine = skill('pdf')
    const theirs = skill('style', 'user-ada')
    const hiddenOne = skill('noisy', 'user-bob', { hidden: true })
    const status = resolveSkillStatuses([mine, theirs, hiddenOne], ME)
    expect(status.get(mine.id)).toBe('mounted')
    expect(status.get(theirs.id)).toBe('mounted')
    expect(status.get(hiddenOne.id)).toBe('hidden')
  })

  it('a user’s own skill beats an OLDER global skill of the same name', () => {
    const olderGlobal = skill('style', 'user-ada', { at: 1 })
    const mine = skill('style', ME, { at: 999_999 })
    const status = resolveSkillStatuses([olderGlobal, mine], ME)
    expect(status.get(mine.id)).toBe('mounted')
    expect(status.get(olderGlobal.id)).toBe('shadowed')
  })

  it('between two global skills of one name, the older one is mounted', () => {
    const newer = skill('style', 'user-bob', { at: 50 })
    const older = skill('style', 'user-ada', { at: 10 })
    const status = resolveSkillStatuses([newer, older], ME)
    expect(status.get(older.id)).toBe('mounted')
    expect(status.get(newer.id)).toBe('shadowed')
  })

  it('a hidden skill does not take its name: the next one of that name mounts', () => {
    const hiddenOlder = skill('style', 'user-ada', { hidden: true, at: 1 })
    const newer = skill('style', 'user-bob', { at: 2 })
    const status = resolveSkillStatuses([hiddenOlder, newer], ME)
    expect(status.get(hiddenOlder.id)).toBe('hidden')
    expect(status.get(newer.id)).toBe('mounted')
  })

  it('ignores a hide flag on the user’s own skill (a user cannot hide what they wrote)', () => {
    const mine = { ...skill('pdf'), hidden: true }
    expect(resolveSkillStatuses([mine], ME).get(mine.id)).toBe('mounted')
  })

  it(`mounts at most ${MAX_MOUNTED_SKILLS}: own skills first, then globals oldest first`, () => {
    const own = Array.from({ length: 5 }, (_, i) => skill(`own-${i}`))
    const globals = Array.from({ length: MAX_MOUNTED_SKILLS }, (_, i) =>
      skill(`g-${i}`, 'user-ada', { at: i + 1 }),
    )
    const status = resolveSkillStatuses([...globals, ...own], ME)
    for (const s of own) expect(status.get(s.id)).toBe('mounted')
    const mountedGlobals = globals.filter((g) => status.get(g.id) === 'mounted')
    expect(mountedGlobals).toEqual(globals.slice(0, MAX_MOUNTED_SKILLS - own.length))
    expect(globals.slice(MAX_MOUNTED_SKILLS - own.length).map((g) => status.get(g.id))).toEqual(
      Array(own.length).fill('over-limit'),
    )
  })
})

describe('activeSkills', () => {
  it('returns the mounted skills in mount order: own, then global, oldest first', () => {
    const g2 = skill('g2', 'user-ada', { at: 20 })
    const g1 = skill('g1', 'user-bob', { at: 10 })
    const own = skill('own', ME, { at: 30 })
    const hidden = skill('h', 'user-bob', { hidden: true, at: 5 })
    expect(activeSkills([g2, hidden, own, g1], ME).map((s) => s.name)).toEqual(['own', 'g1', 'g2'])
  })
})

/**
 * `resolveSandboxSkills` — what `withSandbox({ skills })` is handed for a run
 * (#415). The repository is stubbed: this is the host's policy, not its SQL.
 *
 * `includeGlobal` is the attended/unattended split (owner decision 2026-10-03:
 * "Routines can mount private skills, not global ones for now"). Which runs
 * pass which is `agentDeps()`'s business, pinned in `agent-deps-seam.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const repo = vi.hoisted(() => ({
  listSkillsVisibleTo: vi.fn(),
  getSkillContents: vi.fn(),
}))
vi.mock('../../../lib/db/skills.server', () => repo)

const { resolveSandboxSkills } = await import('../../../lib/skills/sandbox-skills.server')

const ATTENDED = { includeGlobal: true }
const UNATTENDED = { includeGlobal: false }

const row = (id: string, userId: string, name: string, extra: { hidden?: boolean } = {}) => ({
  id,
  userId,
  name,
  description: `Use for ${name}.`,
  isGlobal: userId !== 'me',
  hidden: extra.hidden ?? false,
  createdAt: new Date(Number(id.replace(/\D/g, '')) * 1000),
  updatedAt: new Date(0),
})

beforeEach(() => {
  repo.listSkillsVisibleTo.mockReset()
  repo.getSkillContents.mockReset()
})

describe('resolveSandboxSkills', () => {
  it('mounts nothing, and reads nothing, when no user is in scope', async () => {
    expect(await resolveSandboxSkills(null, ATTENDED)).toEqual([])
    expect(await resolveSandboxSkills(undefined, ATTENDED)).toEqual([])
    expect(repo.listSkillsVisibleTo).not.toHaveBeenCalled()
  })

  it('asks for the RUN’s user, and hands the package the active skills with their files', async () => {
    repo.listSkillsVisibleTo.mockResolvedValue([
      row('s3', 'ada', 'style'),
      row('s1', 'me', 'pdf'),
      row('s2', 'bob', 'noisy', { hidden: true }),
    ])
    repo.getSkillContents.mockResolvedValue(
      new Map([
        ['s1', 'PDF FILE'],
        ['s3', 'STYLE FILE'],
      ]),
    )

    const skills = await resolveSandboxSkills('me', ATTENDED)

    expect(repo.listSkillsVisibleTo).toHaveBeenCalledWith('me')
    // Only the active ones' files are read — never a hidden skill's.
    expect(repo.getSkillContents).toHaveBeenCalledWith('me', ['s1', 's3'])
    expect(skills).toEqual([
      { name: 'pdf', description: 'Use for pdf.', content: 'PDF FILE', shared: false },
      { name: 'style', description: 'Use for style.', content: 'STYLE FILE', shared: true },
    ])
  })

  it('leaves out a skill deleted between the two reads', async () => {
    repo.listSkillsVisibleTo.mockResolvedValue([row('s1', 'me', 'pdf'), row('s2', 'me', 'gone')])
    repo.getSkillContents.mockResolvedValue(new Map([['s1', 'PDF FILE']]))
    expect((await resolveSandboxSkills('me', ATTENDED)).map((s) => s.name)).toEqual(['pdf'])
  })

  it('lets a repository failure propagate — the sandbox reports it and mounts nothing', async () => {
    repo.listSkillsVisibleTo.mockRejectedValue(new Error('db down'))
    await expect(resolveSandboxSkills('me', ATTENDED)).rejects.toThrow('db down')
  })
})

describe('resolveSandboxSkills — an unattended run (a routine, a triggered action)', () => {
  // The same visible set as the attended case above, plus the owner's OWN
  // skill made global: what the owner wrote is theirs whatever its flag says.
  const visible = () => [
    row('s3', 'ada', 'style'),
    row('s1', 'me', 'pdf'),
    { ...row('s4', 'me', 'shared-by-me'), isGlobal: true },
    row('s2', 'bob', 'noisy', { hidden: true }),
  ]

  it('mounts only the owner’s own skills, and never reads another user’s file', async () => {
    repo.listSkillsVisibleTo.mockResolvedValue(visible())
    repo.getSkillContents.mockResolvedValue(
      new Map([
        ['s1', 'PDF FILE'],
        ['s4', 'MINE FILE'],
      ]),
    )

    const skills = await resolveSandboxSkills('me', UNATTENDED)

    // `ada`'s global `style` is visible and not hidden — an attended run
    // mounts it — and it is still not read, let alone mounted.
    expect(repo.getSkillContents).toHaveBeenCalledWith('me', ['s1', 's4'])
    expect(skills).toEqual([
      { name: 'pdf', description: 'Use for pdf.', content: 'PDF FILE', shared: false },
      {
        name: 'shared-by-me',
        description: 'Use for shared-by-me.',
        content: 'MINE FILE',
        shared: false,
      },
    ])
  })

  it('mounts nothing when the owner has no skills of their own', async () => {
    repo.listSkillsVisibleTo.mockResolvedValue([row('s3', 'ada', 'style')])
    repo.getSkillContents.mockResolvedValue(new Map())

    expect(await resolveSandboxSkills('me', UNATTENDED)).toEqual([])
    expect(repo.getSkillContents).toHaveBeenCalledWith('me', [])
  })
})

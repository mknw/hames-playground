/**
 * SkillsPanel — the Sandbox tab's Skills section (#415).
 *
 * The six server actions are stubbed over an in-memory list; what is under
 * test is the panel's own contract: an Ark Tree View with the two groups the
 * owner asked for ("My skills" and "Global"), the per-skill actions each group
 * gets — and only that group — the two confirmations, upload by file, and the
 * file shown as TEXT, never rendered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillView } from '../../../lib/skills/actions.server'

const actions = vi.hoisted(() => ({
  listSkills: vi.fn(),
  uploadSkill: vi.fn(),
  setSkillGlobal: vi.fn(),
  setSkillHidden: vi.fn(),
  deleteSkill: vi.fn(),
  getSkillContent: vi.fn(),
}))
vi.mock('~/lib/skills/actions.server', () => actions)

const { render, fireEvent, waitFor, screen } = await import('@solidjs/testing-library')
const { SkillsPanel, buildSkillTree, statusText } =
  await import('../../../components/ark-ui/SkillsPanel')

const id = (n: number) => `skill-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const view = (over: Partial<SkillView>): SkillView => ({
  id: id(1),
  name: 'pdf-processing',
  description: 'Extract PDF text.',
  mine: true,
  isGlobal: false,
  hidden: false,
  status: 'mounted',
  author: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  ...over,
})

let store: SkillView[] = []
beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset()
  store = [
    view({}),
    view({ id: id(2), name: 'house-style', mine: false, isGlobal: true, author: 'Ada Lovelace' }),
    view({
      id: id(3),
      name: 'muted',
      mine: false,
      isGlobal: true,
      hidden: true,
      status: 'hidden',
      author: 'Grace Hopper',
    }),
  ]
  actions.listSkills.mockImplementation(async () => store)
  actions.getSkillContent.mockImplementation(async (skillId: string) =>
    skillId === id(1)
      ? '---\nname: pdf-processing\n---\n<img src="https://x.test/a.png"> body'
      : 'x',
  )
  actions.setSkillGlobal.mockResolvedValue({ ok: true })
  actions.setSkillHidden.mockResolvedValue({ ok: true })
  actions.deleteSkill.mockResolvedValue({ ok: true })
})

/** Leaf rows only — a branch is a `treeitem` too, and it CONTAINS its leaves' text. */
const items = () => [
  ...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-part="item"]'),
]
const item = (text: string) => items().find((el) => el.textContent?.includes(text))!
const button = (name: string) => screen.getByRole('button', { name })
const queryButton = (name: string) => screen.queryByRole('button', { name })

async function mount() {
  render(() => <SkillsPanel />)
  await waitFor(() => expect(item('pdf-processing')).toBeTruthy())
}

async function select(text: string) {
  fireEvent.click(item(text))
  await waitFor(() => expect(screen.getByRole('region', { name: new RegExp(text) })).toBeTruthy())
}

describe('SkillsPanel — the tree', () => {
  it('is an Ark Tree View with a "My skills" and a "Global" branch', async () => {
    await mount()
    expect(document.querySelector('[role="tree"]')?.getAttribute('data-scope')).toBe('tree-view')
    const branches = [
      ...document.querySelectorAll('[data-scope="tree-view"][data-part="branch-text"]'),
    ].map((el) => el.textContent)
    expect(branches).toEqual(['My skills', 'Global'])
    // Own skills under the first branch, other users' global skills under the second.
    const [mine, global] = [
      ...document.querySelectorAll<HTMLElement>('[data-scope="tree-view"][data-part="branch"]'),
    ]
    expect(mine.textContent).toContain('pdf-processing')
    expect(mine.textContent).not.toContain('house-style')
    expect(global.textContent).toContain('house-style')
    expect(global.textContent).toContain('by Ada Lovelace')
    // A hidden global skill stays listed — that is where it is unhidden from.
    expect(global.textContent).toContain('muted')
    expect(item('muted').textContent).toContain('hidden')
  })

  it('shows a disabled placeholder row in an empty group', async () => {
    store = []
    render(() => <SkillsPanel />)
    await waitFor(() => expect(items()).toHaveLength(2))
    expect(items().map((el) => el.textContent)).toEqual([
      'No skills yet — upload a SKILL.md',
      'No global skills from other users',
    ])
    expect(items().every((el) => el.getAttribute('aria-disabled') === 'true')).toBe(true)
  })

  it('builds the tree from the list, mine then global', () => {
    const tree = buildSkillTree(store)
    expect(tree.children!.map((g) => [g.label, g.children!.map((c) => c.label)])).toEqual([
      ['My skills', ['pdf-processing']],
      ['Global', ['house-style', 'muted']],
    ])
  })
})

describe('SkillsPanel — a selected skill', () => {
  it('shows its file as TEXT: nothing in it is rendered', async () => {
    await mount()
    await select('pdf-processing')
    const pre = await screen.findByLabelText('SKILL.md')
    expect(pre.textContent).toContain('<img src="https://x.test/a.png"> body')
    expect(document.querySelector('img')).toBeNull()
    expect(actions.getSkillContent).toHaveBeenCalledWith(id(1))
  })

  it('says why a skill is not mounted', () => {
    expect(statusText(view({ status: 'shadowed' }))).toContain('another skill named')
    expect(statusText(view({ status: 'over-limit' }))).toContain('at most 20 skills')
    expect(statusText(view({ status: 'hidden' }))).toContain('Hidden')
    expect(statusText(view({}))).toContain('/skills/pdf-processing/SKILL.md')
  })

  // Owner decision 2026-10-03: routines and triggered runs mount the owner's
  // own skills only. The panel says so where it would otherwise claim another
  // user's skill is simply "mounted".
  it('says another user’s mounted skill stays out of routines and triggered runs', () => {
    const shared = statusText(view({ mine: false, isGlobal: true, author: 'Ada' }))
    expect(shared).toContain('/skills/pdf-processing/SKILL.md')
    expect(shared).toContain('except in routines and triggered runs')
    expect(statusText(view({ mine: true, isGlobal: true }))).not.toContain('routines')
  })
})

describe('SkillsPanel — actions', () => {
  it('own skill: making it global takes a confirmation, then calls the action', async () => {
    await mount()
    await select('pdf-processing')
    expect(queryButton('Hide')).toBeNull() // a user does not hide their own skill

    fireEvent.click(button('Make global'))
    expect(actions.setSkillGlobal).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Every other user’s sandbox will mount this skill')

    fireEvent.click(button('Confirm: Make global'))
    await waitFor(() => expect(actions.setSkillGlobal).toHaveBeenCalledWith(id(1), true))
    expect(await screen.findByText('"pdf-processing" is now global.')).toBeTruthy()
    expect(actions.listSkills).toHaveBeenCalledTimes(2) // refreshed
  })

  it('own global skill: making it private needs no confirmation', async () => {
    store[0] = view({ isGlobal: true })
    await mount()
    await select('pdf-processing')
    fireEvent.click(button('Make private'))
    await waitFor(() => expect(actions.setSkillGlobal).toHaveBeenCalledWith(id(1), false))
  })

  it('own skill: delete takes a confirmation that states what it does not erase', async () => {
    await mount()
    await select('pdf-processing')
    fireEvent.click(button('Delete'))
    expect(actions.deleteSkill).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('stays in those conversations')

    fireEvent.click(button('Cancel'))
    expect(queryButton('Confirm: Delete')).toBeNull()

    fireEvent.click(button('Delete'))
    store = store.slice(1)
    fireEvent.click(button('Confirm: Delete'))
    await waitFor(() => expect(actions.deleteSkill).toHaveBeenCalledWith(id(1)))
    expect(await screen.findByText('Deleted "pdf-processing".')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
  })

  it('another user’s global skill: hide and unhide, and no author actions', async () => {
    await mount()
    await select('house-style')
    expect(queryButton('Delete')).toBeNull()
    expect(queryButton('Make global')).toBeNull()
    expect(queryButton('Make private')).toBeNull()
    expect(document.body.textContent).toContain('shared by Ada Lovelace')

    fireEvent.click(button('Hide'))
    await waitFor(() => expect(actions.setSkillHidden).toHaveBeenCalledWith(id(2), true))

    await select('muted')
    fireEvent.click(button('Unhide'))
    await waitFor(() => expect(actions.setSkillHidden).toHaveBeenCalledWith(id(3), false))
  })

  it('shows a refused action’s reason', async () => {
    actions.setSkillHidden.mockResolvedValue({ ok: false, error: 'That skill was not found.' })
    await mount()
    await select('house-style')
    fireEvent.click(button('Hide'))
    expect(await screen.findByText('That skill was not found.')).toBeTruthy()
  })
})

describe('SkillsPanel — upload', () => {
  const input = () =>
    document.querySelector<HTMLInputElement>('[data-testid="skill-upload-input"]')!
  /** jsdom's File has no `text()`; a browser's does. */
  const fileOf = (text: string, name: string, type: string) => {
    const file = new File([text], name, { type })
    if (typeof file.text !== 'function') {
      Object.defineProperty(file, 'text', { value: async () => text })
    }
    return file
  }
  const choose = (file: File) => {
    Object.defineProperty(input(), 'files', { value: [file], configurable: true })
    fireEvent.input(input())
  }

  it('sends the chosen file’s text, then lists and selects the new skill', async () => {
    const created = view({ id: id(9), name: 'new-skill' })
    actions.uploadSkill.mockImplementation(async () => {
      store = [...store, created]
      return { ok: true, skill: created }
    })
    await mount()
    const text = '---\nname: new-skill\ndescription: d\n---\nbody\n'
    choose(fileOf(text, 'SKILL.md', 'text/markdown'))

    await waitFor(() => expect(actions.uploadSkill).toHaveBeenCalledWith(text))
    expect(await screen.findByText('Uploaded "new-skill".')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Skill new-skill' })).toBeTruthy(),
    )
  })

  it('shows the server’s validation message when the file is refused', async () => {
    actions.uploadSkill.mockResolvedValue({ ok: false, error: '"name" must be a string.' })
    await mount()
    choose(fileOf('---\nname: 1\n---\n', 'SKILL.md', 'text/markdown'))
    expect(await screen.findByText('"name" must be a string.')).toBeTruthy()
  })

  it('refuses a file over the size cap without sending it', async () => {
    await mount()
    choose(fileOf('x'.repeat(64 * 1024 + 1), 'SKILL.md', 'text/markdown'))
    expect(await screen.findByText(/larger than 64 KiB/)).toBeTruthy()
    expect(actions.uploadSkill).not.toHaveBeenCalled()
  })

  it('refuses a file that is not Markdown without sending it', async () => {
    await mount()
    choose(fileOf('x', 'skill.pdf', 'application/pdf'))
    expect(await screen.findByText('Upload a Markdown file (SKILL.md).')).toBeTruthy()
    expect(actions.uploadSkill).not.toHaveBeenCalled()
  })
})

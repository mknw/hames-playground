/**
 * OrgProposalPrompt — the org-knowledge acceptance card
 * (`docs/plan/org-knowledge-hook.md`, slice 5).
 *
 * The two server actions are stubbed. Under test: the card shows each assertion
 * with its elements, a merge's existing node, a replacement's removed edge and
 * each Fact's evidence span verbatim; nothing is written until Add; what is
 * sent is a choice and one flag per assertion; an acceptance hands its elements
 * to the graph, a discard hands nothing; model text renders as text.
 *
 * Mutations, each verified red:
 * - omit the evidence span → "renders each Fact's evidence span verbatim" goes red.
 * - send every flag true → "an unchecked assertion is sent unchecked" goes red.
 * - call onAccepted on discard → "Discard writes nothing and draws nothing" goes red.
 * - render the name as markup → "model text renders as text" goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listOrgProposals = vi.fn()
const answerOrgProposal = vi.fn()
vi.mock('~/lib/org-graph/confirm-actions.server', () => ({
  listOrgProposals: (s: string) => listOrgProposals(s) as unknown,
  answerOrgProposal: (...a: unknown[]) => answerOrgProposal(...a) as unknown,
}))
// The card reuses the memory prompt's poll cadence; that module's own actions are inert here.
vi.mock('~/lib/memory/confirm-actions.server', () => ({
  listMemoryProposals: async () => [],
  answerMemoryProposal: async () => ({ outcome: 'unavailable' }),
}))

const { render, fireEvent } = await import('@solidjs/testing-library')
const { OrgProposalPrompt } = await import('../../../components/ark-ui/OrgProposalPrompt')

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const view = () => ({
  requestId: 'req-1',
  expiresAt: Date.now() + 60_000,
  items: [
    {
      flag: 'a0',
      elements: [
        {
          kind: 'node',
          label: 'Fact',
          name: 'The Osprey budget is 40,000 euro',
          verdict: 'new',
          evidence: 'The Osprey budget is 40,000 euro',
        },
        {
          kind: 'node',
          label: 'Project',
          name: 'Osprey',
          verdict: 'reinforces',
          existing: 'Osprey',
        },
        {
          kind: 'edge',
          label: 'ABOUT',
          name: 'ABOUT',
          verdict: 'new',
          from: 'The Osprey budget is 40,000 euro',
          to: 'Osprey',
        },
      ],
    },
    {
      flag: 'a1',
      elements: [
        {
          kind: 'node',
          label: 'Member',
          name: 'Tamsin Orrin',
          verdict: 'reinforces',
          existing: 'Tamsin Orrin',
        },
        {
          kind: 'node',
          label: 'Theme',
          name: '<b>Theme 1</b>',
          verdict: 'reinforces',
          existing: '<b>Theme 1</b>',
        },
        {
          kind: 'edge',
          label: 'COORDINATES',
          name: 'COORDINATES',
          verdict: 'new',
          from: 'Tamsin Orrin',
          to: '<b>Theme 1</b>',
          removes: [{ type: 'COORDINATES', from: 'Dorrit Wexley', to: '<b>Theme 1</b>' }],
        },
      ],
    },
  ],
})

async function mount(onAccepted = vi.fn()) {
  listOrgProposals.mockResolvedValue([view()])
  render(() => <OrgProposalPrompt sessionId="conv-1" settledTick={0} onAccepted={onAccepted} />)
  await tick()
  return onAccepted
}

beforeEach(() => {
  listOrgProposals.mockReset()
  answerOrgProposal.mockReset()
  document.body.innerHTML = ''
})

describe('OrgProposalPrompt', () => {
  it('shows nothing without a proposal', async () => {
    listOrgProposals.mockResolvedValue([])
    render(() => <OrgProposalPrompt sessionId="conv-1" settledTick={0} />)
    await tick()
    expect(q('org-proposal-card')).toBeNull()
  })

  it('renders each Fact’s evidence span verbatim', async () => {
    await mount()
    expect(q('org-proposal-evidence')?.textContent).toBe(
      'from your message: “The Osprey budget is 40,000 euro”',
    )
  })

  it('shows each element by class and name with its verdict, and a replacement’s removed edge', async () => {
    await mount()
    const card = q('org-proposal-card')!.textContent!
    expect(card).toContain('Add to Org.graph?')
    expect(card).toContain('Osprey(already in Org.graph)')
    expect(card).toContain('Tamsin Orrin → <b>Theme 1</b>')
    expect(q('org-proposal-removes')?.textContent).toBe(
      'replaces: Dorrit Wexley → <b>Theme 1</b> (COORDINATES)',
    )
  })

  it('model text renders as text, never as markup', async () => {
    await mount()
    expect(q('org-proposal-card')!.querySelector('b')).toBeNull()
  })

  it('an unchecked assertion is sent unchecked, and the accepted graph is handed on', async () => {
    const graph = [{ data: { id: 'f1', label: 'budget', added: true }, source: 'neo4j' }]
    answerOrgProposal.mockResolvedValue({
      outcome: 'added',
      written: 1,
      stale: 0,
      failed: 0,
      keys: {},
      graph,
    })
    listOrgProposals.mockResolvedValueOnce([view()]).mockResolvedValue([])
    const onAccepted = vi.fn()
    render(() => <OrgProposalPrompt sessionId="conv-1" settledTick={0} onAccepted={onAccepted} />)
    await tick()
    const control = q('org-proposal-item-a1')!.querySelector('[data-part="control"]')!
    fireEvent.click(control)
    await tick()
    fireEvent.click(q('org-proposal-add')!)
    await tick()
    expect(answerOrgProposal).toHaveBeenCalledWith('conv-1', 'req-1', {
      choice: 'add',
      flags: { a0: true, a1: false },
    })
    expect(onAccepted).toHaveBeenCalledWith('conv-1', graph)
    expect(q('org-proposal-result')?.textContent).toBe('Added 1 to Org.graph.')
  })

  it('Discard writes nothing and draws nothing', async () => {
    answerOrgProposal.mockResolvedValue({ outcome: 'discarded' })
    const onAccepted = await mount()
    listOrgProposals.mockResolvedValue([])
    fireEvent.click(q('org-proposal-discard')!)
    await tick()
    expect(answerOrgProposal).toHaveBeenCalledWith('conv-1', 'req-1', 'discard')
    expect(onAccepted).not.toHaveBeenCalled()
    expect(q('org-proposal-result')?.textContent).toBe('Nothing was added to Org.graph.')
  })

  it('Add is disabled with nothing checked', async () => {
    await mount()
    for (const flag of ['a0', 'a1'])
      fireEvent.click(q(`org-proposal-item-${flag}`)!.querySelector('[data-part="control"]')!)
    await tick()
    expect((q('org-proposal-add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed write keeps the card and locks the answer for a retry', async () => {
    answerOrgProposal.mockResolvedValue({
      outcome: 'added',
      written: 0,
      stale: 0,
      failed: 1,
      keys: {},
    })
    const onAccepted = await mount()
    fireEvent.click(q('org-proposal-add')!)
    await tick()
    expect(q('org-proposal-card')).not.toBeNull()
    expect((q('org-proposal-discard') as HTMLButtonElement).disabled).toBe(true)
    expect(onAccepted).not.toHaveBeenCalled()
  })
})

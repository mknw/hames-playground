/**
 * Erasing memory reaches EVERY screen surface (#589 F1): the Memory tab, the
 * chat's card/dialog/toast and the header inbox, rendered together with the
 * server actions stubbed. Without advancing any timer, after "Forget
 * everything" is confirmed there is no notice, no dialog and no inbox badge.
 * MUTATION: drop `notifyMemoryErased()` from MemoryPanel's `run` → red.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const mem = vi.hoisted(() => ({
  list: vi.fn(),
  all: vi.fn(),
  set: vi.fn(),
  proposals: vi.fn(),
  inbox: vi.fn(),
}))
vi.mock('../../../lib/memory/actions.server', () => ({
  listMyMemories: mem.list,
  forgetMemory: vi.fn(),
  forgetAllMemories: mem.all,
  setMemoryEnabled: mem.set,
  exportMyMemories: vi.fn(),
}))
vi.mock('~/lib/memory/confirm-actions.server', () => ({
  listMemoryProposals: (s: string) => mem.proposals(s) as unknown,
  answerMemoryProposal: vi.fn(),
  listMemoryInbox: () => mem.inbox() as unknown,
}))
vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }))

const { render, screen, fireEvent, waitFor } = await import('@solidjs/testing-library')
const { MemoryPanel } = await import('../../../components/ark-ui/MemoryPanel')
const { MemoryProposalPrompt } = await import('../../../components/ark-ui/MemoryProposalPrompt')
const { HitlInbox } = await import('../../../components/ark-ui/HitlInbox')

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const proposal = {
  requestId: 'req-1',
  expiresAt: null,
  items: [
    { ref: 'i0', kind: 'preference', content: 'ERASE-ME-TEXT', evidence: 'e', effect: 'new' },
  ],
}
const memory = {
  id: 'm1',
  content: 'a memory',
  kind: 'preference',
  tier: 'verda',
  createdAt: new Date(),
  lastSeenAt: new Date(),
  compactedFrom: 1,
  sourceConversationIds: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  mem.list.mockResolvedValue({ enabled: true, memories: [memory] })
  mem.proposals.mockResolvedValue([proposal])
  mem.inbox.mockResolvedValue([
    { sessionId: 's1', requestId: 'req-1', title: 't', itemCount: 1, expiresAt: null },
  ])
})

describe('Forget everything', () => {
  it('removes the card, the dialog and the inbox badge without a reload or a timer', async () => {
    render(() => (
      <>
        <HitlInbox />
        <MemoryProposalPrompt sessionId="s1" settledTick={0} />
        <MemoryPanel />
      </>
    ))
    await screen.findByText('a memory')
    await waitFor(() => expect(q('hitl-inbox-trigger')).not.toBeNull())
    fireEvent.click(q('memory-proposal-review')!)
    await waitFor(() => expect(q('memory-proposal-dialog')).not.toBeNull())
    // the person is now in the Memory tab: erase, behind the open dialog's reach
    mem.proposals.mockResolvedValue([])
    mem.inbox.mockResolvedValue([])
    mem.list.mockResolvedValue({ enabled: false, memories: [] })
    mem.all.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm forget everything' }))
    await waitFor(() => expect(mem.all).toHaveBeenCalled())
    await waitFor(() => {
      expect(q('memory-proposal-notice')).toBeNull()
      expect(q('memory-proposal-dialog')).toBeNull()
      expect(q('hitl-inbox-trigger')).toBeNull()
    })
    expect(document.body.textContent).not.toContain('ERASE-ME-TEXT')
  })

  // A partial failure leaves memory OFF: the surfaces still clear.
  it('clears them on a failed erase too (memory may already be off)', async () => {
    render(() => (
      <>
        <HitlInbox />
        <MemoryProposalPrompt sessionId="s1" settledTick={0} />
        <MemoryPanel />
      </>
    ))
    await screen.findByText('a memory')
    await waitFor(() => expect(q('memory-proposal-notice')).not.toBeNull())
    mem.proposals.mockResolvedValue([])
    mem.inbox.mockResolvedValue([])
    mem.all.mockRejectedValue(new Error('Lock timeout: retry'))
    fireEvent.click(screen.getByRole('button', { name: 'Forget everything' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm forget everything' }))
    await waitFor(() => expect(q('memory-proposal-notice')).toBeNull())
    expect(q('hitl-inbox-trigger')).toBeNull()
  })

  // R1. MUTATION: drop `!d.checked` from MemoryPanel's switch handler → red.
  it('clears them when memory is switched OFF directly (no memories, so no confirm dialog)', async () => {
    mem.list.mockResolvedValue({ enabled: true, memories: [] })
    render(() => (
      <>
        <HitlInbox />
        <MemoryProposalPrompt sessionId="s1" settledTick={0} />
        <MemoryPanel />
      </>
    ))
    await waitFor(() => expect(q('memory-proposal-notice')).not.toBeNull())
    await waitFor(() => expect(q('hitl-inbox-trigger')).not.toBeNull())
    mem.proposals.mockResolvedValue([])
    mem.inbox.mockResolvedValue([])
    mem.list.mockResolvedValue({ enabled: false, memories: [] })
    mem.set.mockResolvedValue(undefined)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Memory enabled' }))
    await waitFor(() => expect(mem.set).toHaveBeenCalledWith(false))
    expect(screen.queryByRole('dialog', { name: /Forget everything/ })).toBeNull()
    await waitFor(() => {
      expect(q('memory-proposal-notice')).toBeNull()
      expect(q('hitl-inbox-trigger')).toBeNull()
    })
  })

  // Switching memory ON must NOT clear anything (it erases nothing).
  it('switching memory ON leaves the surfaces alone', async () => {
    mem.list.mockResolvedValue({ enabled: false, memories: [] })
    render(() => (
      <>
        <MemoryProposalPrompt sessionId="s1" settledTick={0} />
        <MemoryPanel />
      </>
    ))
    await waitFor(() => expect(q('memory-proposal-notice')).not.toBeNull())
    mem.set.mockResolvedValue(undefined)
    mem.list.mockResolvedValue({ enabled: true, memories: [] })
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Memory enabled' }))
    await waitFor(() => expect(mem.set).toHaveBeenCalledWith(true))
    expect(q('memory-proposal-notice')).not.toBeNull()
  })
})

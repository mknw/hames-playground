/**
 * MemoryProposalPrompt — the confirmation of a prepared memory (#419 M6).
 *
 * The two server actions are stubbed. What is under test is what a person can
 * and cannot do by accident: the dialog never opens by itself, closing it
 * decides nothing, nothing is saved until Save, the model-derived text is
 * rendered as text (no HTML), and what is sent is a choice and one flag per item.
 * Every pin names the mutation that turns it red; each one was run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const listMemoryProposals = vi.fn()
const answerMemoryProposal = vi.fn()
vi.mock('~/lib/memory/confirm-actions.server', () => ({
  listMemoryProposals: (s: string) => listMemoryProposals(s) as unknown,
  answerMemoryProposal: (...a: unknown[]) => answerMemoryProposal(...a) as unknown,
}))

const { render, fireEvent } = await import('@solidjs/testing-library')
const { createSignal } = await import('solid-js')
const { MemoryProposalPrompt, PROPOSAL_POLL_MS } =
  await import('../../../components/ark-ui/MemoryProposalPrompt')

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const view = (items = 2) => ({
  requestId: 'req-1',
  expiresAt: Date.now() + 60_000,
  items: [
    {
      ref: 'i0',
      kind: 'preference',
      content: 'The user prefers metric units.',
      evidence: 'I prefer metric',
      effect: 'new',
    },
    {
      ref: 'i1',
      kind: 'trait',
      content: 'The user’s team is Aurora.',
      evidence: 'my team is Aurora',
      effect: 'updates',
      previous: 'The user’s team is Borealis.',
    },
  ].slice(0, items),
})

beforeEach(() => {
  listMemoryProposals.mockReset()
  answerMemoryProposal.mockReset()
  listMemoryProposals.mockResolvedValue([view()])
})
afterEach(() => vi.useRealTimers())

describe('the notice', () => {
  // MUTATION: open the dialog when a proposal arrives → red.
  it('appears quietly and never opens the dialog by itself', async () => {
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')!.textContent).toContain('Save to memory? 2 items')
    expect(q('memory-proposal-notice')!.getAttribute('role')).toBe('status')
    expect(q('memory-proposal-dialog')).toBeNull()
    expect(answerMemoryProposal).not.toHaveBeenCalled()
  })

  it('says nothing when there is nothing, or when the list cannot be read', async () => {
    listMemoryProposals.mockResolvedValueOnce([])
    const a = render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')).toBeNull()
    a.unmount()
    listMemoryProposals.mockRejectedValueOnce(new Error('offline'))
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')).toBeNull()
  })

  it('counts a single item in the singular', async () => {
    listMemoryProposals.mockResolvedValue([view(1)])
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')!.textContent).toContain('1 item')
    expect(q('memory-proposal-notice')!.textContent).not.toContain('1 items')
  })
})

describe('polling after a turn settles', () => {
  // MUTATION: drop the settled-tick effect → a proposal raised after the reply never shows → red.
  it('looks again on the backoff and stops at the first proposal', async () => {
    vi.useFakeTimers()
    listMemoryProposals.mockResolvedValue([])
    const [tickN, setTick] = createSignal(0)
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={tickN()} />)
    await vi.advanceTimersByTimeAsync(0)
    expect(listMemoryProposals).toHaveBeenCalledTimes(1)
    setTick(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(listMemoryProposals).toHaveBeenCalledTimes(2)
    listMemoryProposals.mockResolvedValue([view()])
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[0])
    expect(listMemoryProposals).toHaveBeenCalledTimes(3)
    expect(q('memory-proposal-notice')).not.toBeNull()
    // found: the later checks do not ask again
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[2])
    expect(listMemoryProposals).toHaveBeenCalledTimes(3)
  })

  // MUTATION: keep proposals across a conversation switch → the next chat shows the last one's memories → red.
  it('a conversation switch clears the notice and reads the new conversation', async () => {
    const [sid, setSid] = createSignal('s1')
    render(() => <MemoryProposalPrompt sessionId={sid()} settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')).not.toBeNull()
    // The new conversation's list is still on its way: the old notice must
    // already be gone, not linger until the answer arrives.
    listMemoryProposals.mockReturnValue(new Promise(() => undefined))
    setSid('s2')
    await tick()
    expect(listMemoryProposals).toHaveBeenLastCalledWith('s2')
    expect(q('memory-proposal-notice')).toBeNull()
  })
})

describe('the dialog', () => {
  const open = async () => {
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    fireEvent.click(q('memory-proposal-review')!)
    await tick()
  }

  it('opens only on Review, with every item checked and what each would do', async () => {
    await open()
    const dialog = q('memory-proposal-dialog')!
    expect(dialog.textContent).toContain('The user prefers metric units.')
    expect(dialog.textContent).toContain('from your message: “I prefer metric”')
    expect(dialog.textContent).toContain('New memory')
    expect(dialog.textContent).toContain('Replaces an older memory: “The user’s team is Borealis.”')
    const boxes = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect([...boxes].map((b) => b.checked)).toEqual([true, true])
  })

  // MUTATION: `answer` on close / on Escape → deciding by leaving → red.
  it('closing it decides nothing: the notice stays and nothing is sent', async () => {
    await open()
    fireEvent.keyDown(q('memory-proposal-dialog')!, { key: 'Escape' })
    await tick()
    expect(answerMemoryProposal).not.toHaveBeenCalled()
    expect(q('memory-proposal-notice')).not.toBeNull()
  })

  // MUTATION: send the proposal's items instead of the flags / send `save` bare → red.
  it('Save sends a choice and one boolean per item — and nothing else', async () => {
    answerMemoryProposal.mockResolvedValue({ outcome: 'saved', written: 1, stale: 0 })
    await open()
    const boxes =
      q('memory-proposal-dialog')!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    fireEvent.click(boxes[1])
    await tick()
    listMemoryProposals.mockResolvedValue([])
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(answerMemoryProposal).toHaveBeenCalledTimes(1)
    expect(answerMemoryProposal).toHaveBeenCalledWith('s1', 'req-1', {
      choice: 'save',
      flags: { i0: true, i1: false },
    })
    expect(q('memory-proposal-notice')).toBeNull()
    expect(q('memory-proposal-result')!.textContent).toContain('Saved 1.')
  })

  // MUTATION: drop the `disabled` guard → Save with nothing checked is sendable → red.
  it('Save is disabled with nothing checked', async () => {
    await open()
    const boxes =
      q('memory-proposal-dialog')!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    await tick()
    expect((q('memory-proposal-save') as HTMLButtonElement).disabled).toBe(true)
  })

  // MUTATION: send `save` for the discard button → red.
  it("Don't save sends the bare discard choice", async () => {
    answerMemoryProposal.mockResolvedValue({ outcome: 'discarded' })
    await open()
    listMemoryProposals.mockResolvedValue([])
    fireEvent.click(q('memory-proposal-discard')!)
    await tick()
    expect(answerMemoryProposal).toHaveBeenCalledWith('s1', 'req-1', 'discard')
    expect(q('memory-proposal-result')!.textContent).toContain('Nothing was saved.')
  })

  // MUTATION: close the dialog on `conflict`/`failed` → the person loses the chance to retry → red.
  it.each(['conflict', 'failed'])(
    'a %s keeps the dialog open and says to try again',
    async (outcome) => {
      answerMemoryProposal.mockResolvedValue({ outcome })
      await open()
      fireEvent.click(q('memory-proposal-save')!)
      await tick()
      expect(q('memory-proposal-dialog')!.textContent).toContain('could not be saved right now')
      expect((q('memory-proposal-save') as HTMLButtonElement).disabled).toBe(false)
    },
  )

  it('a switched-off memory says so and keeps the dialog', async () => {
    answerMemoryProposal.mockResolvedValue({ outcome: 'memory-off' })
    await open()
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(q('memory-proposal-dialog')!.textContent).toContain('Memory is turned off')
  })

  it('a stale item is reported with the count that was saved', async () => {
    answerMemoryProposal.mockResolvedValue({ outcome: 'saved', written: 1, stale: 1 })
    await open()
    listMemoryProposals.mockResolvedValue([])
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(q('memory-proposal-result')!.textContent).toContain(
      'Saved 1. 1 changed since it was suggested and was not saved.',
    )
  })

  it.each(['unknown-request', 'expired', 'unavailable'])(
    'a %s closes the dialog and says it is no longer available',
    async (outcome) => {
      answerMemoryProposal.mockResolvedValue({ outcome })
      await open()
      listMemoryProposals.mockResolvedValue([])
      fireEvent.click(q('memory-proposal-save')!)
      await tick()
      expect(q('memory-proposal-result')!.textContent).toContain('no longer available')
    },
  )

  // MUTATION: render the text as `innerHTML` → the element exists → red.
  it('renders model-derived text as text: markup in a memory is inert', async () => {
    listMemoryProposals.mockResolvedValue([
      {
        requestId: 'req-1',
        expiresAt: null,
        items: [
          {
            ref: 'i0',
            kind: 'preference',
            content: '<img src=x onerror="window.__pwned=1"><b>bold</b>',
            evidence: '<script>window.__pwned=1</script>',
            effect: 'new',
          },
        ],
      },
    ])
    await open()
    const dialog = q('memory-proposal-dialog')!
    expect(dialog.querySelector('img, script, b')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x onerror="window.__pwned=1"><b>bold</b>')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('a thrown answer is a retryable failure, not a crash', async () => {
    answerMemoryProposal.mockRejectedValue(new Error('network'))
    await open()
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(q('memory-proposal-dialog')!.textContent).toContain('could not be saved right now')
  })
})

describe('#579 review 6 and 2: selection and the bound answer', () => {
  const open = async () => {
    render(() => <MemoryProposalPrompt sessionId="s1" settledTick={0} />)
    await tick()
    fireEvent.click(q('memory-proposal-review')!)
    await tick()
  }
  const boxes = () => [
    ...q('memory-proposal-dialog')!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ]

  // MUTATION: key the unchecked set by the bare ref → the next proposal opens
  // with the same items unchecked → red.
  it('one proposal’s unchecked items do not carry over to the next, which reuses the same refs', async () => {
    await open()
    fireEvent.click(boxes()[1])
    await tick()
    expect(boxes().map((b) => b.checked)).toEqual([true, false])
    fireEvent.keyDown(q('memory-proposal-dialog')!, { key: 'Escape' })
    await tick()
    // the next proposal arrives (another turn), with the same positional refs
    listMemoryProposals.mockResolvedValue([{ ...view(), requestId: 'req-2' }])
    window.dispatchEvent(new Event('focus'))
    await tick()
    fireEvent.click(q('memory-proposal-review')!)
    await tick()
    expect(boxes().map((b) => b.checked)).toEqual([true, true])
  })

  // MUTATION: leave the selection and the other button live after a refused
  // save → a different answer can be sent over a bound one → red.
  it('after a refused save the SAME answer is retried: the other button and the boxes lock', async () => {
    answerMemoryProposal.mockResolvedValueOnce({ outcome: 'conflict' })
    await open()
    fireEvent.click(boxes()[1])
    await tick()
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect((q('memory-proposal-discard') as HTMLButtonElement).disabled).toBe(true)
    expect(boxes().every((b) => b.disabled)).toBe(true)
    expect(boxes().map((b) => b.checked)).toEqual([true, false])
    answerMemoryProposal.mockResolvedValueOnce({ outcome: 'saved', written: 1, stale: 0 })
    listMemoryProposals.mockResolvedValue([])
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(answerMemoryProposal).toHaveBeenLastCalledWith('s1', 'req-1', {
      choice: 'save',
      flags: { i0: true, i1: false },
    })
  })

  it('a discard that conflicted locks the save button instead', async () => {
    answerMemoryProposal.mockResolvedValueOnce({ outcome: 'conflict' })
    await open()
    fireEvent.click(q('memory-proposal-discard')!)
    await tick()
    expect((q('memory-proposal-save') as HTMLButtonElement).disabled).toBe(true)
    expect((q('memory-proposal-discard') as HTMLButtonElement).disabled).toBe(false)
  })

  // MUTATION: ignore `recorded` → after a reload the person can send a different answer → red.
  it('a proposal the server says is already answered offers only that answer, with its selection', async () => {
    listMemoryProposals.mockResolvedValue([
      { ...view(), recorded: { choice: 'save', flags: { i0: true, i1: false } } },
    ])
    await open()
    expect(boxes().map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ])
    expect((q('memory-proposal-discard') as HTMLButtonElement).disabled).toBe(true)
    expect((q('memory-proposal-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    ['already-answered', 'already answered'],
    ['full', 'memory is full'],
  ])('%s is said in words', async (outcome, words) => {
    answerMemoryProposal.mockResolvedValue({ outcome })
    await open()
    // `already-answered` closes the dialog and re-reads; the answered one is gone
    if (outcome === 'already-answered') listMemoryProposals.mockResolvedValue([])
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    expect(document.body.textContent).toContain(words)
  })
})

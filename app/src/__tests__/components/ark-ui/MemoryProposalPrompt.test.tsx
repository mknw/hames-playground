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

// The real toaster, observed: what is CREATED and DISMISSED is the contract
// (the DOM shows at most one toast, so a count of nodes cannot tell once from twice).
const toastSpy = vi.hoisted(() => ({ create: vi.fn(), dismiss: vi.fn() }))
vi.mock('@ark-ui/solid/toast', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ark-ui/solid/toast')>()
  return {
    ...real,
    createToaster: (props: Parameters<typeof real.createToaster>[0]) => {
      const t = real.createToaster(props)
      const create = t.create.bind(t)
      const dismiss = t.dismiss.bind(t)
      t.create = ((o: never) => (toastSpy.create(o), create(o))) as typeof t.create
      t.dismiss = ((id?: string) => (toastSpy.dismiss(id), dismiss(id))) as typeof t.dismiss
      return t
    },
  }
})

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

const reviewStore = await import('../../../lib/hitl/review-store')
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
  toastSpy.create.mockClear()
  toastSpy.dismiss.mockClear()
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

describe('the toast and the inbox hand-off (#433 S8)', () => {
  const { requestReview, reviewTarget } = reviewStore

  // MUTATION: toast on the first read too → a proposal already on screen when the chat opened toasts → red.
  it('toasts a proposal that ARRIVES after the chat opened, once, and not one already there', async () => {
    vi.useFakeTimers()
    listMemoryProposals.mockResolvedValue([])
    const [tickN, setTick] = createSignal(0)
    render(() => <MemoryProposalPrompt sessionId="s-toast" settledTick={tickN()} />)
    await vi.advanceTimersByTimeAsync(0)
    expect(q('memory-proposal-toast')).toBeNull()
    setTick(1)
    await vi.advanceTimersByTimeAsync(0)
    listMemoryProposals.mockResolvedValue([view()])
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[0])
    const toast = q('memory-proposal-toast')!
    expect(toast.textContent).toContain('Save to memory?')
    expect(toast.textContent).toContain('2 items')
    // the toast never opens the dialog by itself
    expect(q('memory-proposal-dialog')).toBeNull()
    // a re-read of the same proposal does not toast again
    fireEvent.focus(window)
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelectorAll('[data-testid="memory-proposal-toast"]').length).toBe(1)
  })

  it('does not toast a proposal that was already on screen at load', async () => {
    render(() => <MemoryProposalPrompt sessionId="s-load" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-notice')).not.toBeNull()
    expect(q('memory-proposal-toast')).toBeNull()
  })

  // MUTATION: ignore the review target → the inbox's Review does nothing → red.
  it('opens the dialog on the request the inbox asked for, and consumes the ask', async () => {
    requestReview({ sessionId: 's-inbox', requestId: 'req-1' })
    render(() => <MemoryProposalPrompt sessionId="s-inbox" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-dialog')).not.toBeNull()
    expect(reviewTarget()).toBeNull()
  })

  // MUTATION: drop the sessionId comparison → an ask for another chat opens this one's dialog → red.
  it('an ask for another conversation, or an unknown request, opens nothing', async () => {
    requestReview({ sessionId: 'elsewhere', requestId: 'req-1' })
    render(() => <MemoryProposalPrompt sessionId="s-here" settledTick={0} />)
    await tick()
    expect(q('memory-proposal-dialog')).toBeNull()
    // dropped on arrival in a different conversation (#589 F4)
    expect(reviewTarget()).toBeNull()
    requestReview({ sessionId: 's-here', requestId: 'nope' })
    await tick()
    expect(q('memory-proposal-dialog')).toBeNull()
    expect(reviewTarget()).toBeNull()
  })
})

describe('#589 fix round 1', () => {
  const { requestReview, reviewTarget, notifyMemoryErased, inboxVersion } = reviewStore
  const arrive = async (sid: string) => {
    vi.useFakeTimers()
    listMemoryProposals.mockResolvedValue([])
    const [tickN, setTick] = createSignal(0)
    const r = render(() => <MemoryProposalPrompt sessionId={sid} settledTick={tickN()} />)
    await vi.advanceTimersByTimeAsync(0)
    setTick(1)
    await vi.advanceTimersByTimeAsync(0)
    listMemoryProposals.mockResolvedValue([view()])
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[0])
    return r
  }

  // F2 · B13. MUTATION: `const fresh = found` (drop the seen filter) → red.
  it('F2: one proposal is CREATED as a toast once, however often it is read again', async () => {
    await arrive('s-once')
    expect(toastSpy.create).toHaveBeenCalledTimes(1)
    fireEvent.focus(window)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.focus(window)
    await vi.advanceTimersByTimeAsync(0)
    expect(toastSpy.create).toHaveBeenCalledTimes(1)
  })

  // F2 · B4. MUTATION: append `fresh[0].items[0].content` to the description → red.
  it('F2: the toast carries a count and nothing the person said', async () => {
    await arrive('s-counts')
    const made = JSON.stringify(
      (({ title, description }) => ({ title, description }))(toastSpy.create.mock.calls[0][0]),
    )
    const painted = q('memory-proposal-toast')!.textContent!
    for (const text of [made, painted]) {
      expect(text).not.toMatch(/metric|Aurora|Borealis|prefer|team/)
    }
    expect(painted).toContain('2 items')
  })

  // F2 · B15. MUTATION: make the toast's Review a no-op → red.
  it('F2/F5: the toast’s Review opens the dialog on the request it announced', async () => {
    await arrive('s-review')
    expect(q('memory-proposal-dialog')).toBeNull()
    const action = q('memory-proposal-toast')!.querySelector<HTMLElement>(
      '[data-part="action-trigger"]',
    )!
    fireEvent.click(action)
    await vi.advanceTimersByTimeAsync(50)
    expect(q('memory-proposal-dialog')).not.toBeNull()
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
  })

  // F5. MUTATION: drop `toaster.dismiss()` from the switch effect → red.
  it('F5: a conversation switch dismisses the toast and the ask it carried', async () => {
    vi.useFakeTimers()
    const [sid, setSid] = createSignal('s-a')
    listMemoryProposals.mockResolvedValue([])
    const [tickN, setTick] = createSignal(0)
    render(() => <MemoryProposalPrompt sessionId={sid()} settledTick={tickN()} />)
    await vi.advanceTimersByTimeAsync(0)
    setTick(1)
    await vi.advanceTimersByTimeAsync(0)
    listMemoryProposals.mockResolvedValue([view()])
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[0])
    expect(toastSpy.create).toHaveBeenCalledTimes(1)
    toastSpy.dismiss.mockClear()
    setSid('s-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(toastSpy.dismiss).toHaveBeenCalled()
  })

  // F2 · B14. MUTATION: drop `notifyInboxChanged()` → red; always call it → the identical-read assertion is red.
  it('F2/F3: the inbox is told when the pending set CHANGED, and only then', async () => {
    render(() => <MemoryProposalPrompt sessionId="s-notify" settledTick={0} />)
    await tick()
    const afterFirst = inboxVersion()
    expect(afterFirst).toBeGreaterThan(0)
    fireEvent.focus(window)
    await tick()
    fireEvent.focus(window)
    await tick()
    expect(inboxVersion()).toBe(afterFirst)
    listMemoryProposals.mockResolvedValue([])
    fireEvent.focus(window)
    await tick()
    expect(inboxVersion()).toBeGreaterThan(afterFirst)
  })

  // F2 · B7 (inherited from M6). MUTATION: close while busy → red.
  it('F2: Escape while an answer is in flight leaves the dialog open', async () => {
    answerMemoryProposal.mockReturnValue(new Promise(() => undefined))
    render(() => <MemoryProposalPrompt sessionId="s-busy" settledTick={0} />)
    await tick()
    fireEvent.click(q('memory-proposal-review')!)
    await tick()
    fireEvent.click(q('memory-proposal-save')!)
    await tick()
    fireEvent.keyDown(q('memory-proposal-dialog')!, { key: 'Escape' })
    await tick()
    expect(q('memory-proposal-dialog')).not.toBeNull()
  })

  // F4. MUTATION: keep the target after the first read finds nothing → red.
  it('F4: an ask whose request is not there is DROPPED, not kept for a later arrival', async () => {
    vi.useFakeTimers()
    listMemoryProposals.mockResolvedValue([])
    requestReview({ sessionId: 's-drop', requestId: 'req-1' })
    const [tickN, setTick] = createSignal(0)
    render(() => <MemoryProposalPrompt sessionId="s-drop" settledTick={tickN()} />)
    await vi.advanceTimersByTimeAsync(0)
    expect(reviewTarget()).toBeNull()
    setTick(1)
    await vi.advanceTimersByTimeAsync(0)
    listMemoryProposals.mockResolvedValue([view()])
    await vi.advanceTimersByTimeAsync(PROPOSAL_POLL_MS[0])
    expect(q('memory-proposal-notice')).not.toBeNull()
    expect(q('memory-proposal-dialog')).toBeNull()
  })

  it('F4: a failed read drops the ask too', async () => {
    listMemoryProposals.mockRejectedValue(new Error('offline'))
    requestReview({ sessionId: 's-fail', requestId: 'req-1' })
    render(() => <MemoryProposalPrompt sessionId="s-fail" settledTick={0} />)
    await tick()
    expect(reviewTarget()).toBeNull()
  })

  // F4. MUTATION: drop the `clearReview()` in the switch effect → red.
  it('F4: choosing another conversation drops an ask made for a different one', async () => {
    const [sid, setSid] = createSignal('s-first')
    listMemoryProposals.mockReturnValue(new Promise(() => undefined))
    render(() => <MemoryProposalPrompt sessionId={sid()} settledTick={0} />)
    await tick()
    requestReview({ sessionId: 's-target', requestId: 'req-1' })
    await tick()
    expect(reviewTarget()).not.toBeNull()
    setSid('s-other')
    await tick()
    expect(reviewTarget()).toBeNull()
  })

  // F1. MUTATION: drop the erase effect from the prompt → red.
  it('F1: erasing memory clears the card, the dialog, the toast and a pending ask, with no timer advanced', async () => {
    await arrive('s-erase')
    fireEvent.click(q('memory-proposal-review')!)
    await vi.advanceTimersByTimeAsync(50)
    expect(q('memory-proposal-dialog')).not.toBeNull()
    requestReview({ sessionId: 's-erase', requestId: 'req-1' })
    listMemoryProposals.mockResolvedValue([])
    toastSpy.dismiss.mockClear()
    notifyMemoryErased()
    await vi.advanceTimersByTimeAsync(50)
    expect(q('memory-proposal-notice')).toBeNull()
    expect(q('memory-proposal-dialog')).toBeNull()
    expect(toastSpy.dismiss).toHaveBeenCalled()
    expect(reviewTarget()).toBeNull()
  })

  // F1. MUTATION: drop the generation check → a read begun before the erase repaints the card → red.
  it('F1: a read already in flight when memory is erased cannot repaint it', async () => {
    let resolve!: (v: unknown) => void
    listMemoryProposals.mockReturnValue(new Promise((r) => (resolve = r)))
    render(() => <MemoryProposalPrompt sessionId="s-inflight" settledTick={0} />)
    await tick()
    listMemoryProposals.mockResolvedValue([])
    notifyMemoryErased()
    await tick()
    resolve([view()])
    await tick()
    expect(q('memory-proposal-notice')).toBeNull()
  })
})

describe('#589 fix round 1: every model-derived field is a text node', () => {
  // MUTATION (run for each): render `previous` / `kind` through innerHTML → red.
  it('F2/F8: previous and kind carrying markup stay inert text', async () => {
    const v = view()
    v.items[1].previous = '<img src=x onerror=alert(1)>'
    v.items[1].kind = '<b>bold</b>'
    listMemoryProposals.mockResolvedValue([v])
    render(() => <MemoryProposalPrompt sessionId="s-inert" settledTick={0} />)
    await tick()
    fireEvent.click(q('memory-proposal-review')!)
    await tick()
    const dialog = q('memory-proposal-dialog')!
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.querySelector('b')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(dialog.textContent).toContain('<b>bold</b>')
  })
})

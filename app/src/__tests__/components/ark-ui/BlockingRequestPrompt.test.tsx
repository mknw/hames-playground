/**
 * The blocking-request controller (decision-loop-agent slice 9), component
 * layer. Each pin names the source mutation that turns it red; each was run.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const listBlockingRequests = vi.fn()
const answerHitl = vi.fn()
vi.mock('~/lib/hitl/actions.server', () => ({
  listBlockingRequests: (s: string) => listBlockingRequests(s) as unknown,
  answerHitl: (...a: unknown[]) => answerHitl(...a) as unknown,
  listBlockingInbox: async () => [],
}))

const { installDomObservers } = await import('../../mocks/dom-observers')
const { render, fireEvent } = await import('@solidjs/testing-library')
const { BlockingRequestPrompt, STEP_GUARD_MS } =
  await import('../../../components/ark-ui/BlockingRequestPrompt')
const reviewStore = await import('../../../lib/hitl/review-store')

beforeAll(() => installDomObservers())

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const view = (requestId: string, over: Record<string, unknown> = {}) => ({
  requestId,
  kind: 'graph-write',
  question: `Decide ${requestId}?`,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  defaultOption: 'reject',
  summary: {},
  expiresAt: Date.now() + 3_600_000,
  recorded: null,
  ...over,
})

function mount(over: { busy?: boolean } = {}) {
  const onResume = vi.fn()
  render(() => (
    <BlockingRequestPrompt
      sessionId="s1"
      settledTick={0}
      busy={over.busy ?? false}
      onResume={onResume}
    />
  ))
  return { onResume }
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('the blocking-request prompt', () => {
  // MUTATION: record each answer as it is chosen (one answerHitl per request),
  // or resume before the last → red.
  it('answers several requests one after another, records them together, then resumes once', async () => {
    listBlockingRequests.mockResolvedValue([view('a'), view('b')])
    answerHitl.mockResolvedValue([
      { requestId: 'a', outcome: 'answered' },
      { requestId: 'b', outcome: 'answered' },
    ])
    const { onResume } = mount()
    await tick()
    expect(q('hitl-blocking-card')!.textContent).toContain('2 decisions needed')
    fireEvent.click(q('hitl-blocking-review')!)
    await tick()
    expect(q('hitl-blocking-dialog')!.textContent).toContain('Decide a?')
    fireEvent.click(q('hitl-blocking-option-approve')!)
    await tick()
    expect(answerHitl).not.toHaveBeenCalled()
    expect(q('hitl-blocking-dialog')!.textContent).toContain('Decide b?')
    // A press after the step's guard: a deliberate one, not the same gesture.
    await tick(STEP_GUARD_MS)
    fireEvent.click(q('hitl-blocking-option-reject')!)
    await tick()
    expect(answerHitl).toHaveBeenCalledTimes(1)
    expect(answerHitl).toHaveBeenCalledWith('s1', { a: 'approve', b: 'reject' })
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  // MUTATION: resume whatever the outcomes say → an expired request continues
  // the run → red.
  it('an expired answer does not resume, and the dialog offers Close only', async () => {
    listBlockingRequests.mockResolvedValue([view('a')])
    answerHitl.mockResolvedValue([{ requestId: 'a', outcome: 'expired' }])
    const { onResume } = mount()
    await tick()
    fireEvent.click(q('hitl-blocking-review')!)
    await tick()
    fireEvent.click(q('hitl-blocking-option-approve')!)
    await tick()
    expect(onResume).not.toHaveBeenCalled()
    expect(q('hitl-blocking-option-approve')).toBeNull()
    expect(q('hitl-blocking-close')).not.toBeNull()
  })

  // MUTATION: treat a recorded answer as unanswered → the person is asked
  // again for a decision already recorded → red.
  it('an answer already recorded is continued, not asked again', async () => {
    listBlockingRequests.mockResolvedValue([view('a', { recorded: 'approve' })])
    const { onResume } = mount()
    await tick()
    expect(q('hitl-blocking-review')).toBeNull()
    fireEvent.click(q('hitl-blocking-continue')!)
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(answerHitl).not.toHaveBeenCalled()
  })

  it('a read that fails says so and offers Retry, never a fabricated decision', async () => {
    listBlockingRequests.mockRejectedValueOnce(new Error('down')).mockResolvedValue([view('a')])
    mount()
    await tick()
    expect(q('hitl-blocking-card')!.textContent).toContain('The decisions could not be loaded.')
    fireEvent.click(q('hitl-blocking-card-retry')!)
    await tick()
    expect(q('hitl-blocking-review')).not.toBeNull()
  })

  // MUTATION: drop the live region's text → the arrival is silent to a screen
  // reader → red.
  it('announces the arrival politely, without opening the dialog', async () => {
    listBlockingRequests.mockResolvedValue([view('a')])
    mount()
    await tick()
    const live = q('hitl-blocking-live')!
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('One decision needed')
    expect(q('hitl-blocking-dialog')).toBeNull()
  })

  it('offers nothing while a turn of the conversation is streaming', async () => {
    listBlockingRequests.mockResolvedValue([view('a')])
    mount({ busy: true })
    await tick()
    expect(q('hitl-blocking-card')).toBeNull()
  })

  // #803 review B2. MUTATION: drop the refocus on a request change → focus
  // is left on the page body after the step → red.
  it('the next request’s safe action takes focus after a step', async () => {
    listBlockingRequests.mockResolvedValue([view('a'), view('b')])
    mount()
    await tick()
    fireEvent.click(q('hitl-blocking-review')!)
    await tick(80)
    fireEvent.click(q('hitl-blocking-option-approve')!)
    await tick(80)
    expect(q('hitl-blocking-dialog')!.textContent).toContain('Decide b?')
    expect(document.activeElement).toBe(q('hitl-blocking-option-reject'))
  })

  // #803 review B3. MUTATIONS: drop the double-click guard → the second press
  // answers b → red; drop the step guard → a held key's second press answers
  // b → red.
  it('a double-press, or a repeat right after a step, answers nothing unseen', async () => {
    listBlockingRequests.mockResolvedValue([view('a'), view('b')])
    answerHitl.mockResolvedValue([])
    mount()
    await tick()
    fireEvent.click(q('hitl-blocking-review')!)
    await tick()
    fireEvent.click(q('hitl-blocking-option-approve')!, { detail: 1 })
    await tick()
    fireEvent.click(q('hitl-blocking-option-approve')!, { detail: 2 })
    // A key repeat: a fresh press (detail 0) inside the guard.
    fireEvent.click(q('hitl-blocking-option-approve')!, { detail: 0 })
    await tick()
    expect(answerHitl).not.toHaveBeenCalled()
    expect(q('hitl-blocking-dialog')!.textContent).toContain('Decide b?')
    // A double-click's second press after the window is still not an answer.
    await tick(STEP_GUARD_MS)
    fireEvent.click(q('hitl-blocking-option-approve')!, { detail: 2 })
    await tick()
    expect(answerHitl).not.toHaveBeenCalled()
  })

  // #803 review B4. MUTATION: drop the expiry timer → the open dialog keeps a
  // live option past the deadline → red.
  it('an open dialog stops offering a live option at the deadline', async () => {
    listBlockingRequests.mockResolvedValue([view('a', { expiresAt: Date.now() + 150 })])
    mount()
    await tick()
    fireEvent.click(q('hitl-blocking-review')!)
    await tick()
    expect(q('hitl-blocking-option-approve')).not.toBeNull()
    await tick(300)
    expect(q('hitl-blocking-option-approve')).toBeNull()
    expect(q('hitl-blocking-state')!.textContent).toContain('This decision has expired.')
  })

  // #803 review N2. MUTATION: keep the position after a re-read → a request
  // still waiting reads as superseded → red.
  it('after a partial failure the request still waiting is the one shown', async () => {
    listBlockingRequests.mockResolvedValue([view('a'), view('b')])
    answerHitl.mockResolvedValue([
      { requestId: 'a', outcome: 'answered' },
      { requestId: 'b', outcome: 'invalid-choice' },
    ])
    mount()
    await tick()
    fireEvent.click(q('hitl-blocking-review')!)
    await tick()
    fireEvent.click(q('hitl-blocking-option-approve')!)
    await tick(STEP_GUARD_MS)
    listBlockingRequests.mockResolvedValue([view('a', { recorded: 'approve' }), view('b')])
    fireEvent.click(q('hitl-blocking-option-reject')!)
    await tick()
    expect(q('hitl-blocking-dialog')!.textContent).toContain('Decide b?')
    expect(q('hitl-blocking-option-reject')).not.toBeNull()
  })

  // #803 copy review item 7. MUTATION: count every request → a recorded one
  // is counted as still needed → red.
  it('the card counts the decisions still to make', async () => {
    listBlockingRequests.mockResolvedValue([view('a', { recorded: 'approve' }), view('b')])
    mount()
    await tick()
    expect(q('hitl-blocking-card')!.textContent).toContain('One decision needed')
  })

  // MUTATION: ignore the inbox's ask → the header's "Decision needed" opens
  // nothing → red.
  it("opens on the header inbox's ask for this conversation", async () => {
    listBlockingRequests.mockResolvedValue([view('a')])
    mount()
    await tick()
    reviewStore.requestBlockingReview('s1')
    await tick()
    expect(q('hitl-blocking-dialog')).not.toBeNull()
    expect(reviewStore.blockingReviewTarget()).toBeNull()
  })
})

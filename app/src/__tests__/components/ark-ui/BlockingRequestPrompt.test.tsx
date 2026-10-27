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
const { BlockingRequestPrompt } = await import('../../../components/ark-ui/BlockingRequestPrompt')
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
    expect(q('hitl-blocking-card')!.textContent).toContain('could not be read')
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
    expect(live.textContent).toBe('Approval needed: one decision')
    expect(q('hitl-blocking-dialog')).toBeNull()
  })

  it('offers nothing while a turn of the conversation is streaming', async () => {
    listBlockingRequests.mockResolvedValue([view('a')])
    mount({ busy: true })
    await tick()
    expect(q('hitl-blocking-card')).toBeNull()
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

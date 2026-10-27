/**
 * The blocking dialog's shell rules (decision-loop-agent slice 9), component
 * layer. Each pin names the source mutation that turns it red; each was run.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

const { installDomObservers } = await import('../../mocks/dom-observers')
const { render, fireEvent } = await import('@solidjs/testing-library')
const { HitlDialog } = await import('../../../components/ark-ui/HitlDialog')
type Props = Parameters<typeof HitlDialog>[0] & { kind: 'blocking' }
type View = NonNullable<Extract<Props, { kind: 'blocking' }>['request']>

beforeAll(() => {
  installDomObservers()
  // The dialog's focus trap asks `tabbable` whether a control is visible, and
  // jsdom lays nothing out, so every control reads as hidden and focus falls to
  // the content box. One rect per element makes them visible to it; nothing
  // here asserts on layout.
  Element.prototype.getClientRects = function () {
    return [{ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }] as unknown as DOMRectList
  }
})

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const view = (over: Partial<View> = {}): View => ({
  requestId: 'req-1',
  kind: 'graph-write',
  question: 'Change the knowledge graph?',
  options: [
    { id: 'approve', label: 'Approve this change', tone: 'danger' },
    { id: 'reject', label: 'Reject' },
  ],
  defaultOption: 'reject',
  summary: { route: 'knowledge-edit' },
  expiresAt: Date.now() + 23 * 3_600_000 + 60_000,
  recorded: null,
  payload: 'MATCH (n) // inspect only\nDETACH DELETE n',
  ...over,
})

function mount(over: Partial<Extract<Props, { kind: 'blocking' }>> = {}) {
  const onChoose = vi.fn()
  const onClose = vi.fn()
  const onRetry = vi.fn()
  const result = render(() => (
    <HitlDialog
      kind="blocking"
      open
      onClose={onClose}
      request={view()}
      state="ready"
      busy={false}
      notice={null}
      onChoose={onChoose}
      onRetry={onRetry}
      {...over}
    />
  ))
  return { ...result, onChoose, onClose, onRetry }
}

describe('the blocking dialog', () => {
  // MUTATION: put the initial-focus ref on the first option instead of the
  // default → focus lands on "Approve this change" → red.
  it('opens with focus on the safe action, the request default', async () => {
    mount()
    await tick(80)
    expect(document.activeElement).toBe(q('hitl-blocking-option-reject'))
    expect(q('hitl-blocking-option-reject')!.hasAttribute('data-default')).toBe(true)
  })

  // MUTATION: decide on close (call onChoose(defaultOption) in onOpenChange) →
  // Escape records a choice → red.
  it('Escape closes the dialog and decides nothing', async () => {
    const { onChoose, onClose } = mount()
    await tick(80)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await tick()
    expect(onChoose).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  // MUTATION: put the warning band inside the ScrollArea viewport, or drop its
  // id from aria-describedby → red.
  it('the warning sits above the scrolling body, and the description references it', async () => {
    mount({ warning: 'This may change up to 3 staff-directory entries.' })
    await tick()
    const dialog = q('hitl-blocking-dialog')!
    const warning = q('hitl-blocking-dialog-warning')!
    expect(warning.closest('[data-part="viewport"]')).toBeNull()
    expect(dialog.getAttribute('aria-describedby')).toContain(warning.id)
    const payload = q('hitl-blocking-payload')!
    expect(warning.compareDocumentPosition(payload) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // MUTATION: render the payload through `displayText` (or collapse
  // whitespace) → the comment swallows the delete on one line → red.
  it('renders the payload losslessly, with format and bidi characters made visible', async () => {
    mount({
      request: view({
        payload: 'MATCH (n) // inspect only\nDETACH DELETE n\nA  B invoice‮fdp.exe',
        options: [
          { id: 'approve', label: 'Approve​' },
          { id: 'reject', label: 'Reject' },
        ],
      }),
    })
    await tick()
    const text = q('hitl-blocking-payload')!.textContent!
    expect(text.split('\n')).toEqual([
      'MATCH (n) // inspect only',
      'DETACH DELETE n',
      'A  B invoice⟨U+202E⟩fdp.exe',
    ])
    expect(q('hitl-blocking-option-approve')!.textContent).toBe('Approve⟨U+200B⟩')
  })

  // MUTATION: drop `busy` from the options' `disabled` → a second press is
  // possible while the first is in flight → red.
  it('disables every action from the first press until the outcome', async () => {
    mount({ busy: true })
    await tick()
    expect((q('hitl-blocking-option-approve') as HTMLButtonElement).disabled).toBe(true)
    expect((q('hitl-blocking-option-reject') as HTMLButtonElement).disabled).toBe(true)
  })

  // MUTATION: keep the options in an expired or superseded state → a dead
  // request offers a live Approve → red.
  it.each(['expired', 'superseded'] as const)('an %s request offers Close only', async (state) => {
    mount({ state })
    await tick()
    expect(q('hitl-blocking-option-approve')).toBeNull()
    expect(q('hitl-blocking-close')).not.toBeNull()
    expect(q('hitl-blocking-state')!.textContent).toContain('Nothing was decided')
  })

  it('a read failure offers Retry, and never an option', async () => {
    const { onRetry } = mount({ state: 'failed' })
    await tick()
    expect(q('hitl-blocking-option-approve')).toBeNull()
    fireEvent.click(q('hitl-blocking-retry')!)
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

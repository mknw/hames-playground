/**
 * The link-review dialog body (#901 slice 2), component layer — the third,
 * CLIENT-ONLY body of HitlDialog: the factual reason, the complete resolved
 * address as selectable body text, and the three actions. The slice-18 seam
 * (boundary-guards rev 6, presentation) is pinned here too: the reason rides a
 * prop carrying the #901-only default, and the severity input greys the open
 * action. Nothing here touches the server-side HITL answer/resume flow.
 *
 * Each pin names the source mutation that turns it red; each was run.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

const { installDomObservers } = await import('../../mocks/dom-observers')
const { render, fireEvent } = await import('@solidjs/testing-library')
const { HitlDialog, DEFAULT_LINK_REVIEW_REASON } =
  await import('../../../components/ark-ui/HitlDialog')

beforeAll(() => {
  installDomObservers()
  // See HitlDialog.blocking.test.tsx: one rect per element, so the focus trap
  // reads the controls as visible.
  Element.prototype.getClientRects = function () {
    return [{ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }] as unknown as DOMRectList
  }
})

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
/** Zag's dismissable layer attaches its outside-press and escape listeners
 *  inside a `requestAnimationFrame` (`trackDismissableElement`'s `defer`), and
 *  a wall-clock tick does not guarantee a frame has run under a loaded suite —
 *  so drain two frames before interacting, and wait for the mechanism rather
 *  than for a guess about the clock. */
const frames = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
/** Synthetic host only — the repo is public and carries no tenant hostname. */
const ADDRESS = 'https://external.example/a/long/path?q=1&to=collector.test#frag'

function mount(over: Record<string, unknown> = {}) {
  const onClose = vi.fn()
  const onDefang = vi.fn()
  render(() => (
    <HitlDialog
      kind="link-review"
      open
      onClose={onClose}
      address={ADDRESS}
      onDefang={onDefang}
      {...over}
    />
  ))
  return { onClose, onDefang }
}

/** The element the shell renders as `Dialog.Description` when there is a
 *  summary: the `aria-describedby` entry that is not the warning band (the
 *  shell lists the warning first, when there is one). */
const description = (): HTMLElement | null => {
  const described = (q('link-review-dialog')!.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
  const warningId = q('link-review-dialog-warning')?.id
  const summaryId = described.find((id) => id !== warningId)
  return summaryId ? document.getElementById(summaryId) : null
}

describe('the link-review body', () => {
  // MUTATION: put the initial-focus ref on the open action → focus lands on
  // "Open in another tab" → red.
  it('opens with focus on Cancel, and the open action is a real anchor', async () => {
    mount()
    await tick(80)
    expect(document.activeElement).toBe(q('link-review-cancel'))
    const open = q('link-review-open') as HTMLAnchorElement
    expect(open.tagName).toBe('A')
    expect(open.getAttribute('href')).toBe(ADDRESS)
    // The default severity is the plain #901 review: no warning band.
    expect(q('link-review-dialog-warning')).toBeNull()
  })

  // MUTATION: `rel="noopener"` on the open action → differs from the
  // sanitizer's stamp → red. `noreferrer` is what keeps the shared-transcript
  // token out of the opened page's Referer (`s/[token].tsx`).
  it('stamps the open action exactly as the sanitizer stamps every rendered link', async () => {
    mount()
    await tick()
    const open = q('link-review-open') as HTMLAnchorElement
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')
  })

  // MUTATION: pass the address as the Description (or render the address into
  // the summary) → opening the dialog reads the whole address aloud → red.
  it('shows the whole address as body text, and the Description is a short summary only', async () => {
    mount()
    await tick()
    // The complete address — path, query and fragment — as selectable body
    // text, never a truncation.
    expect(q('link-review-address')!.textContent).toBe(ADDRESS)
    const summary = description()
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toBe(DEFAULT_LINK_REVIEW_REASON)
    expect(summary!.textContent).not.toContain(ADDRESS)
  })

  // MUTATION: drop `visibleFormatChars` from the address render (or run the
  // address through `displayText` instead) → the bidi control is applied to
  // the shown text rather than shown → red. The shell's untrusted-text rule
  // on the one surface this slice names as the bidi target.
  it('makes a bidi/format control in the address visible, not applied', async () => {
    mount({ address: 'https://external.example/\u200Fa/path' })
    await tick()
    expect(q('link-review-address')!.textContent).toBe(
      'https://external.example/\u27e8U+200F\u27e9a/path',
    )
  })

  // MUTATION: decide on close (call onDefang in the Escape path) → Escape
  // defangs the link → red.
  it('Escape closes the dialog and decides nothing', async () => {
    const { onClose, onDefang } = mount()
    await tick(80)
    await frames()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await tick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDefang).not.toHaveBeenCalled()
  })

  // MUTATION: the same on the backdrop path → red.
  it('the backdrop closes the dialog and decides nothing', async () => {
    const { onClose, onDefang } = mount()
    await tick(80)
    await frames()
    // The shell's backdrop: the fixed overlay below the positioner (z-40).
    const backdrop = [...document.querySelectorAll('div')].find(
      (d) => d.style.zIndex === '40' && d.style.position === 'fixed',
    )
    expect(backdrop).toBeTruthy()
    fireEvent.pointerDown(backdrop!)
    fireEvent.click(backdrop!)
    await tick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDefang).not.toHaveBeenCalled()
  })

  it('"Cancel and defang" asks the mount to defang, then closes', async () => {
    const { onClose, onDefang } = mount()
    await tick(80)
    fireEvent.click(q('link-review-defang')!)
    expect(onDefang).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // MUTATION: hard-code the reason inside the body → the prop is dead and the
  // slice-18 copy has no seam → red.
  it('carries the #901-only default reason', async () => {
    mount()
    await tick()
    expect(description()!.textContent).toBe('This address is not on the recognised host list')
    expect(q('link-review-address')!.textContent).toBe(ADDRESS)
  })

  it('slice 18’s reason rides the same prop', async () => {
    const reason = 'The screen flagged the content this reference came from.'
    mount({ reason })
    await tick()
    expect(description()!.textContent).toBe(reason)
    expect(q('link-review-address')!.textContent).toBe(ADDRESS)
  })

  // MUTATION: drop the `detected()` gates (always the plain review) → the
  // detected severity shows no warning and an active anchor → red.
  it('the detected severity rides the warning band and greys the open action until it is deliberately armed', async () => {
    const { onDefang } = mount({ severity: 'detected' })
    await tick(80)
    // The reason rides the warning band, and the Description stays absent so
    // opening does not read the same words twice.
    expect(q('link-review-dialog-warning')!.textContent).toContain(
      'This address is not on the recognised host list',
    )
    expect(description()).toBeNull()
    // The open action is greyed and inert: not an anchor, not activatable.
    const greyed = q('link-review-open') as HTMLButtonElement
    expect(greyed.tagName).toBe('BUTTON')
    expect(greyed.disabled).toBe(true)
    // The arm step is the only thing that makes the open action real.
    const box = q('link-review-arm')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    fireEvent.click(box)
    await tick()
    const open = q('link-review-open') as HTMLAnchorElement
    expect(open.tagName).toBe('A')
    expect(open.getAttribute('href')).toBe(ADDRESS)
    expect(open.getAttribute('rel')).toBe('noopener noreferrer')
    expect(onDefang).not.toHaveBeenCalled()
  })
})

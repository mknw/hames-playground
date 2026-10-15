/**
 * HitlInbox — the header inbox of pending decisions (#433 S8).
 *
 * The RPC and the router are stubbed. What is under test: the count and rows
 * reflect what the server listed (nothing invented when it fails), a title is
 * rendered as TEXT (it is the person's, but a text node is the only defence a
 * client has), choosing a row hands over exactly two ids and navigates, and
 * nothing is decided here.
 * Every pin names the mutation that turns it red; each one was run.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const listMemoryInbox = vi.fn()
vi.mock('~/lib/memory/confirm-actions.server', () => ({
  listMemoryInbox: () => listMemoryInbox() as unknown,
}))
const navigate = vi.fn()
vi.mock('@solidjs/router', () => ({ useNavigate: () => navigate }))

const { render, fireEvent } = await import('@solidjs/testing-library')
const { HitlInbox } = await import('../../../components/ark-ui/HitlInbox')
const reviewStore = await import('../../../lib/hitl/review-store')
const { reviewTarget, clearReview, notifyInboxChanged } = reviewStore

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const entry = (over = {}) => ({
  sessionId: 's2',
  requestId: 'req-2',
  title: 'Metric units',
  itemCount: 2,
  expiresAt: null,
  ...over,
})

beforeEach(() => {
  listMemoryInbox.mockReset()
  navigate.mockReset()
  clearReview()
})

describe('the count', () => {
  // MUTATION: render the trigger with no `Show` on the count → an empty inbox shows a "0" → red.
  it('is absent when nothing waits, and when the list cannot be read', async () => {
    listMemoryInbox.mockResolvedValue([])
    const a = render(() => <HitlInbox />)
    await tick()
    expect(q('hitl-inbox-trigger')).toBeNull()
    a.unmount()
    listMemoryInbox.mockRejectedValue(new Error('offline'))
    render(() => <HitlInbox />)
    await tick()
    expect(q('hitl-inbox-trigger')).toBeNull()
  })

  it('counts what the server listed and names it for assistive tech', async () => {
    listMemoryInbox.mockResolvedValue([entry(), entry({ requestId: 'req-3', sessionId: 's3' })])
    render(() => <HitlInbox />)
    await tick()
    expect(q('hitl-inbox-count')!.textContent).toBe('2')
    expect(q('hitl-inbox-trigger')!.getAttribute('aria-label')).toBe('Waiting on you: 2')
  })

  // MUTATION: drop the inboxVersion effect → an answer in the chat leaves the badge stale → red.
  it('re-reads when the prompt says what is pending changed', async () => {
    listMemoryInbox.mockResolvedValue([entry()])
    render(() => <HitlInbox />)
    await tick()
    listMemoryInbox.mockResolvedValue([])
    notifyInboxChanged()
    await tick()
    expect(q('hitl-inbox-trigger')).toBeNull()
  })
})

describe('a row', () => {
  const openMenu = async () => {
    render(() => <HitlInbox />)
    await tick()
    fireEvent.click(q('hitl-inbox-trigger')!)
    await tick()
  }

  // MUTATION: render the title with innerHTML → the <img> becomes an element → red.
  it('shows the title as text, never as markup', async () => {
    listMemoryInbox.mockResolvedValue([entry({ title: '<img src=x onerror=alert(1)>' })])
    await openMenu()
    const item = q('hitl-inbox-item')!
    expect(item.querySelector('img')).toBeNull()
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(item.textContent).toContain('Save to memory? 2 items')
  })

  it('says so for an untitled conversation and counts one item in the singular', async () => {
    listMemoryInbox.mockResolvedValue([entry({ title: null, itemCount: 1 })])
    await openMenu()
    expect(q('hitl-inbox-item')!.textContent).toContain('Untitled conversation')
    expect(q('hitl-inbox-item')!.textContent).toContain('1 item')
    expect(q('hitl-inbox-item')!.textContent).not.toContain('1 items')
  })

  // MUTATION: skip requestReview → the chat opens but the dialog does not → red.
  it('hands over the two ids, navigates to that conversation, and decides nothing', async () => {
    listMemoryInbox.mockResolvedValue([entry({ sessionId: 's 2/x' })])
    await openMenu()
    const item = q('hitl-inbox-item')!
    fireEvent.click(item)
    await tick()
    expect(reviewTarget()).toEqual({ sessionId: 's 2/x', requestId: 'req-2' })
    expect(navigate).toHaveBeenCalledWith('/?c=s%202%2Fx')
    expect(listMemoryInbox).toHaveBeenCalledTimes(1)
  })
})

describe('#589 fix round 1', () => {
  const { notifyMemoryErased } = reviewStore

  // F1. MUTATION: drop the erase effect → the badge stays until the 60s poll → red.
  it('F1: erasing memory empties the inbox at once, before any read returns', async () => {
    listMemoryInbox.mockResolvedValue([entry()])
    render(() => <HitlInbox />)
    await tick()
    expect(q('hitl-inbox-trigger')).not.toBeNull()
    listMemoryInbox.mockReturnValue(new Promise(() => undefined))
    notifyMemoryErased()
    await tick(0)
    expect(q('hitl-inbox-trigger')).toBeNull()
  })

  // F3. MUTATION: drop the `mine === latest` check → the older answer wins → red.
  it('F3: an older response never overwrites a newer one', async () => {
    let first!: (v: unknown) => void
    listMemoryInbox.mockReturnValueOnce(new Promise((r) => (first = r)))
    render(() => <HitlInbox />)
    await tick()
    listMemoryInbox.mockResolvedValueOnce([])
    notifyInboxChanged()
    await tick()
    first([entry()])
    await tick()
    expect(q('hitl-inbox-trigger')).toBeNull()
  })

  // F1/F3. MUTATION: drop `latest++` in the erase effect → a read begun before the erase repaints the rows → red.
  it('F1: a read begun before an erase cannot repaint the rows', async () => {
    let early!: (v: unknown) => void
    listMemoryInbox.mockReturnValueOnce(new Promise((r) => (early = r)))
    render(() => <HitlInbox />)
    await tick()
    listMemoryInbox.mockResolvedValueOnce([])
    notifyMemoryErased()
    await tick()
    early([entry()])
    await tick()
    expect(q('hitl-inbox-trigger')).toBeNull()
  })

  // F3. MUTATION: drop the min-gap check → every focus is a read → red.
  it('F3: a window focus right after a read does not read again', async () => {
    listMemoryInbox.mockResolvedValue([entry()])
    render(() => <HitlInbox />)
    await tick()
    const reads = listMemoryInbox.mock.calls.length
    fireEvent.focus(window)
    fireEvent.focus(window)
    await tick()
    expect(listMemoryInbox.mock.calls.length).toBe(reads)
  })
})

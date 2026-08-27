/**
 * ConversationTierSwitch — the control beside the agent selector.
 *
 * The server actions are mocked, so what is asserted is the surface a user
 * meets and the two ways a switch can lie:
 *   - both positions are LABELLED, because the control has to be
 *     understandable without documentation;
 *   - clicking writes through the server and settles on what the SERVER says,
 *     never on the click — a switch showing one tier while the next turn runs
 *     on another is worse than no switch;
 *   - the self-hosted position is disabled, not hidden, when the endpoint is
 *     unconfigured — a missing control explains nothing;
 *   - switching threads re-reads, so the previous conversation's tier is never
 *     left on screen against the new one;
 *   - a flip in flight is handed to the composer, so a send cannot overtake it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const getConversationTier = vi.fn()
const setConversationTier = vi.fn()
vi.mock('~/lib/harness-client', () => ({
  getConversationTier: (sessionId: string) => getConversationTier(sessionId),
  setConversationTier: (sessionId: string, tier: string) => setConversationTier(sessionId, tier),
}))

const { render, waitFor, fireEvent } = await import('@solidjs/testing-library')
const { createSignal } = await import('solid-js')
const { ConversationTierSwitch } = await import('../../../components/ark-ui/ConversationTierSwitch')

const state = (tier = 'verda', verdaAvailable = true) => ({ tier, verdaAvailable })

beforeEach(() => {
  vi.clearAllMocks()
  getConversationTier.mockResolvedValue(state())
  setConversationTier.mockImplementation(async (_sid: string, tier: string) => state(tier))
})

/** Render and wait for the first read to land. */
async function mounted(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('Anthropic'))
}

const radio = (container: HTMLElement, value: string) =>
  [...container.querySelectorAll('input[type="radio"]')].find(
    (i) => (i as HTMLInputElement).value === value,
  ) as HTMLInputElement

describe('the positions', () => {
  it('labels both in words rather than as a bare toggle', async () => {
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    expect(container.textContent).toContain('Private (Verda)')
    expect(container.textContent).toContain('Anthropic')
  })

  it('marks the conversation’s tier as the selected radio', async () => {
    getConversationTier.mockResolvedValue(state('anthropic'))
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    expect(radio(container, 'anthropic').checked).toBe(true)
    expect(radio(container, 'verda').checked).toBe(false)
  })

  it('disables the self-hosted position instead of hiding it', async () => {
    // A deployment with no endpoint. Hiding the position would explain nothing;
    // disabling it says the choice exists and is not available here — and the
    // server refuses it anyway, so the control must not offer it.
    getConversationTier.mockResolvedValue(state('anthropic', false))
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    expect(container.textContent).toContain('Private (Verda)')
    expect(radio(container, 'verda').disabled).toBe(true)
    expect(radio(container, 'anthropic').disabled).toBe(false)
  })
})

describe('flipping', () => {
  it('writes the clicked position against THIS conversation', async () => {
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    fireEvent.click(radio(container, 'anthropic'))

    await waitFor(() => expect(setConversationTier).toHaveBeenCalledWith('c1', 'anthropic'))
  })

  it('does not write when the clicked position is the one already in force', async () => {
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    fireEvent.click(radio(container, 'verda'))
    await Promise.resolve()

    expect(setConversationTier).not.toHaveBeenCalled()
  })

  it('settles on what the server returned, not on the click', async () => {
    // The server refuses the private position on a deployment with no endpoint.
    // A control that kept its optimistic selection through that refusal would
    // show one tier while the next turn ran on another.
    getConversationTier.mockResolvedValue(state('anthropic', true))
    setConversationTier.mockResolvedValue(state('anthropic', true))
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    fireEvent.click(radio(container, 'verda'))

    await waitFor(() => expect(setConversationTier).toHaveBeenCalled())
    await waitFor(() => expect(radio(container, 'anthropic').checked).toBe(true))
    expect(radio(container, 'verda').checked).toBe(false)
  })

  it('says so when the write fails, rather than showing a tier it did not get', async () => {
    setConversationTier.mockRejectedValue(new Error('the endpoint is not configured'))
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)
    await mounted(container)

    fireEvent.click(radio(container, 'anthropic'))

    await waitFor(() => expect(container.textContent).toContain('not saved'))
    expect(radio(container, 'verda').checked).toBe(true)
  })

  it('hands the in-flight write to the composer so a send cannot overtake it', async () => {
    // For a conversation with no row yet the flip lands in the user's seed, and
    // the first turn's pre-seed READS that seed — so a send that raced the write
    // would start the conversation on the tier the user had just left, and
    // record it on the row.
    const seen: Promise<unknown>[] = []
    const { container } = render(() => (
      <ConversationTierSwitch sessionId="c1" onPendingWrite={(w) => seen.push(w)} />
    ))
    await mounted(container)

    fireEvent.click(radio(container, 'anthropic'))

    await waitFor(() => expect(seen).toHaveLength(1))
    await expect(seen[0]).resolves.toBeUndefined()
  })
})

describe('switching threads', () => {
  it('re-reads, so the previous conversation’s tier is never left on screen', async () => {
    getConversationTier.mockImplementation(async (sessionId: string) =>
      sessionId === 'c1' ? state('verda') : state('anthropic'),
    )
    const [sessionId, setSessionId] = createSignal('c1')
    const { container } = render(() => <ConversationTierSwitch sessionId={sessionId()} />)
    await waitFor(() => expect(radio(container, 'verda').checked).toBe(true))

    setSessionId('c2')

    await waitFor(() => expect(radio(container, 'anthropic').checked).toBe(true))
    expect(getConversationTier).toHaveBeenCalledWith('c2')
  })

  it('renders nothing until the first read lands, rather than guessing a tier', async () => {
    // A default position drawn before the answer arrives is a claim about where
    // this conversation runs, made without having asked.
    let resolve: ((v: unknown) => void) | undefined
    getConversationTier.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const { container } = render(() => <ConversationTierSwitch sessionId="c1" />)

    expect(container.textContent).not.toContain('Anthropic')
    resolve?.(state())
    await mounted(container)
  })
})

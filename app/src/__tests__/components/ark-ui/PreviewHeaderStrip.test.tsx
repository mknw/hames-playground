/**
 * PreviewHeaderStrip — the top-bar cluster: tier switch, warm state, counters.
 *
 * The server action is mocked, so what is asserted is the surface a preview
 * user actually meets:
 *   - both switch positions are LABELLED, because the control has to be
 *     understandable without documentation;
 *   - clicking a position writes it through the server and settles on what the
 *     server says, not on an optimistic guess;
 *   - the self-hosted position is disabled, not hidden, when the endpoint is
 *     unconfigured — a missing control explains nothing;
 *   - the warm state is carried by a WORD, not only a colour (`color-not-only`),
 *     and the per-second countdown is not announced (a live region that
 *     re-reads a number every second is noise);
 *   - a number that cannot be measured renders as "—", never as a plausible 0.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const getPreviewHeaderState = vi.fn()
const setPreviewInferenceTier = vi.fn()
vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: () => getPreviewHeaderState(),
  setPreviewInferenceTier: (tier: string) => setPreviewInferenceTier(tier),
}))

const { render, waitFor, fireEvent } = await import('@solidjs/testing-library')
const { PreviewHeaderStrip } = await import('../../../components/ark-ui/PreviewHeaderStrip')

type State = Awaited<
  ReturnType<typeof import('~/lib/harness-client/preview-header.server').getPreviewHeaderState>
>

const state = (over: Partial<State> = {}): State =>
  ({
    tier: 'verda',
    verdaAvailable: true,
    warmth: { state: 'warm', secondsUntilScaledown: 120, scaledownSeconds: 180 },
    activeUsers: 3,
    activeWindowMinutes: 15,
    usage: { totalTokens: 12_500, llmCalls: 40, turns: 9, verdaCallShare: 0.75 },
    generatedAt: Date.now(),
    ...over,
  }) as State

beforeEach(() => {
  vi.clearAllMocks()
  getPreviewHeaderState.mockResolvedValue(state())
  setPreviewInferenceTier.mockImplementation(async (tier: string) => state({ tier } as never))
})

/** Render and wait for the first poll to land. */
async function mounted(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('Anthropic'))
}

describe('the tier switch', () => {
  it('labels both positions in words rather than a bare toggle', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    // A preview user has to be able to tell what the switch does without
    // documentation — the label leads with the property, not the vendor.
    expect(container.textContent).toContain('Private (Verda)')
    expect(container.textContent).toContain('Anthropic')
  })

  it('marks the stored tier as the selected radio', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const checked = container.querySelector('input[type="radio"]:checked') as HTMLInputElement
    expect(checked?.value).toBe('verda')
  })

  it('writes the other position through the server when clicked', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const anthropic = [...container.querySelectorAll('input[type="radio"]')].find(
      (i) => (i as HTMLInputElement).value === 'anthropic',
    ) as HTMLInputElement
    fireEvent.click(anthropic)

    await waitFor(() => expect(setPreviewInferenceTier).toHaveBeenCalledWith('anthropic'))
  })

  it('settles on what the server returned, not on the click', async () => {
    // The server is the authority: it can refuse, or normalise. An optimistic
    // control that kept the clicked position would show one tier while the
    // next turn ran on another.
    setPreviewInferenceTier.mockResolvedValue(state({ tier: 'verda' }))
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const anthropic = [...container.querySelectorAll('input[type="radio"]')].find(
      (i) => (i as HTMLInputElement).value === 'anthropic',
    ) as HTMLInputElement
    fireEvent.click(anthropic)

    await waitFor(() => expect(setPreviewInferenceTier).toHaveBeenCalled())
    await waitFor(() => {
      const checked = container.querySelector('input[type="radio"]:checked') as HTMLInputElement
      expect(checked?.value).toBe('verda')
    })
  })

  it('disables the self-hosted position instead of hiding it', async () => {
    // Hiding it would leave a preview user with no explanation for why the
    // choice they were told about is absent.
    getPreviewHeaderState.mockResolvedValue(
      state({ tier: 'anthropic', verdaAvailable: false, warmth: undefined as never }),
    )
    getPreviewHeaderState.mockResolvedValue(state({ tier: 'anthropic', verdaAvailable: false }))
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('Private (Verda)')
    const verda = [...container.querySelectorAll('input[type="radio"]')].find(
      (i) => (i as HTMLInputElement).value === 'verda',
    ) as HTMLInputElement
    expect(verda.disabled).toBe(true)
  })
})

describe('the warm indicator', () => {
  it('carries the state as a word, not only as a colour', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('warm')
  })

  it('shows the countdown as m:ss', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('2:00')
  })

  it('announces the state but NOT the ticking number', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const live = container.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toContain('warm')
    // A live region re-read once a second is noise, so the countdown is
    // deliberately outside it and aria-hidden.
    expect(live.textContent).not.toContain(':')
  })

  it('says "cold" with no countdown once the box has scaled down', async () => {
    getPreviewHeaderState.mockResolvedValue(
      state({ warmth: { state: 'cold', secondsUntilScaledown: null, scaledownSeconds: 180 } }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('cold')
    expect(container.textContent).not.toMatch(/\d:\d\d/)
  })

  it('distinguishes "unknown" from "cold"', async () => {
    // A process that has never seen a call cannot tell them apart, and saying
    // "cold" would present a guess as a measurement.
    getPreviewHeaderState.mockResolvedValue(
      state({ warmth: { state: 'unknown', secondsUntilScaledown: null, scaledownSeconds: 180 } }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('unknown')
  })

  it('says "starting", not "answering", while the box is waking up', async () => {
    // `running` is documented as implying warm and renders a full countdown.
    // A turn against a scaled-to-zero box must not read that way: the sender
    // is paying a cold start, and anyone else reading the strip would conclude
    // the box is up and send into the same wait.
    getPreviewHeaderState.mockResolvedValue(
      state({ warmth: { state: 'starting', secondsUntilScaledown: null, scaledownSeconds: 180 } }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('starting')
    expect(container.textContent).not.toContain('answering')
    // No countdown: there is nothing measured to count down from.
    expect(container.textContent).not.toMatch(/\d:\d\d/)
  })

  it('lets the local clock expire the window early, but never extend it', async () => {
    // The client may only shorten what the server said. The other direction —
    // a client that keeps rendering "warm" past the window, or re-inflates a
    // countdown — would claim warmth no measurement supports.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(
        state({ warmth: { state: 'warm', secondsUntilScaledown: 3, scaledownSeconds: 180 } }),
      )
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('warm'))

      // Past the window, with NO new poll landing.
      await vi.advanceTimersByTimeAsync(4000)

      expect(container.textContent).toContain('cold')
      expect(container.textContent).not.toMatch(/\d:\d\d/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is absent entirely when there is no self-hosted endpoint to be warm', async () => {
    getPreviewHeaderState.mockResolvedValue(state({ tier: 'anthropic', verdaAvailable: false }))
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.querySelector('[data-testid="verda-warmth"]')).toBeNull()
  })
})

describe('the metrics', () => {
  it('renders the counters compactly', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('12.5k') // tokens today
    expect(container.textContent).toContain('75%') // self-hosted share
    expect(container.textContent).toContain('active')
    expect(container.textContent).toContain('turns')
  })

  it('renders an unmeasurable share as "—", never as 0%', async () => {
    getPreviewHeaderState.mockResolvedValue(
      state({ usage: { totalTokens: 0, llmCalls: 0, turns: 0, verdaCallShare: null } }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('—')
    expect(container.textContent).not.toContain('0%')
  })

  it('drops the self-hosted share when there is no self-hosted endpoint', async () => {
    getPreviewHeaderState.mockResolvedValue(state({ tier: 'anthropic', verdaAvailable: false }))
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).not.toContain('on-prem')
  })
})

describe('degradation', () => {
  it('renders nothing at all until the first poll lands', async () => {
    // Better an empty slot than a bar of zeroes that look like measurements.
    getPreviewHeaderState.mockReturnValue(new Promise(() => {}))
    const { container } = render(() => <PreviewHeaderStrip />)

    expect(container.textContent).toBe('')
  })

  it('says so when the FIRST poll fails, instead of rendering nothing', async () => {
    // The stale path below keeps the last known values; this one has none to
    // keep. Rendering nothing makes a permanently broken action (Postgres down,
    // the table missing) indistinguishable from a deployment that never shipped
    // the feature — and nobody investigates a feature they cannot see.
    getPreviewHeaderState.mockRejectedValue(new Error('offline'))
    const { container } = render(() => <PreviewHeaderStrip />)

    await waitFor(() =>
      expect(container.querySelector('[data-testid="preview-header-unavailable"]')).not.toBeNull(),
    )
    const chip = container.querySelector('[data-testid="preview-header-unavailable"]')!
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.getAttribute('title')).toContain('could not be refreshed')
    // No fabricated numbers alongside it.
    expect(container.textContent).not.toContain('active')
  })

  it('keeps the last values and says "stale" when a poll fails', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    getPreviewHeaderState.mockRejectedValue(new Error('offline'))
    // Force a refresh through the switch path, which shares the error channel.
    setPreviewInferenceTier.mockRejectedValue(new Error('offline'))
    const anthropic = [...container.querySelectorAll('input[type="radio"]')].find(
      (i) => (i as HTMLInputElement).value === 'anthropic',
    ) as HTMLInputElement
    fireEvent.click(anthropic)

    await waitFor(() => expect(container.textContent).toContain('stale'))
    // The numbers are still there — they were true a moment ago.
    expect(container.textContent).toContain('12.5k')
  })
})

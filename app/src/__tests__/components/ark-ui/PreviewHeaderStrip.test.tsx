/**
 * PreviewHeaderStrip — the top-bar cluster: warm state and counters.
 *
 * The tier SWITCH is not here any more — it is per-conversation and lives
 * beside the agent selector (`ConversationTierSwitch.test.tsx` owns its tests).
 * What that leaves this strip is the box and the deployment, and one case here
 * pins the absence: a second control that still set a tier would silently fight
 * the per-conversation one.
 *
 * The server action is mocked, so what is asserted is the surface a preview
 * user actually meets:
 *   - the warm state is carried by a WORD, not only a colour (`color-not-only`),
 *     and the per-second countdown is not announced (a live region that
 *     re-reads a number every second is noise);
 *   - a number that cannot be measured renders as "—", never as a plausible 0.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const getPreviewHeaderState = vi.fn()
vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: () => getPreviewHeaderState(),
}))

const { render, waitFor } = await import('@solidjs/testing-library')
const { PreviewHeaderStrip, POLL_INTERVAL_MS } =
  await import('../../../components/ark-ui/PreviewHeaderStrip')

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
    latency: { p50Ms: 4123, samples: 12 },
    generatedAt: Date.now(),
    ...over,
  }) as State

beforeEach(() => {
  vi.clearAllMocks()
  getPreviewHeaderState.mockResolvedValue(state())
})

/** Render and wait for the first poll to land. */
async function mounted(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('active'))
}

describe('the tier switch is gone from here', () => {
  it('offers no way to change a tier from the header', async () => {
    // The control is per-conversation now. A second one here would be a global
    // setting sitting next to a per-thread one, and whichever a user reached
    // first would silently contradict the other.
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.querySelectorAll('[data-scope="segment-group"]')).toHaveLength(0)
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0)
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

  it('counts down from the payload, not from the server clock it was stamped on', async () => {
    // The countdown ticks against THIS browser's receipt time. Every other
    // fixture in this file stamps `generatedAt: Date.now()`, i.e. equal to
    // receipt, so none of them can tell the two clocks apart — which is how a
    // revert to `s.generatedAt` survived a whole round green. Here the server
    // stamp is a minute stale (a skewed clock, or a slow hop), so reading it
    // instead of the local one would open the countdown at 1:00.
    getPreviewHeaderState.mockResolvedValue(
      state({
        generatedAt: Date.now() - 60_000,
        warmth: { state: 'warm', secondsUntilScaledown: 120, scaledownSeconds: 180 },
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('2:00')
    expect(container.textContent).not.toContain('1:00')
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

  it('renders the rolling median call latency for the active tier', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('4.1s')
    expect(container.textContent).toContain('p50')
  })

  it('reserves the full five characters every metric value can render', async () => {
    // `min-w="9"` is 2.25rem = 3.0em at `text-xs`, which is five monospace
    // characters; `min-w="8"` was 2.67em and let `12.5k` or `99.9m` widen the
    // field on a poll. The claim lives in `formatLatency`'s docstring, so it is
    // pinned rather than left as prose.
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const values = [...container.querySelectorAll('span[font="mono"][min-w]')]
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value.getAttribute('min-w')).toBe('9')
  })

  it('renders an unmeasured latency as "—", never as 0.0s', async () => {
    // Before this server has completed a call on the tier there is nothing to
    // report, and a plausible "0.0s" would be a fabricated measurement.
    getPreviewHeaderState.mockResolvedValue(state({ latency: { p50Ms: null, samples: 0 } }))
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).not.toContain('0.0s')
    const p50 = [...container.querySelectorAll('div[title]')].find((el) =>
      el.textContent?.includes('p50'),
    )!
    expect(p50.textContent).toContain('—')
    // And it says why, rather than leaving a dash to be read as an error.
    expect(p50.getAttribute('title')).toContain('no median')
  })

  it('says how many calls the median is over, and whose measurement it is', async () => {
    // "p50" over 3 calls on one instance is a different claim from a settled
    // figure, and the tooltip is where the strip has room to say so.
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    const p50 = [...container.querySelectorAll('div[title]')].find((el) =>
      el.textContent?.includes('p50'),
    )!
    const hint = p50.getAttribute('title')!
    expect(hint).toContain('last 12 model call')
    // The tier the number belongs to, in the same words as the switch above it.
    expect(hint).toContain('Private (Verda)')
    // The two caveats: per call rather than per reply, and this server only.
    expect(hint).toContain('not one reply')
    expect(hint).toContain('another instance')
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
    // Driven through the POLL now that the switch is gone: the strip's only
    // remaining refresh is its timer, and that is the path that has to keep the
    // last known numbers on screen instead of blanking the bar.
    vi.useFakeTimers()
    try {
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('12.5k'))

      getPreviewHeaderState.mockRejectedValue(new Error('offline'))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1)

      await vi.waitFor(() => expect(container.textContent).toContain('stale'))
      // The numbers are still there — they were true a moment ago.
      expect(container.textContent).toContain('12.5k')
    } finally {
      vi.useRealTimers()
    }
  })
})

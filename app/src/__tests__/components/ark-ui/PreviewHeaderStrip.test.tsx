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
const igniteVerdaBox = vi.fn()
vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: () => getPreviewHeaderState(),
  igniteVerdaBox: () => igniteVerdaBox(),
}))

const { render, waitFor, fireEvent } = await import('@solidjs/testing-library')
const { PreviewHeaderStrip, POLL_INTERVAL_MS, IGNITE_LABEL, IGNITE_FAILED_LABEL } =
  await import('../../../components/ark-ui/PreviewHeaderStrip')

type State = Awaited<
  ReturnType<typeof import('~/lib/harness-client/preview-header.server').getPreviewHeaderState>
>

/** A `HeaderWarmth` fixture. The display states are the server assembly's
 *  machine (`preview-header.server.ts`): `ready` for completion evidence,
 *  `answering` its turn-in-flight flavour, `starting`/`cold` from the
 *  control-plane probe, `unknown` only when the probe fails. The estimate
 *  fields ride only `starting`. */
const warmth = (over: Partial<State['warmth']> = {}): State['warmth'] =>
  ({
    state: 'ready',
    secondsUntilScaledown: 120,
    scaledownSeconds: 180,
    coldStartEstimateMs: null,
    coldStartBasis: null,
    coldStartSamples: null,
    ...over,
  }) as State['warmth']

const state = (over: Partial<State> = {}): State =>
  ({
    tier: 'verda',
    verdaAvailable: true,
    warmth: warmth({ state: 'ready' }),
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
  igniteVerdaBox.mockResolvedValue(
    state({
      warmth: warmth({ state: 'ready', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
    }),
  )
})

const cold = () => state({ warmth: warmth({ state: 'cold', secondsUntilScaledown: null }) })

/** The warm indicator, whichever element it currently is. */
const indicator = (container: HTMLElement) =>
  container.querySelector('[data-testid="verda-warmth"]') as HTMLElement

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

    expect(container.textContent).toContain('ready')
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
        warmth: warmth({ state: 'ready' }),
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
    expect(live.textContent).toContain('ready')
    // A live region re-read once a second is noise, so the countdown is
    // deliberately outside it and aria-hidden.
    expect(live.textContent).not.toContain(':')
  })

  it('says "cold" with no countdown once the box has scaled down', async () => {
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({ state: 'cold', secondsUntilScaledown: null, scaledownSeconds: 180 }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('cold')
    expect(container.textContent).not.toMatch(/\d:\d\d/)
  })

  it('distinguishes "unknown" from "cold"', async () => {
    // `unknown` is now the DEGRADED display — the control plane could not be
    // asked (probe failure, missing credentials) — and must stay visibly
    // different from `cold`, which is an observation. Saying "cold" there would
    // present a guess as a measurement.
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({ state: 'unknown', secondsUntilScaledown: null, scaledownSeconds: 180 }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await mounted(container)

    expect(container.textContent).toContain('unknown')
  })

  it('shows the REMAINING cold-start estimate while the box is starting', async () => {
    // The gate the design settled: the `starting` state renders a countdown —
    // how much of the estimated wait is left, spent by what the control plane
    // has actually watched the replica do (the server sends the remainder; see
    // `displayWarmth`).
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({
          state: 'starting',
          secondsUntilScaledown: null,
          coldStartEstimateMs: 120_000,
          coldStartBasis: 'measured',
          coldStartSamples: 3,
        }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('starting'))

    expect(container.textContent).toContain('2:00')
    // The figure says where it came from: an estimate with a basis, never a
    // measurement dressed as one.
    const el = indicator(container)
    expect(el.getAttribute('title')).toContain('Median of the 3 most recent')
  })

  it('shows nothing once the estimate is spent, and keeps saying "starting"', async () => {
    // Running long is the EXPECTED case (a burst queues on one replica). A
    // figure pinned at 0:00 would read as done for a box that is merely slow;
    // the number goes and the word stays.
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({
          state: 'starting',
          secondsUntilScaledown: null,
          coldStartEstimateMs: null,
          coldStartBasis: 'default',
          coldStartSamples: 0,
        }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('starting'))

    expect(container.textContent).not.toMatch(/\d:\d\d/)
  })

  it('says "starting", not "answering", while the box is waking up', async () => {
    // `running` is documented as implying warm and renders a full countdown.
    // A turn against a scaled-to-zero box must not read that way: the sender
    // is paying a cold start, and anyone else reading the strip would conclude
    // the box is up and send into the same wait.
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({ state: 'starting', secondsUntilScaledown: null, scaledownSeconds: 180 }),
      }),
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
        state({
          warmth: warmth({ state: 'ready', secondsUntilScaledown: 3, scaledownSeconds: 180 }),
        }),
      )
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('ready'))

      // Past the window, with NO new poll landing.
      await vi.advanceTimersByTimeAsync(4000)

      expect(container.textContent).toContain('cold')
      expect(container.textContent).not.toMatch(/\d:\d\d/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the countdown while a turn is ANSWERING on the box, not only between turns', async () => {
    // THE COUNTDOWN BUG. `verdaWarmth()` computes `secondsUntilScaledown` for
    // `running` — the state's documented promise is that it implies warm — and
    // the render site gated the number on `=== 'warm'`, so it was computed,
    // serialized to the browser and dropped. `running` is also the state a user
    // is in for the whole of their own turn, which on a route whose first call
    // costs minutes is most of the time anyone looks at this strip: hence
    // "never once seen".
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({ state: 'answering', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('answering'))

    expect(container.textContent).toContain('5:00')
  })

  it('holds the ANSWERING figure still instead of ticking it down and resetting it', async () => {
    // `verdaWarmth()` re-sends the FULL window for `running` on every poll —
    // correctly, since a box cannot scale down while a turn is on it — so the
    // local countdown ran it down for one poll interval and then snapped it back
    // to the top: traced at one-second intervals as 5:00 | 4:59 | 5:00 | 5:00.
    // At the active 3s rate that happens twice a minute, on the state a user
    // watches for the whole of their own turn.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(
        state({
          warmth: warmth({ state: 'answering', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
        }),
      )
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('answering'))
      expect(container.textContent).toContain('5:00')

      // Five local ticks, and one poll's worth of them, so both the ticking and
      // the re-stamp that used to reset it have happened.
      await vi.advanceTimersByTimeAsync(5_000)

      expect(container.textContent).toContain('5:00')
      expect(container.textContent).not.toMatch(/4:5\d/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still TICKS the warm window down, which is a different number', async () => {
    // The other half of the fix above: `warm` carries what is LEFT of the
    // window, so holding it still would freeze a real countdown — the failure
    // "render everything statically" would introduce while making the test
    // above pass.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(
        state({
          warmth: warmth({ state: 'ready', secondsUntilScaledown: 120, scaledownSeconds: 300 }),
        }),
      )
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('2:00'))

      // Inside the settled poll interval, so nothing re-stamps: this moves only
      // because the client ticks it. Asserted as "it moved down", not as an
      // exact second — the tick and the receipt stamp are a microtask apart, so
      // the rendered figure is one of 1:55/1:56 depending on which side of a
      // tick the payload landed, and pinning either would be pinning that race.
      await vi.advanceTimersByTimeAsync(5_000)

      expect(container.textContent).not.toContain('2:00')
      expect(container.textContent).toMatch(/1:5\d/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls faster while the box is mid-transition than when it has settled', async () => {
    // The other half of "never seen": one 15s interval for every state meant the
    // cold -> warm flip a user's own message causes landed up to fifteen seconds
    // after the answer they were watching for.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(
        state({
          warmth: warmth({ state: 'starting', secondsUntilScaledown: null, scaledownSeconds: 300 }),
        }),
      )
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('starting'))
      const afterMount = getPreviewHeaderState.mock.calls.length

      // Well inside the settled interval, and past several active ones.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(getPreviewHeaderState.mock.calls.length).toBeGreaterThan(afterMount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT poll at the active rate once the box has settled', async () => {
    vi.useFakeTimers()
    try {
      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('ready'))
      const afterMount = getPreviewHeaderState.mock.calls.length

      await vi.advanceTimersByTimeAsync(10_000)
      expect(getPreviewHeaderState.mock.calls.length).toBe(afterMount)
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

describe('starting the box from the header', () => {
  it('offers the start under the pointer while cold, and reports the state otherwise', async () => {
    getPreviewHeaderState.mockResolvedValue(cold())
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))

    // At rest it still says what the box IS — the affordance must not displace
    // the state a user came to read.
    expect(container.textContent).not.toContain(IGNITE_LABEL)

    fireEvent.mouseEnter(indicator(container))
    await waitFor(() => expect(container.textContent).toContain(IGNITE_LABEL))

    fireEvent.mouseLeave(indicator(container))
    await waitFor(() => expect(container.textContent).not.toContain(IGNITE_LABEL))
  })

  it('is a real button while cold, named for the ACTION rather than the state', async () => {
    // A clickable div would be invisible to the keyboard, and naming it "cold"
    // would announce a state where a control was pressed.
    getPreviewHeaderState.mockResolvedValue(cold())
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))

    const el = indicator(container)
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-label')).toBe(IGNITE_LABEL)
  })

  it('is NOT a button when the box is already up — there is nothing to press', async () => {
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('ready'))

    expect(indicator(container).tagName).not.toBe('BUTTON')
    fireEvent.mouseEnter(indicator(container))
    await waitFor(() => expect(container.textContent).toContain('ready'))
    expect(container.textContent).not.toContain(IGNITE_LABEL)
  })

  it('is NOT a button while STARTING — a replica is already engaged', async () => {
    // The suppression rule the design settled: the start button renders ONLY in
    // `cold` (and `unknown`, below). A replica present means a wake is already
    // underway or the container is loading weights — a second start would only
    // queue behind the first on a single-replica deployment.
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({
          state: 'starting',
          secondsUntilScaledown: null,
          coldStartEstimateMs: 120_000,
          coldStartBasis: 'default',
          coldStartSamples: 0,
        }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('starting'))

    expect(indicator(container).tagName).not.toBe('BUTTON')
    fireEvent.mouseEnter(indicator(container))
    await waitFor(() => expect(container.textContent).toContain('starting'))
    expect(container.textContent).not.toContain(IGNITE_LABEL)
  })

  it('is NOT a button while ANSWERING — a turn is on the box', async () => {
    getPreviewHeaderState.mockResolvedValue(
      state({
        warmth: warmth({ state: 'answering', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
      }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('answering'))

    expect(indicator(container).tagName).not.toBe('BUTTON')
    fireEvent.mouseEnter(indicator(container))
    await waitFor(() => expect(container.textContent).toContain('answering'))
    expect(container.textContent).not.toContain(IGNITE_LABEL)
  })

  it('KEEPS the start button available in "unknown" — the probe failing is not a reason to strand the user', async () => {
    // The reversed policy (owner decision, 2026-08-29): `unknown` now means the
    // CONTROL PLANE could not be asked, not that the box is unknowable — and
    // `igniteVerdaBox` is independent of the probe. Withholding the one control
    // that could fix the situation would punish the user for a status API's
    // downtime. This is the case the old file deliberately refused; the
    // decision is new and the button follows it.
    getPreviewHeaderState.mockResolvedValue(
      state({ warmth: warmth({ state: 'unknown', secondsUntilScaledown: null }) }),
    )
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('unknown'))

    const el = indicator(container)
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-label')).toBe(IGNITE_LABEL)

    fireEvent.mouseEnter(el)
    await waitFor(() => expect(container.textContent).toContain(IGNITE_LABEL))
  })

  it('clicking starts the box and settles on what the server then says', async () => {
    getPreviewHeaderState.mockResolvedValue(cold())
    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))

    fireEvent.click(indicator(container))

    await waitFor(() => expect(container.textContent).toContain('ready'))
    expect(igniteVerdaBox).toHaveBeenCalledTimes(1)
    // The countdown the server returned is on screen — the whole point.
    expect(container.textContent).toContain('5:00')
  })

  it('sends ONE wake however many times it is clicked', async () => {
    // The dedupe that matters is `ensureVerdaAwake`'s, on the server; this is
    // the client half — a second click while the first is out must not open a
    // second request for the same box.
    getPreviewHeaderState.mockResolvedValue(cold())
    let release: (v: unknown) => void = () => {}
    igniteVerdaBox.mockReturnValue(new Promise((r) => (release = r)))

    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))

    fireEvent.click(indicator(container))
    fireEvent.click(indicator(container))
    fireEvent.click(indicator(container))

    expect(igniteVerdaBox).toHaveBeenCalledTimes(1)
    release(
      state({
        warmth: warmth({ state: 'ready', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
      }),
    )
    await waitFor(() => expect(container.textContent).toContain('ready'))
  })

  it('says it is starting while the wake is out, rather than still reading "cold"', async () => {
    // The server answers `cold` for the whole ping — nothing has completed yet —
    // so without a local pending state the button a user just pressed would sit
    // reading "cold" for the minutes the start actually takes.
    getPreviewHeaderState.mockResolvedValue(cold())
    let release: (v: unknown) => void = () => {}
    igniteVerdaBox.mockReturnValue(new Promise((r) => (release = r)))

    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))
    fireEvent.click(indicator(container))

    await waitFor(() => expect(container.textContent).toContain('starting GPU'))
    expect(container.querySelector('.cold-start-spin'), 'no spinner glyph').toBeTruthy()

    release(
      state({
        warmth: warmth({ state: 'ready', secondsUntilScaledown: 300, scaledownSeconds: 300 }),
      }),
    )
    await waitFor(() => expect(container.textContent).toContain('ready'))
  })

  it('surfaces a wake that failed instead of quietly going back to "cold"', async () => {
    // A box that did not come up is the difference between "your next message is
    // slow" and "your next message will not work", and the strip is the only
    // place that click can report from.
    getPreviewHeaderState.mockResolvedValue(cold())
    igniteVerdaBox.mockRejectedValue(new Error('the private inference box did not wake'))

    const { container } = render(() => <PreviewHeaderStrip />)
    await waitFor(() => expect(container.textContent).toContain('cold'))
    fireEvent.click(indicator(container))

    await waitFor(() => expect(container.textContent).toContain(IGNITE_FAILED_LABEL))
    const banner = container.querySelector('[data-testid="verda-ignite-failed"]')!
    // The words say a START failed. "stale" is the vocabulary for numbers that
    // are merely old, and it was what this reported: a user who pressed start,
    // was told to expect minutes and looked away could not tell the two apart.
    expect(container.textContent).not.toContain('stale')
    // Worth interrupting for — unlike a stale poll, this is the outcome of
    // something the user pressed and then stopped watching.
    expect(banner.getAttribute('role')).toBe('alert')
    // The sentence the box gave is still reachable; it does not fit a top bar.
    expect(banner.getAttribute('title')).toContain('did not wake')
  })

  it('keeps saying so when the polls that follow succeed', async () => {
    // The other half of the defect, and the half a user actually met: the
    // failure rode the poll's error channel, so `load()`'s `setError(null)`
    // wiped it on the next successful poll — three seconds later at the active
    // rate, against a wake the same strip had just said would take minutes.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(cold())
      igniteVerdaBox.mockRejectedValue(new Error('the private inference box did not wake'))

      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('cold'))
      fireEvent.click(indicator(container))
      await vi.waitFor(() => expect(container.textContent).toContain(IGNITE_FAILED_LABEL))

      // Several polls, all of them fine, all of them still reporting a cold box.
      const before = getPreviewHeaderState.mock.calls.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(getPreviewHeaderState.mock.calls.length).toBeGreaterThan(before)

      expect(container.textContent).toContain(IGNITE_FAILED_LABEL)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the failure once the box is actually up, whoever brought it up', async () => {
    // The one thing that clears it, and the reason it is not simply permanent:
    // "the start failed" is false about a box that is running, and the strip
    // must not keep saying it. Note this is the box coming UP, not a poll
    // merely succeeding — that distinction is the whole of the case above.
    vi.useFakeTimers()
    try {
      getPreviewHeaderState.mockResolvedValue(cold())
      igniteVerdaBox.mockRejectedValue(new Error('the private inference box did not wake'))

      const { container } = render(() => <PreviewHeaderStrip />)
      await vi.waitFor(() => expect(container.textContent).toContain('cold'))
      fireEvent.click(indicator(container))
      await vi.waitFor(() => expect(container.textContent).toContain(IGNITE_FAILED_LABEL))

      getPreviewHeaderState.mockResolvedValue(state())
      await vi.advanceTimersByTimeAsync(20_000)

      await vi.waitFor(() => expect(container.textContent).toContain('ready'))
      expect(container.textContent).not.toContain(IGNITE_FAILED_LABEL)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Admin page render (#1047): the control, the live state, the running-since
 * figures — and the refusal a non-admin sees instead of any of them.
 *
 * The page's two server functions are stubbed, so what is pinned is what the
 * DOM shows for each answer: the switch for an admin, the forbidden panel for
 * the 403 the server answers for everyone else, the inert explanation for an
 * unconfigured deployment, and a failure report that never silently
 * reverts the switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  set: vi.fn(),
  header: vi.fn(),
}))

vi.mock('~/lib/harness-client/gpu-admin.server', () => ({
  getGpuAdminState: mocks.admin,
  setGpuKeepRunning: mocks.set,
}))

vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: mocks.header,
}))

import { MemoryRouter, Route } from '@solidjs/router'
import Admin, { GPU_KEEP_LABEL } from '~/routes/admin'

/** A settled, configured, switched-off deployment owned by an admin. The
 *  per-box up-sinces default to `1`, which predates every switch-on stamp in
 *  these tests, so the meter's `max(upSince, switch-on)` clamp picks the
 *  stamp — a box already up when the switch flipped is billed from the flip.
 *  The tests that pin the reload rule override them with real values. */
const ADMIN_STATE = {
  keepRunning: false,
  switchedOnAt: null,
  configured: true,
  largeEurPerHour: 4.6,
  smallEurPerHour: 1.07418,
  largeOnOpenRouter: false,
  largeUpSince: 1,
  smallState: 'ready',
  smallUpSince: 1,
} as const

/** A header payload with the 27B up — one the server can actually send: an
 *  up box has a RECENT answer (240s left of its 300s window — the keep-warm
 *  pings refresh the answer roughly every 100s), and the per-box timestamps
 *  are not in this payload at all. They are admin-only fields and ride the
 *  admin payload (`gpu-admin.server.ts`), for which `ADMIN_STATE` above is
 *  the stand-in; `preview-header.test.ts` pins the other side of that move. */
const WARM_READY = {
  tier: 'self_deployed',
  selfDeployedAvailable: true,
  warmth: {
    state: 'ready',
    secondsUntilScaledown: 240,
    scaledownSeconds: 300,
    coldStartEstimateMs: null,
    coldStartBasis: null,
    coldStartSamples: null,
  },
  activeUsers: 1,
  activeWindowMinutes: 15,
  usage: {},
  latency: {},
  generatedAt: 1,
} as const

beforeEach(() => {
  vi.resetAllMocks()
  mocks.admin.mockResolvedValue(ADMIN_STATE)
  mocks.header.mockResolvedValue(WARM_READY)
})

describe('the admin page', () => {
  it('renders the control with the owner’s wording, reading Off from the state', async () => {
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const control = await screen.findByRole('checkbox', { name: GPU_KEEP_LABEL })
    expect((control as HTMLInputElement).checked).toBe(false)
  })

  it('reads On from the state, with the running-since line beside it', async () => {
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: Date.now() - 3_600_000,
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const control = await screen.findByRole('checkbox', { name: GPU_KEEP_LABEL })
    expect((control as HTMLInputElement).checked).toBe(true)
  })

  it('shows the live warmth word and figure, from the same payload the header renders', async () => {
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const warmth = await screen.findByTestId('gpu-warmth')
    expect(warmth.textContent).toContain('ready')
    expect(warmth.textContent).not.toContain('cold')
  })

  it('shows running since, the per-hour prices and the accrued floor while the switch is on', async () => {
    const since = Date.now() - 2 * 3_600_000 // two hours of H100
    mocks.admin.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: since })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const line = await screen.findByTestId('gpu-keep-since')
    expect(line.textContent).toContain('Kept running since')
    expect(line.textContent).toContain('€5.67/hour') // 4.6 + 1.07418, two decimals
    expect(line.textContent).toContain('€4.60/h')
    expect(line.textContent).toContain('€1.07/h')
    // Two hours at €5.67/h — a floor, labelled one.
    const soFar = await screen.findByText(/so far/)
    expect(soFar.textContent).toContain('≥')
    expect(soFar.textContent).toMatch(/€11\.\d\d/)
  })

  it('accrues the 4B’s rate on the OpenRouter route while the 4B is up — the 27B is not ours to meter there', async () => {
    const since = Date.now() - 2 * 3_600_000 // two hours of the 4B alone
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeOnOpenRouter: true,
    })
    // The 27B is a public per-token API on that route, not a box of ours:
    // the wake skips it, so nothing reports it up and its reading is cold.
    // The 4B is up — the loop keeps it in every configuration — and it is
    // billed the whole time, so the meter must run on it.
    mocks.header.mockResolvedValue({
      ...WARM_READY,
      warmth: { ...WARM_READY.warmth, state: 'cold', secondsUntilScaledown: null },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const line = await screen.findByTestId('gpu-keep-since')
    // The 4B's rate alone — the loop keeps no 27B box on that route, so the
    // figure must not price one (the wake skips it for the same reason).
    expect(line.textContent).toContain('€1.07/hour')
    expect(line.textContent).not.toContain('€4.60')
    expect(line.textContent).toContain('OpenRouter')
    // Two hours at €1.07/h, not at €5.67/h — and not at €0 while the 4B is
    // billed, which is what metering the 27B's up-state alone would show.
    const soFar = await screen.findByText(/so far/)
    expect(soFar.textContent).toMatch(/€2\.15/)
  })

  it('re-bills the run so far after a reload — both boxes up since two hours, about two hours charged', async () => {
    // The reload rule (#1047 round 3 -> round 4): the server records a real
    // per-box UP-SINCE, and the meter seeds each box from
    // `max(upSince, switch-on)` — so a reload re-bills the time the boxes
    // were actually up through this switch-on. The fixture is one the server
    // can send: both boxes up since the flip, a recent answer on each (240s
    // left of the 300s window the keep-warm pings refresh).
    const since = Date.now() - 2 * 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeUpSince: since,
      smallUpSince: since,
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    // Two hours at both rates (4.6 + 1.07418 per hour), not ~zero — which is
    // what seeding from the last keep-warm ping would have shown.
    expect(soFar.textContent).toMatch(/€11\.\d\d/)
  })

  it('charges from the up-since, not the switch-on, when the boxes came up later — one hour, not two', async () => {
    // The switch went on two hours ago; the boxes first answered an hour
    // later (the cold start). The seed is the up-since, so the cold start
    // before it is not re-billed by a reload — and neither is the switch-on
    // stamp it sits inside.
    const since = Date.now() - 2 * 3_600_000
    const upSince = Date.now() - 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeUpSince: upSince,
      smallUpSince: upSince,
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    expect(soFar.textContent).toMatch(/€5\.67/)
    expect(soFar.textContent).not.toMatch(/€11/)
  })

  it('starts from its own observation when the server has no up-since — the restart case, a floor', async () => {
    // A server restart loses the in-memory up-since, and the meter then
    // starts from what this page observed itself: ~nothing at first render,
    // growing only with the real time it sees. Under-stating is the direction
    // a floor may err in — the tooltip says so.
    const since = Date.now() - 2 * 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeUpSince: null,
      smallUpSince: null,
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    expect(soFar.textContent).toMatch(/€0\.00/)
  })

  it('does not count the 4B while it is STARTING — a wake in flight buys no GPU time yet', async () => {
    // The surviving mutant of round 3: `up.small` keys on `ready` alone.
    // A starting 4B carries no up-since (the server clears it — nothing
    // proves the box up), so counting it as up would accrue from this page's
    // own observation and the figure would grow while nothing is billed.
    // MUTATION: add `|| s?.smallState === 'starting'` to the up map and this
    // reddens — the figure leaves €0.0000 within the wait below.
    const since = Date.now() - 2 * 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeUpSince: null,
      smallState: 'starting',
      smallUpSince: null,
    })
    // A cold 27B beside it: neither box is billable, so nothing may accrue.
    mocks.header.mockResolvedValue({
      ...WARM_READY,
      warmth: { ...WARM_READY.warmth, state: 'cold', secondsUntilScaledown: null },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    // Long enough for several meter ticks: the figure must not move at all.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(screen.getByText(/so far/).textContent).toBe(soFar.textContent)
    expect(screen.getByText(/so far/).textContent).toMatch(/€0\.0000/)
  })

  it('counts the 27B while it is ANSWERING — a running turn is billable up-time', async () => {
    // The other surviving mutant: `up.large` keys on `ready` OR `answering`.
    // A turn in flight on a warm box is up-time being billed right now, so
    // the meter must run; dropping `answering` would freeze it at ~zero
    // while the 27B pays for the turn. MUTATION: key on `ready` alone and
    // this reddens.
    const since = Date.now() - 2 * 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeUpSince: since,
      smallState: 'cold',
      smallUpSince: null,
    })
    // `answering` re-sends its countdown whole on each poll — 300s of it.
    mocks.header.mockResolvedValue({
      ...WARM_READY,
      warmth: { ...WARM_READY.warmth, state: 'answering', secondsUntilScaledown: 300 },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    // Two hours at the 27B's rate alone — the 4B is cold and skipped.
    expect(soFar.textContent).toMatch(/€9\.2\d/)
  })

  it('ticks the "so far" figure while the page is open and a box is up', async () => {
    mocks.admin.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: Date.now() })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await screen.findByTestId('gpu-keep-since')
    const read = () => screen.getByText(/so far/).textContent!.match(/€[\d.]+/)![0]
    const first = read()
    // The 1-second clock the strip's countdown uses: the meter moves on it,
    // rather than freezing at page load until the next state change.
    await waitFor(() => expect(read()).not.toBe(first), { timeout: 5_000 })
  })

  it('does not accrue while no box is up: the figure stays at zero until one is', async () => {
    // BOTH boxes read cold — the 27B from the header payload, the 4B from the
    // admin payload, which is where its state rides since round 4.
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: Date.now(),
      smallState: 'cold',
      smallUpSince: null,
    })
    mocks.header.mockResolvedValue({
      ...WARM_READY,
      warmth: { ...WARM_READY.warmth, state: 'cold', secondsUntilScaledown: null },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    // Long enough for several meter ticks: a wake that keeps failing buys no
    // GPU time, so the meter must not grow while it fails.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(screen.getByText(/so far/).textContent).toBe(soFar.textContent)
    expect(screen.getByText(/so far/).textContent).toMatch(/€0\.0000/)
  })

  it('flips the switch through the RPC and re-reads both halves', async () => {
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await screen.findByRole('checkbox', { name: GPU_KEEP_LABEL })
    mocks.set.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: Date.now() })

    await fireEvent.click(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL }))
    await waitFor(() => expect(mocks.set).toHaveBeenCalledExactlyOnceWith(true))
    // The read and the re-read — awaited rather than assumed, because the
    // re-read rides the serialized read cycle and lands a tick after the RPC.
    await waitFor(() => expect(mocks.admin).toHaveBeenCalledTimes(2))
  })

  it('reports a failed flip without pretending the switch is off', async () => {
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await screen.findByRole('checkbox', { name: GPU_KEEP_LABEL })
    mocks.set.mockRejectedValue(new Error('the private inference box did not wake'))
    // The state re-read answers ON — the switch is left on, not auto-off.
    mocks.admin.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: Date.now() })

    await fireEvent.click(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL }))
    const report = await screen.findByTestId('gpu-keep-failed')
    expect(report.textContent).toContain('did not wake')
    expect(report.textContent).toContain('left on')
  })

  it('renders an inert explanation when the deployment has no private tier', async () => {
    mocks.admin.mockResolvedValue({ ...ADMIN_STATE, configured: false })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await screen.findByText(/not configured on this deployment/)
    expect(
      (screen.getByRole('checkbox', { name: GPU_KEEP_LABEL }) as HTMLInputElement).disabled,
    ).toBe(true)
  })

  it('shows a non-admin the forbidden panel — no switch, no figures', async () => {
    mocks.admin.mockRejectedValue(new Response('no', { status: 403 }))
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await screen.findByTestId('gpu-admin-forbidden')
    expect(screen.queryByRole('checkbox', { name: GPU_KEEP_LABEL })).toBeNull()
    expect(screen.queryByTestId('gpu-keep-since')).toBeNull()
    expect(screen.getByText('Admin only')).toBeTruthy()
  })
})

// The round-5 blocking defect, as page tests: the 4B's state and both boxes'
// up-sinces ride the ADMIN payload, so they only stay live if the poll that
// refreshes the header warmth RE-READS that payload too — a poll that
// refreshed only the header froze the 4B at whatever page load saw, and the
// meter billed a box that was down forever and never billed one that came up.
// MUTATION: drop the admin re-read from the poll (the `readBoth` cycle) and
// BOTH tests below redden.
//
// Fake timers throughout: the poll's 15s cadence (the header stays `ready`,
// the strip's settled rate) and the meter's 1s tick both run on the clock,
// and `Date.now()` moves with `advanceTimersByTimeAsync`.
//
// Both cases use the OpenRouter route (`largeOnOpenRouter: true`), so the 27B
// is a public per-token API the loop keeps no box for: every cent the figure
// shows is the 4B's, which is the box whose state rides the admin payload.
describe('the poll re-reads the admin payload — the 4B is live, not frozen at load', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** The meter's current figure, as a number off the rendered `so far` line. */
  const readEur = (): number =>
    Number(screen.getByText(/so far/).textContent!.match(/€([\d.]+)/)![1])

  /** A switched-on deployment where only the 4B is metered (OpenRouter route). */
  const onlySmall = (smallState: 'ready' | 'starting' | 'cold') => ({
    ...ADMIN_STATE,
    keepRunning: true,
    switchedOnAt: Date.now(),
    largeOnOpenRouter: true,
    largeUpSince: null,
    smallState,
    // Null on purpose: the page seeds from its own observation, so the figure
    // the tests watch move is purely the page's own accrual, not a server stamp.
    smallUpSince: null,
  })

  it('stops billing the 4B when it goes down between polls — the meter stops growing', async () => {
    mocks.admin.mockResolvedValue(onlySmall('ready'))
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    expect(readEur()).toBe(0)
    // Five seconds of ticks with the 4B up: the meter runs.
    await vi.advanceTimersByTimeAsync(5_000)
    const running = readEur()
    expect(running).toBeGreaterThan(0)
    // The 4B goes down. The next poll (the 15s cadence, the same one the
    // header warmth rides) must notice and stop the meter.
    mocks.admin.mockResolvedValue(onlySmall('cold'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(readEur()).toBe(0) // a down box bills nothing
    // Several more seconds of ticks: it must stay stopped, not resume.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(readEur()).toBe(0)
  })

  it('starts billing the 4B when it comes up between polls — the meter starts accruing', async () => {
    mocks.admin.mockResolvedValue(onlySmall('starting'))
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    expect(readEur()).toBe(0)
    // Five seconds of ticks while the 4B is still STARTING: a wake in flight
    // buys no GPU time yet, and the meter must not move.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(readEur()).toBe(0)
    // The 4B comes up. The next poll must notice and start the meter.
    mocks.admin.mockResolvedValue(onlySmall('ready'))
    await vi.advanceTimersByTimeAsync(20_000)
    const started = readEur()
    expect(started).toBeGreaterThan(0)
    // And it keeps accruing, rather than ticking once and freezing.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(readEur()).toBeGreaterThan(started)
  })
})

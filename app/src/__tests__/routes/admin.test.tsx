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
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  set: vi.fn(),
  stop: vi.fn(),
  header: vi.fn(),
}))

vi.mock('~/lib/harness-client/gpu-admin.server', () => ({
  getGpuAdminState: mocks.admin,
  setGpuKeepRunning: mocks.set,
  stopGpuBoxNow: mocks.stop,
}))

vi.mock('~/lib/harness-client/preview-header.server', () => ({
  getPreviewHeaderState: mocks.header,
}))

import { MemoryRouter, Route } from '@solidjs/router'
import Admin, { GPU_KEEP_LABEL, GPU_READ_TIMEOUT_MS } from '~/routes/admin'

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
  // #1057: the Modal control half — null is the unconfigured route, the
  // default every test here starts from.
  modal: null,
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

  it('#1057: seeds from the CONTROL PLANE’s container start when it reports one — Modal bills from container creation', async () => {
    // The switch went on two hours ago; Modal reports the 27B’s container
    // started an hour ago — the honest bill start, because Modal bills while
    // the container exists. The seed is the container start when there is
    // one, the process clock only otherwise, so the meter follows the thing
    // that bills rather than the thing this process happened to see.
    const since = Date.now() - 2 * 3_600_000
    const containerStart = Date.now() - 3_600_000
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      // The restart case on both halves: no process up-since for either box,
      // and the 4B observed cold — so the ONLY seed in the figure is the
      // control plane's container start.
      largeUpSince: null,
      smallUpSince: null,
      smallState: 'cold',
      modal: {
        large: {
          state: 'up',
          containers: 1,
          containerStartedAtMs: containerStart,
          restored: true,
          gpu: 'NVIDIA H100',
          reason: null,
        },
        small: {
          state: 'cold',
          containers: 0,
          containerStartedAtMs: null,
          restored: null,
          gpu: null,
          reason: null,
        },
      },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    const soFar = await screen.findByText(/so far/)
    // One hour of the 27B only — the container-start seed, not the switch-on
    // (two hours), and not nothing (the null process up-since).
    expect(soFar.textContent).toMatch(/€4\.60/)
    expect(soFar.textContent).not.toMatch(/€9/)
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

  /** A switched-on deployment where only the 4B is metered (OpenRouter
   *  route). The switch-on stamp is a PARAMETER, never `Date.now()` at payload
   *  build time: a fresh stamp per payload restarts the meter, which is how
   *  the round-6 review caught this file's old down-test passing — a meter
   *  restarted at the down-flip reads €0 for reasons that have nothing to do
   *  with the down box, so "frozen" and "dropped" were indistinguishable. */
  const onlySmall = (smallState: 'ready' | 'starting' | 'cold', since: number) => ({
    ...ADMIN_STATE,
    keepRunning: true,
    switchedOnAt: since,
    largeOnOpenRouter: true,
    largeUpSince: null,
    smallState,
    // Null on purpose: the page seeds from its own observation, so the figure
    // the tests watch move is purely the page's own accrual, not a server stamp.
    smallUpSince: null,
  })

  it('stops ADDING to the figure when the 4B goes down between polls — but keeps what it cost', async () => {
    // Round 6: this test used to build a FRESH `switchedOnAt` into every
    // payload, so the down-flip restarted the meter and its €0 assertions
    // passed for a reason that was not the down box. The stamp is held FIXED
    // now, so what it pins is the real property: a down box stops the meter
    // ADDING, without dropping what the box already cost.
    const stamp = Date.now()
    mocks.admin.mockResolvedValue(onlySmall('ready', stamp))
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
    // The 4B goes down — SAME stamp, so this cannot pass by restarting the
    // meter. The page keeps the last good payload until the next poll
    // notices, so it bills the stretch up to that tick (the reviewer's probe
    // charged the same 15 s); what must never happen is a drop afterwards.
    mocks.admin.mockResolvedValue(onlySmall('cold', stamp))
    await vi.advanceTimersByTimeAsync(20_000) // the 15 s poll notices
    const frozen = readEur()
    expect(frozen).toBeGreaterThan(running) // it billed up to the poll that noticed
    // Several more polls' worth of ticks: frozen at the last value — not 0,
    // not growing. A down box bills nothing NEW without refunding the past.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(readEur()).toBe(frozen)
  })

  it('starts billing the 4B when it comes up between polls — the meter starts accruing', async () => {
    const stamp = Date.now()
    mocks.admin.mockResolvedValue(onlySmall('starting', stamp))
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
    mocks.admin.mockResolvedValue(onlySmall('ready', stamp))
    await vi.advanceTimersByTimeAsync(20_000)
    const started = readEur()
    expect(started).toBeGreaterThan(0)
    // And it keeps accruing, rather than ticking once and freezing.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(readEur()).toBeGreaterThan(started)
  })
})

// Round 6, spec item 1 (BLOCKING): what a priced box has ALREADY cost since the
// switch went on must stay in the "so far" figure while that box is down — a
// down box only stops ADDING time. The switch-on stamp is held FIXED throughout
// each test, so nothing here can pass by restarting the meter: box up 10
// minutes → figure X; box goes down → the figure stays X across several polls
// (not €0.00, not growing); box comes back → the figure grows from X.
//
// MUTATION: put the old `if (!up[box]) continue` back before the accrued
// amount is added to `eur` (the round-5 blocking defect) and BOTH tests
// redden — the figure drops to €0.00 the moment the box goes down.
//
// Fake timers throughout, same as the describe above: the poll's 15 s cadence
// and the meter's 1 s tick both run on the clock, and `Date.now()` moves with
// `advanceTimersByTimeAsync`.
describe('the meter keeps what a down box already cost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** The meter's current figure, as a number off the rendered `so far` line. */
  const readEur = (): number =>
    Number(screen.getByText(/so far/).textContent!.match(/€([\d.]+)/)![1])

  /** The header payload with the 27B cold — no countdown, no up-state. */
  const COLD_HEADER = {
    ...WARM_READY,
    warmth: { ...WARM_READY.warmth, state: 'cold' as const, secondsUntilScaledown: null },
  }

  it('27B: holds the accrued figure across down polls and grows again when the box returns', async () => {
    const stamp = Date.now()
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: stamp,
      largeUpSince: stamp,
      smallState: 'cold',
      smallUpSince: null,
    })
    mocks.header.mockResolvedValue(WARM_READY) // the 27B is up
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    // Ten minutes with the 27B up: about €0.77 of H100.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // The 27B goes down. The next poll (15 s) is what notices; the meter
    // bills the stretch up to that tick, then stops ADDING.
    mocks.header.mockResolvedValue(COLD_HEADER)
    await vi.advanceTimersByTimeAsync(20_000)
    const x = readEur()
    expect(x).toBeGreaterThan(0.7) // ten minutes of H100 — NOT €0.00
    // Several polls' worth of ticks while the box is down: the figure stays
    // exactly X — the box's past cost is not refunded by its going down.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(readEur()).toBe(x)
    // The box comes back: the figure grows from X, not from zero.
    mocks.header.mockResolvedValue(WARM_READY)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readEur()).toBeGreaterThan(x)
  })

  it('4B on the OpenRouter route: the same shape — held while down, grown from when back', async () => {
    const stamp = Date.now()
    const payload = (smallState: 'ready' | 'cold') => ({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: stamp,
      largeOnOpenRouter: true,
      largeUpSince: null,
      smallState,
      // Null even while up: the page seeds from its own observation, so the
      // figure is purely its own accrual — and null when down, which is what
      // the server sends for a box nothing has proven up.
      smallUpSince: null,
    })
    mocks.admin.mockResolvedValue(payload('ready'))
    // The 27B rides OpenRouter on this route — no box of ours to keep, none
    // to meter — so every cent of the figure is the 4B's, from the ADMIN
    // payload the poll must re-read to see the box go down at all.
    mocks.header.mockResolvedValue(COLD_HEADER)
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    // Ten minutes with the 4B up: about €0.18.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    mocks.admin.mockResolvedValue(payload('cold'))
    await vi.advanceTimersByTimeAsync(20_000) // the 15 s poll notices
    const x = readEur()
    expect(x).toBeGreaterThan(0.15) // ten minutes of the 4B — NOT €0.00
    await vi.advanceTimersByTimeAsync(35_000)
    expect(readEur()).toBe(x) // held, not dropped, not growing
    mocks.admin.mockResolvedValue(payload('ready'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readEur()).toBeGreaterThan(x) // grown from X when the box returned
  })
})

// Round 6, spec items 2–4: the poll's failure discipline. The round-5 review
// named each property below as untested (each mutant passed all 77 tests):
// a read that never settles must not wedge the poll or the switch (each read
// gets a timeout); a non-admin's first-read refusal stops the poll for good;
// a failed RE-read keeps the admin panel; a tick while a cycle is in flight
// skips rather than queueing; and at most one cycle is ever in flight. Every
// test names the mutation that reddens it.
describe('the poll’s failure discipline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts a read that never settles as failed after its timeout — the poll is not wedged', async () => {
    // MUTATION: drop the `withReadTimeout` from `loadAdmin` and the second
    // read hangs forever — the third call this test waits for never happens.
    mocks.admin
      .mockResolvedValueOnce(ADMIN_STATE)
      .mockImplementationOnce(() => new Promise(() => {})) // the next read hangs
      .mockResolvedValue(ADMIN_STATE)
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    // The 15 s poll tick: its admin read never settles.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.admin).toHaveBeenCalledTimes(2)
    // The timeout fires: the read counts as failed, the last good payload
    // stays on screen and the forbidden panel does not appear.
    await vi.advanceTimersByTimeAsync(GPU_READ_TIMEOUT_MS)
    expect(screen.queryByTestId('gpu-admin-forbidden')).toBeNull()
    expect(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL })).toBeTruthy()
    // …and the NEXT tick's cycle runs: one hung read has not wedged the poll.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.admin).toHaveBeenCalledTimes(3)
  })

  it('does not leave the switch stuck on "starting the boxes…" when the flip’s re-read never settles', async () => {
    // The flip's own RPC is allowed minutes (a cold wake); the RE-read it
    // waits for is not. MUTATION: drop the `withReadTimeout` from `loadAdmin`
    // and the busy state below never clears.
    mocks.admin.mockResolvedValueOnce(ADMIN_STATE).mockImplementation(() => new Promise(() => {})) // every later read hangs
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    const checkbox = screen.getByRole('checkbox', { name: GPU_KEEP_LABEL })
    mocks.set.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: Date.now() })
    await fireEvent.click(checkbox)
    await vi.advanceTimersByTimeAsync(0) // the RPC answers; its re-read hangs
    expect(screen.getByTestId('gpu-keep-busy')).toBeTruthy() // starting the boxes…
    // The re-read never settles; its timeout still ends the flip's wait.
    await vi.advanceTimersByTimeAsync(GPU_READ_TIMEOUT_MS + 1_000)
    expect(screen.queryByTestId('gpu-keep-busy')).toBeNull()
  })

  it('stops polling after the first read is refused — a non-admin is not a temporary condition', async () => {
    // MUTATION: drop the `refusedForGood` check in `poll()` and the four
    // ticks below each add another 403'd call to the count.
    mocks.admin.mockRejectedValue(new Response('no', { status: 403 }))
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read is refused
    expect(screen.getByTestId('gpu-admin-forbidden')).toBeTruthy()
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    expect(mocks.header).toHaveBeenCalledTimes(1)
    // Four poll ticks later: not one more call to the refused endpoint — nor
    // to anything else, since the forbidden panel replaced everything the
    // poll refreshed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    expect(mocks.header).toHaveBeenCalledTimes(1)
  })

  it('keeps the admin panel when a RE-read fails — the refusal panel is the first read’s business alone', async () => {
    // MUTATION: make `loadAdmin`'s catch drop the payload (`setAdmin(null)`)
    // and the checkbox this test looks for after the failures is gone.
    mocks.admin
      .mockResolvedValueOnce(ADMIN_STATE)
      .mockRejectedValue(new Error('the server did not answer'))
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    expect(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL })).toBeTruthy()
    // Several poll cycles, every one of them failing: the page keeps the last
    // good payload on screen rather than flipping to the refusal panel.
    await vi.advanceTimersByTimeAsync(50_000)
    expect(mocks.admin.mock.calls.length).toBeGreaterThan(3) // it kept polling
    expect(screen.queryByTestId('gpu-admin-forbidden')).toBeNull()
    expect(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL })).toBeTruthy()
  })

  it('skips a poll tick while a cycle is in flight — ticks do not queue cycles behind it', async () => {
    // The header reports the 27B STARTING, so the poll runs at the strip's
    // 3 s ACTIVE cadence — ticks land INSIDE a cycle's lifetime, which is
    // where the skip guard matters. (At the settled 15 s cadence nothing
    // stays in flight across a tick any more: a read can no longer outlive
    // its own timeout.)
    // MUTATION: drop the `pollActive` guard in `poll()` and the ticks at
    // 3/6/9 s each queue a cycle; releasing the held read then runs all of
    // them at once and the count jumps past the 2 this test asserts.
    let release!: (value: typeof ADMIN_STATE) => void
    const held = new Promise<typeof ADMIN_STATE>((resolve) => {
      release = resolve
    })
    mocks.admin
      .mockImplementationOnce(() => held) // the mount read hangs
      .mockResolvedValue(ADMIN_STATE)
    mocks.header.mockResolvedValue({
      ...WARM_READY,
      warmth: { ...WARM_READY.warmth, state: 'starting' as const },
    })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount cycle is on the wire
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    // Three 3 s ticks land while that cycle is in flight (the header half of
    // the same cycle answered, which is what armed the 3 s cadence): none of
    // them starts a second fetch.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(mocks.admin).toHaveBeenCalledTimes(1)
    // The held read settles (before its own 10 s timeout): exactly ONE
    // catch-up cycle runs — not the three a tick-per-cycle queue would have
    // piled up behind the in-flight one.
    release(ADMIN_STATE)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.admin).toHaveBeenCalledTimes(2)
  })

  it('keeps at most one cycle in flight — a flip waits for the poll cycle it lands on', async () => {
    // MUTATION: break the serialization in `readBoth` (start the reads
    // instead of chaining them on `cycle`) and the flip below starts its
    // re-read while the poll's cycle is still on the wire — the count
    // this test asserts is 2 becomes 3.
    let release!: (value: typeof ADMIN_STATE) => void
    const held = new Promise<typeof ADMIN_STATE>((resolve) => {
      release = resolve
    })
    mocks.admin
      .mockResolvedValueOnce(ADMIN_STATE) // the mount read lands
      .mockImplementationOnce(() => held) // the first poll read hangs
      .mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: 1 })
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))
    await vi.advanceTimersByTimeAsync(0) // the mount read lands
    await vi.advanceTimersByTimeAsync(15_000) // the poll tick's read hangs
    expect(mocks.admin).toHaveBeenCalledTimes(2)
    mocks.set.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: 1 })
    await fireEvent.click(screen.getByRole('checkbox', { name: GPU_KEEP_LABEL }))
    await vi.advanceTimersByTimeAsync(0) // the RPC answers; its re-read queues
    // Serialized: the flip's re-read has NOT started a second fetch while
    // the poll's cycle is still on the wire.
    expect(mocks.admin).toHaveBeenCalledTimes(2)
    release(ADMIN_STATE)
    await vi.advanceTimersByTimeAsync(1_000)
    // The flip's read ran — once — and the switch shows what it wrote.
    expect(mocks.admin).toHaveBeenCalledTimes(3)
    expect(
      (screen.getByRole('checkbox', { name: GPU_KEEP_LABEL }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.queryByTestId('gpu-keep-busy')).toBeNull()
  })
})

// ============================================================================
// #1057: the Modal control plane's half of the payload
// ============================================================================
//
// The server half (`gpu-admin.test.ts`) pins what the payload carries; what
// is pinned here is what a person SEES for each answer: the fallback line
// while the route is unconfigured, one line per box once it is, and the
// stop-now button behind its confirmation — the one control that ends a
// billed container on purpose.
describe('#1057: the Modal control lines', () => {
  const renderAdmin = () =>
    render(() => (
      <MemoryRouter>
        <Route path="*" component={Admin as never} />
      </MemoryRouter>
    ))

  const UP_LARGE = {
    state: 'up',
    containers: 1,
    containerStartedAtMs: Date.now() - 12 * 60_000,
    restored: true,
    gpu: 'NVIDIA H100',
    reason: null,
  }
  const COLD_SMALL = {
    state: 'cold',
    containers: 0,
    containerStartedAtMs: null,
    restored: null,
    gpu: null,
    reason: null,
  }

  it('says Modal control unavailable (no token) while the route is unconfigured', async () => {
    renderAdmin()
    const card = await screen.findByTestId('gpu-modal-card')
    expect(card.textContent).toContain('Modal control unavailable (no token)')
    expect(card.textContent).toContain('keep-warm pings')
  })

  it('renders one line per box from the control plane, with the stop-now control per line', async () => {
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      modal: { large: UP_LARGE, small: COLD_SMALL },
    })
    renderAdmin()

    const large = await screen.findByTestId('gpu-modal-large')
    expect(large.textContent).toContain('27B')
    expect(large.textContent).toContain('up')
    expect(large.textContent).toContain('restored from a snapshot')
    expect(large.textContent).toContain('NVIDIA H100')
    expect(large.textContent).toContain('up for')
    expect(screen.getByTestId('gpu-modal-small').textContent).toContain('4B')
    expect(screen.getByTestId('gpu-modal-small').textContent).toContain('cold')

    // The stop control exists only where there is a container to stop.
    expect(within(large).getByRole('button', { name: /stop now/i })).toBeTruthy()
    expect(within(screen.getByTestId('gpu-modal-small')).queryByRole('button')).toBeNull()
  })

  it('renders the 27B’s NOT-STARTING line in the danger role — the failure is named, not waited out', async () => {
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      modal: {
        large: {
          ...COLD_SMALL,
          state: 'not-starting',
          reason: 'Modal reports no container after 400s of asking',
        },
        small: COLD_SMALL,
      },
    })
    renderAdmin()
    const large = await screen.findByTestId('gpu-modal-large')
    expect(large.textContent).toContain('NOT STARTING')
    expect(large.textContent).toContain('after 400s of asking')
  })

  it('stop now asks for a confirmation, and only the confirmed call stops', async () => {
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      modal: { large: UP_LARGE, small: COLD_SMALL },
    })
    mocks.stop.mockResolvedValue({ ...ADMIN_STATE })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderAdmin()

    const large = await screen.findByTestId('gpu-modal-large')
    await fireEvent.click(within(large).getByRole('button', { name: /stop now/i }))
    // Declined: nothing was stopped.
    expect(confirm).toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await fireEvent.click(within(large).getByRole('button', { name: /stop now/i }))
    expect(mocks.stop).toHaveBeenCalledWith('large')
    confirm.mockRestore()
  })

  it('labels the keep-warm mechanism as the fallback while the route is unconfigured', async () => {
    renderAdmin()
    // Unconfigured: the wake-and-wait wording, exactly today’s.
    expect((await screen.findByTestId('gpu-keep-card')).textContent).toContain(
      'wakes both GPUs now',
    )
  })

  it('says the switch drives Modal’s autoscaler while the route exists', async () => {
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      modal: { large: UP_LARGE, small: COLD_SMALL },
    })
    renderAdmin()
    // Configured: min_containers, and no request to either box.
    const card = await screen.findByTestId('gpu-keep-card')
    expect(card.textContent).toContain('min_containers=1')
    expect(card.textContent).toContain('no request is sent')
    expect((await screen.findByTestId('gpu-modal-card')).textContent).not.toContain('unavailable')
  })
})

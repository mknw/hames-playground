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
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

/** A settled, configured, switched-off deployment owned by an admin. */
const ADMIN_STATE = {
  keepRunning: false,
  switchedOnAt: null,
  configured: true,
  largeEurPerHour: 4.6,
  smallEurPerHour: 1.07418,
  largeOnOpenRouter: false,
} as const

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

  it('prices only the boxes the loop keeps: the 27B drops out on the OpenRouter route', async () => {
    const since = Date.now() - 2 * 3_600_000 // two hours of the 4B alone
    mocks.admin.mockResolvedValue({
      ...ADMIN_STATE,
      keepRunning: true,
      switchedOnAt: since,
      largeOnOpenRouter: true,
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
    // Two hours at €1.07/h, not at €5.67/h.
    const soFar = await screen.findByText(/so far/)
    expect(soFar.textContent).toMatch(/€2\.15/)
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
    mocks.admin.mockResolvedValue({ ...ADMIN_STATE, keepRunning: true, switchedOnAt: Date.now() })
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
    expect(mocks.admin).toHaveBeenCalledTimes(2) // the read and the re-read
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

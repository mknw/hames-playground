/**
 * The GPU admin panel's server actions (#1047) — the gate is the subject.
 *
 * The panel switches a shared, billed box on, so the owner's amendment made it
 * admin-only and made the refusal a REAL 403: a thrown `Response` is the
 * framework's own status channel (it crosses `toWireError` untouched and the
 * wire answer carries the status), so "hidden tab" can never be the only thing
 * standing between a non-admin and the switch. What is pinned here:
 *
 *   - non-admins are refused with 403 from every state or switch export, and
 *     the refusal happens BEFORE the state row is written;
 *   - `isAdminUser` is the one non-throwing export — the nav tab's question;
 *   - switching ON writes the persistent switch FIRST and then wakes through
 *     the ONE shared wake (`ensurePrivateTierAwake`), like the header button;
 *   - a failed wake rejects AND LEAVES THE SWITCH ON — no silent auto-off;
 *   - an unconfigured deployment refuses without writing anything.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// The small box's GPU re-sample fires on the wake's success path; it has its
// own tests and would add a third fetch URL here. The rate helpers stay real
// (they are pure env reads the payload assertions below pin).
vi.mock('../../../lib/inference/small-gpu.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/inference/small-gpu.server')>()),
  resampleSmallBoxGpu: vi.fn(),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

const isBypassEnabled = vi.fn(() => false)
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const getGpuState = vi.fn()
const setGpuState = vi.fn()
vi.mock('../../../lib/db/gpu-state.server', () => ({
  getGpuState: () => getGpuState(),
  setGpuState: (on: boolean) => setGpuState(on),
}))

import {
  getGpuAdminState,
  isAdminUser,
  setGpuKeepRunning,
  stopGpuBoxNow,
} from '../../../lib/harness-client/gpu-admin.server'
import {
  resetModalBootPending,
  resetModalControlCache,
} from '../../../lib/inference/modal-control.server'
import { resetBoxStatusCacheForTests } from '../../../lib/inference/box-status.server'
import {
  ensureSmallAwake,
  resetLargeWake,
  resetSmallWake,
} from '../../../lib/inference/wake.server'
import {
  noteLargeCallCompleted,
  resetLargeActivity,
} from '../../../lib/inference/large-activity.server'
import {
  noteSmallCallCompleted,
  resetSmallActivity,
} from '../../../lib/inference/cold-start.server'

const ADMIN = 'owner@example.invalid'
const PEON = 'someone@example.invalid'

const ENV_KEYS = [
  'ADMIN_EMAILS',
  'LARGE_LLM_BASE_URL',
  'LARGE_LLM_API_KEY',
  'SMALL_LLM_BASE_URL',
  'SMALL_LLM_DECISIONS_URL',
  'SMALL_LLM_API_KEY',
  'LARGE_LLM_WAKE_TIMEOUT_MS',
  'LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS',
  'LARGE_LLM_WAKE_POLL_INTERVAL_MS',
  'SMALL_LLM_WAKE_TIMEOUT_MS',
  'SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS',
  'SMALL_LLM_WAKE_POLL_INTERVAL_MS',
  'LARGE_LLM_EUR_PER_HOUR',
  'SMALL_LLM_EUR_PER_HOUR',
  'LARGE_LLM_ROUTE',
  'LARGE_LLM_SCALEDOWN_SECONDS',
  'SMALL_LLM_SCALEDOWN_SECONDS',
  'MODAL_CONTROL_BASE',
  'MODAL_CONTROL_TOKEN',
  'MODAL_NOT_STARTING_AFTER_MS',
] as const
let saved: Record<string, string | undefined>
let fetchMock: ReturnType<typeof vi.fn>

/** Both endpoints the private tier needs, plus the admin allow-list. */
function configureDeployment(): void {
  process.env.LARGE_LLM_BASE_URL = 'https://example.invalid/deployment/v1'
  process.env.LARGE_LLM_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
  process.env.SMALL_LLM_DECISIONS_URL = 'https://private.example/v1/systemone'
  process.env.SMALL_LLM_API_KEY = 'synthetic-private-key'
  process.env.ADMIN_EMAILS = ADMIN
}

/** Budgets in milliseconds for the cases that let a wake run out. */
function shortWakeBudgets(): void {
  process.env.LARGE_LLM_WAKE_TIMEOUT_MS = '60'
  process.env.LARGE_LLM_WAKE_ATTEMPT_TIMEOUT_MS = '20'
  process.env.LARGE_LLM_WAKE_POLL_INTERVAL_MS = '1'
  process.env.SMALL_LLM_WAKE_TIMEOUT_MS = '60'
  process.env.SMALL_LLM_WAKE_ATTEMPT_TIMEOUT_MS = '20'
  process.env.SMALL_LLM_WAKE_POLL_INTERVAL_MS = '1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(false)
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: ADMIN })
  getGpuState.mockResolvedValue({ keepRunning: false, switchedOnAt: null })
  setGpuState.mockImplementation(async (on: boolean) => ({
    keepRunning: on,
    switchedOnAt: on ? Date.now() : null,
  }))
  resetLargeWake()
  resetSmallWake()
  resetLargeActivity()
  resetSmallActivity()
  resetModalBootPending()
  resetModalControlCache()
  resetBoxStatusCacheForTests()
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetLargeWake()
  resetSmallWake()
  resetLargeActivity()
  resetSmallActivity()
  resetModalBootPending()
  resetModalControlCache()
  resetBoxStatusCacheForTests()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** The 403 the amendment demands, on the refusal a non-admin gets. */
async function expectForbidden(promise: Promise<unknown>): Promise<Response> {
  let thrown: unknown
  try {
    await promise
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'the gate must refuse, not answer').toBeInstanceOf(Response)
  const res = thrown as Response
  expect(res.status).toBe(403)
  return res
}

describe('the admin gate', () => {
  it('refuses a non-admin a read of the panel state with a 403 Response', async () => {
    configureDeployment()
    getAuthenticatedUser.mockResolvedValue({ id: 'user-2', email: PEON })
    await expectForbidden(getGpuAdminState())
    // And the refusal's WORDING names nothing the visitor could act on: no
    // capability, no configuration, no hint of how access is granted.
    const body = await (await expectForbidden(getGpuAdminState())).text()
    expect(body).toBe('You do not have access to this page.')
  })

  it('refuses a non-admin the SWITCH with the same 403, writing nothing', async () => {
    configureDeployment()
    getAuthenticatedUser.mockResolvedValue({ id: 'user-2', email: PEON })
    await expectForbidden(setGpuKeepRunning(true))
    expect(setGpuState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a signed-out caller the same way', async () => {
    configureDeployment()
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    await expectForbidden(getGpuAdminState())
  })

  it('isAdminUser is the non-throwing question the nav tab asks', async () => {
    configureDeployment()
    getAuthenticatedUser.mockResolvedValue({ id: 'user-2', email: PEON })
    expect(await isAdminUser()).toBe(false)
    getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: ADMIN })
    expect(await isAdminUser()).toBe(true)
    // Signed out: not an admin, and not a rejected poll on every page load.
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    expect(await isAdminUser()).toBe(false)
  })

  it('the dev bypass user is an admin only when the allow-list says so', async () => {
    configureDeployment()
    isBypassEnabled.mockReturnValue(true)
    process.env.ADMIN_EMAILS = 'dev@local'
    expect(await isAdminUser()).toBe(true)
    process.env.ADMIN_EMAILS = ADMIN
    expect(await isAdminUser()).toBe(false)
  })

  it('an unset allow-list administers nobody: even a signed-in user is refused', async () => {
    configureDeployment()
    delete process.env.ADMIN_EMAILS
    getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: ADMIN })
    await expectForbidden(getGpuAdminState())
  })
})

describe('the panel state', () => {
  it('carries the switch, its stamp, availability and the per-hour prices', async () => {
    configureDeployment()
    process.env.LARGE_LLM_EUR_PER_HOUR = '4.6'
    process.env.SMALL_LLM_EUR_PER_HOUR = '1.07418'
    const switchedOnAt = Date.now() - 3_600_000
    getGpuState.mockResolvedValue({ keepRunning: true, switchedOnAt })

    const state = await getGpuAdminState()
    // The per-box fields ride this payload too (nothing has answered in this
    // test, so both up-sinces are null and the 4B reads cold) — the whole
    // shape in one `toEqual`, so a field added to one and not the other
    // reddens rather than passing silently.
    expect(state).toEqual({
      keepRunning: true,
      switchedOnAt,
      configured: true,
      largeEurPerHour: 4.6,
      smallEurPerHour: 1.07418,
      largeOnOpenRouter: false,
      largeUpSince: null,
      smallState: 'cold',
      smallUpSince: null,
      // #1057: the Modal control half — null here, the control route being
      // unconfigured, which is the panel's fallback marker.
      modal: null,
    })
  })

  it('carries whether the 27B is one of the boxes the loop keeps — it is not on the OpenRouter route', async () => {
    // The payload's per-hour figure prices the boxes the keep-running loop
    // keeps up, and on `LARGE_LLM_ROUTE=openrouter` the loop (like the wake,
    // `wake.server.ts`) keeps no 27B box — so the panel must be TOLD that,
    // or it would price a box nobody is keeping.
    configureDeployment()
    process.env.LARGE_LLM_ROUTE = 'openrouter'
    expect((await getGpuAdminState()).largeOnOpenRouter).toBe(true)
    delete process.env.LARGE_LLM_ROUTE
    expect((await getGpuAdminState()).largeOnOpenRouter).toBe(false)
  })
})

// The per-box fields the cost meter meters with (#1047 round 4): each box's
// up-since — when THIS process first observed it up in its current
// up-period — and the 4B's live state, which no strip renders and which
// therefore ride this admin-only payload rather than the one every signed-in
// user receives (`preview-header.test.ts` pins that half from the other
// side). The up-since rules are the meter's: it seeds each box's accrual
// from max(upSince, switch-on), so what has to hold is that the value OPENS
// at the first answer after cold, does NOT move with the keep-warm pings that
// refresh the completion clock (a reload reading `lastCompletedAt` re-billed
// the whole switch-on as ~zero — the round-3 defect), and CLOSES with the
// idle window. `large-activity.test.ts` and `cold-start.test.ts` pin the
// clocks themselves; what is pinned here is that THIS payload carries them.
describe('the per-box fields the cost meter meters with', () => {
  beforeEach(configureDeployment)

  it('carries both boxes un-up before anything has answered: no up-since, the 4B cold', async () => {
    const state = await getGpuAdminState()
    expect(state.largeUpSince).toBeNull()
    expect(state.smallState).toBe('cold')
    expect(state.smallUpSince).toBeNull()
  })

  it('carries each box’s up-since from the moment it first answered after being cold', async () => {
    const at = Date.now() - 60_000
    noteLargeCallCompleted(at)
    noteSmallCallCompleted(at)

    const state = await getGpuAdminState()
    expect(state.largeUpSince).toBe(at)
    expect(state.smallState).toBe('ready')
    expect(state.smallUpSince).toBe(at)
  })

  it('carries each box’s up-since from its OWN clock — never the other box’s', async () => {
    // The surviving mutant of round 4: `largeUpSince` fed from the 4B's clock
    // (or the reverse) in `getGpuAdminState` went undetected, because every
    // other test here stamps both boxes at the SAME instant, where a crossed
    // feed is invisible. This one stamps them three minutes apart — both
    // inside their idle windows, so neither read clears — so either
    // direction of the swap reddens. MUTATION: feed `largeUpSince` from
    // `smallUpSince()` (or the reverse) and this reddens.
    const largeAt = Date.now() - 240_000
    const smallAt = Date.now() - 60_000
    noteLargeCallCompleted(largeAt)
    noteSmallCallCompleted(smallAt)

    const state = await getGpuAdminState()
    expect(state.largeUpSince).toBe(largeAt)
    expect(state.smallState).toBe('ready')
    expect(state.smallUpSince).toBe(smallAt)
  })

  it('keeps the up-since at the period’s start across the keep-warm pings that refresh the completion clock', async () => {
    // The box came up 4 minutes ago and has been pinged since (keep-warm
    // touches it roughly every 100s): the pings refresh `lastCompletedAt`,
    // but the up-period is ONE, and `upSince` must stay where it opened —
    // the property a reload's seed depends on. MUTATION: seed the meter from
    // `lastCompletedAt` instead and this reddens (the ping wins).
    const first = Date.now() - 240_000
    noteLargeCallCompleted(first)
    noteSmallCallCompleted(first)
    const later = Date.now() - 100_000
    noteLargeCallCompleted(later)
    noteSmallCallCompleted(later)

    const state = await getGpuAdminState()
    expect(state.largeUpSince).toBe(first)
    expect(state.smallUpSince).toBe(first)
  })

  it('carries the 4B starting — and with no up-since — while its own wake is in flight', async () => {
    // `starting` is a wake engaged with no evidence the box is up, so it has
    // no up-since either: the cold start it may end in is not billed time,
    // and the meter must not count the 4B while it reads this (the surviving
    // mutant of round 3, pinned from the payload side here and from the
    // page side in `routes/admin.test.tsx`).
    const releases: Array<() => void> = []
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          releases.push(() => resolve(new Response('{}', { status: 200 }))),
        ),
    )
    const wake = ensureSmallAwake(Date.now())
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = await getGpuAdminState()
    expect(state.smallState).toBe('starting')
    expect(state.smallUpSince).toBeNull()

    releases.forEach((release) => release())
    await wake
    // The answered wake is itself the completion: the period opened at it.
    const answered = await getGpuAdminState()
    expect(answered.smallState).toBe('ready')
    expect(answered.smallUpSince).not.toBeNull()
  })

  it('clears each box’s up-since once its idle window has passed the last answer', async () => {
    // Answered 60s ago, on a 10s window (set for this case, restored by the
    // ENV_KEYS harness): the period is over, and the payload must not carry
    // its start as if it were open — the read itself is what clears, which is
    // also what a failed wake ends in (no answer, so unproven, so the next
    // read clears the same way).
    const at = Date.now() - 60_000
    noteLargeCallCompleted(at)
    noteSmallCallCompleted(at)
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '10'
    process.env.SMALL_LLM_SCALEDOWN_SECONDS = '10'

    const state = await getGpuAdminState()
    expect(state.largeUpSince).toBeNull()
    expect(state.smallState).toBe('cold')
    expect(state.smallUpSince).toBeNull()
  })
})

describe('the switch', () => {
  it('writes the switch first, then wakes BOTH boxes through the shared wake', async () => {
    configureDeployment()
    await setGpuKeepRunning(true)

    expect(setGpuState).toHaveBeenCalledWith(true)
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).sort()
    expect(urls).toEqual([
      'https://example.invalid/deployment/v1/chat/completions',
      'https://example.invalid/small/health',
    ])
    // And it answers with the fresh state.
    expect((await getGpuAdminState()).keepRunning).toBe(false) // the mock row
  })

  it('switching off is a plain write: no wake, no ping', async () => {
    configureDeployment()
    await setGpuKeepRunning(false)
    expect(setGpuState).toHaveBeenCalledWith(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an unconfigured deployment without writing anything', async () => {
    // Admin, but no endpoints configured — the panel must explain itself
    // rather than store an ON switch for a deployment it cannot reach.
    process.env.ADMIN_EMAILS = ADMIN
    let thrown: unknown
    try {
      await setGpuKeepRunning(true)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('not configured')
    expect(setGpuState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed wake rejects and LEAVES THE SWITCH ON — no silent auto-off', async () => {
    configureDeployment()
    shortWakeBudgets()
    fetchMock.mockResolvedValue(new Response('starting', { status: 503 }))

    let thrown: unknown
    try {
      await setGpuKeepRunning(true)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('did not wake')
    // The write happened BEFORE the wake and is not rolled back.
    expect(setGpuState).toHaveBeenCalledWith(true)
  })

  it('refuses a non-boolean switch state with a 400 and writes nothing', async () => {
    configureDeployment()
    for (const garbage of ['true', 1, null, undefined, { on: true }]) {
      let thrown: unknown
      try {
        await setGpuKeepRunning(garbage as never)
      } catch (err) {
        thrown = err
      }
      expect(thrown, `the wire value ${String(garbage)} must be refused`).toBeInstanceOf(Response)
      expect((thrown as Response).status).toBe(400)
    }
    // Refused before anything ran: no write, no wake, and no session lookup.
    expect(setGpuState).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
  })
})

// ============================================================================
// #1057: the Modal control plane's word on each box
// ============================================================================
//
// With `MODAL_CONTROL_BASE` + `MODAL_CONTROL_TOKEN` set the payload carries a
// line per box composed from the control plane plus the box's own `/status`
// once a container is up; without them it is `null` and the panel says so.
// What is pinned, per rule:
//
//   - the line comes from the CONTROL PLANE, and `/status` is fetched ONLY
//     when the control plane says a container is up — a status read against a
//     scaled-to-zero box would START it, the exact failure the read path
//     exists to avoid;
//   - zero containers is `cold` while nothing is pending, `booting` while
//     this process is asking, and `not-starting` past the threshold — the
//     2026-11-19 failure named instead of waited out;
//   - `/status` 200 is `up` with the box's own `restored` and `gpu`; a 503
//     while the weights load is `booting`;
//   - the switch drives the AUTOSCALER (min_containers) when the route exists,
//     with no request sent to either box, and falls back to the wake otherwise;
//   - `stopGpuBoxNow` is gated like the switch and only stops a box of ours.
describe('#1057: the Modal lines on the payload', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'

  /** Configure the sidecar route on the shared fetch mock. The boxes' own
   *  routes answer 200 (a `/status` with the box's own facts; a model reply
   *  for the wake path), so each test arms only the sidecar's half. */
  function configureModal(state: () => Response = () => modalState()): void {
    configureDeployment()
    process.env.MODAL_CONTROL_BASE = MODAL_BASE
    process.env.MODAL_CONTROL_TOKEN = 'test-modal-token'
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.startsWith(MODAL_BASE)) return Promise.resolve(state())
      if (u.endsWith('/status')) {
        return Promise.resolve(
          new Response(JSON.stringify({ restored: true, gpu: 'NVIDIA A10G' }), { status: 200 }),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
      )
    })
  }

  /** The sidecar's `/state`: zero containers in both boxes by default. */
  const modalState = (containers: { large?: number; small?: number } = {}) => {
    const box = (n: number) => ({
      ok: true,
      app: 'test-app',
      server: 'test-server',
      containers: Array.from({ length: n }, (_, i) => ({
        container_id: `ct-${i}`,
        started_at_ms: null,
      })),
    })
    return new Response(
      JSON.stringify({
        ok: true,
        boxes: { large: box(containers.large ?? 0), small: box(containers.small ?? 0) },
      }),
    )
  }

  it('is null while the control route is unconfigured — the fallback marker', async () => {
    configureDeployment()
    const state = await getGpuAdminState()
    expect(state.modal).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries COLD for a box the control plane reports scaled to zero, fetching no /status', async () => {
    configureModal()
    const state = await getGpuAdminState()
    expect(state.modal?.small).toMatchObject({ state: 'cold', containers: 0 })
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).toEqual([`${MODAL_BASE}/state`])
  })

  it('carries BOOTING while this process is asking for a box, and NOT-STARTING past the threshold', async () => {
    configureModal()
    process.env.MODAL_NOT_STARTING_AFTER_MS = '20000'
    const t0 = Date.now() - 30_000
    const { noteModalBootRequested } = await import('../../../lib/inference/modal-control.server')
    noteModalBootRequested('small', t0)
    const state = await getGpuAdminState()
    expect(state.modal?.small).toMatchObject({ state: 'not-starting' })
    expect(state.modal?.small.reason).toContain('after 30s of asking')

    // Same box, under the threshold: booting, not failing.
    resetModalBootPending()
    noteModalBootRequested('small', Date.now() - 5_000)
    resetModalControlCache()
    expect((await getGpuAdminState()).modal?.small.state).toBe('booting')
  })

  it('carries UP from /status once a container exists — restored, gpu — and never before', async () => {
    configureModal(() => modalState({ large: 1, small: 1 }))
    const state = await getGpuAdminState()
    expect(state.modal?.large).toMatchObject({
      state: 'up',
      containers: 1,
      restored: true,
      gpu: 'NVIDIA A10G',
    })
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).sort()
    expect(urls).toEqual([
      // sorted: the sidecar's host sorts before the boxes' https URLs
      `${MODAL_BASE}/state`,
      'https://example.invalid/deployment/status',
      'https://example.invalid/small/status',
    ])
  })

  it('carries BOOTING, not up, while /status answers 503 inside a live container', async () => {
    configureModal(() => modalState({ large: 1 }))
    fetchMock.mockImplementation(((url: string) => {
      if (url.startsWith(MODAL_BASE)) return Promise.resolve(modalState({ large: 1 }))
      if (url.endsWith('/status')) return Promise.resolve(new Response('starting', { status: 503 }))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as never)
    resetModalControlCache()
    const state = await getGpuAdminState()
    expect(state.modal?.large).toMatchObject({ state: 'booting', containers: 1, restored: null })
    expect(state.modal?.small.state).toBe('cold')
  })

  it('carries UNKNOWN per box when the control-plane read fails, without throwing', async () => {
    configureModal(() => new Response('down', { status: 503 }))
    const state = await getGpuAdminState()
    expect(state.modal?.small).toMatchObject({ state: 'unknown' })
    expect(state.modal?.small.reason).toBeTruthy()
  })

  it('carries a NULL 27B line on the OpenRouter route — no box of ours to show or control', async () => {
    configureModal()
    process.env.LARGE_LLM_ROUTE = 'openrouter'
    resetModalControlCache()
    const state = await getGpuAdminState()
    expect(state.modal?.large).toBeNull()
    expect(state.modal?.small).toMatchObject({ state: 'cold' })
  })
})

describe('#1057: the switch through the control route', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'
  const AUTOSCALER = `${MODAL_BASE}/autoscaler`

  function configureModal(): void {
    configureDeployment()
    process.env.MODAL_CONTROL_BASE = MODAL_BASE
    process.env.MODAL_CONTROL_TOKEN = 'test-modal-token'
  }

  /** Route: the sidecar's autoscaler answers ok; model routes answer too. */
  const route = (url: string): Response => {
    if (url.startsWith(MODAL_BASE)) {
      return new Response(JSON.stringify({ ok: true, min_containers: 1 }), { status: 200 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
      status: 200,
    })
  }

  it('ON asserts min_containers=1 per box and sends NO request to either box', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) => Promise.resolve(route(url))) as never)
    await setGpuKeepRunning(true)

    expect(setGpuState).toHaveBeenCalledWith(true)
    const posts = fetchMock.mock.calls.filter(([u]) => String(u) === AUTOSCALER)
    expect(
      posts
        .map(([u, init]) => [String(u), JSON.parse(String((init as RequestInit).body))] as const)
        .sort((a, b) => String(a[1].box).localeCompare(String(b[1].box))),
    ).toEqual([
      [AUTOSCALER, { box: 'large', min_containers: 1 }],
      [AUTOSCALER, { box: 'small', min_containers: 1 }],
    ])
    // THE acceptance: booted with no model request sent — no wake ping, no
    // health poll, nothing to either inference endpoint.
    const modelUrls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => !u.startsWith(MODAL_BASE))
    expect(modelUrls).toEqual([])
  })

  it('does not wait for the boot: the call returns with the boxes still coming up', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) => Promise.resolve(route(url))) as never)
    const state = await setGpuKeepRunning(true)
    // No wake ran, so no completion evidence — the switch flipped fast.
    expect(state.smallState).toBe('cold')
  })

  it('OFF asserts min_containers=0 per box — the release', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) => Promise.resolve(route(url))) as never)
    await setGpuKeepRunning(false)
    const posts = fetchMock.mock.calls.filter(([u]) => String(u) === AUTOSCALER)
    expect(posts.length).toBe(2)
    for (const [, init] of posts as unknown as [string, RequestInit][]) {
      const body = JSON.parse(String(init.body)) as { box: string; min_containers: number }
      expect(body.min_containers).toBe(0)
    }
  })

  it('skips the 27B on the OpenRouter route — there is no Modal box of ours to boot', async () => {
    configureModal()
    // The route's own boot requirement: an explicit model id, or the private
    // tier is not configured and the switch refuses for the wrong reason.
    process.env.LARGE_LLM_ROUTE = 'openrouter'
    process.env.LARGE_LLM_MODEL = 'openrouter/openai.gpt-4o-mini'
    fetchMock.mockImplementation(((url: string) => Promise.resolve(route(url))) as never)
    await setGpuKeepRunning(true)
    const posts = fetchMock.mock.calls.filter(([u]) => String(u) === AUTOSCALER)
    expect(
      posts.map(
        ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { box: string }).box,
      ),
    ).toEqual(['small'])
  })

  it('a refused assertion rejects with the reason and LEAVES THE SWITCH ON', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) => {
      if (url.startsWith(MODAL_BASE)) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'missing-modal-token' })),
        )
      }
      return Promise.resolve(new Response('{}'))
    }) as never)
    let thrown: unknown
    try {
      await setGpuKeepRunning(true)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('min_containers')
    expect((thrown as Error).message).toContain('missing-modal-token')
    expect(setGpuState).toHaveBeenCalledWith(true)
  })

  it('falls back to the WAKE when the control route is unconfigured — today’s behaviour', async () => {
    configureDeployment()
    await setGpuKeepRunning(true)
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).sort()
    expect(urls).toEqual([
      'https://example.invalid/deployment/v1/chat/completions',
      'https://example.invalid/small/health',
    ])
  })
})

describe('#1057: stopGpuBoxNow', () => {
  const MODAL_BASE = 'http://127.0.0.1:8124'

  function configureModal(): void {
    configureDeployment()
    process.env.MODAL_CONTROL_BASE = MODAL_BASE
    process.env.MODAL_CONTROL_TOKEN = 'test-modal-token'
  }

  it('refuses a non-admin with the same 403, stopping nothing', async () => {
    configureModal()
    getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: PEON })
    await expectForbidden(stopGpuBoxNow('small'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a garbage box with a 400 before anything runs', async () => {
    configureModal()
    for (const garbage of ['huge', '', null, undefined, 1]) {
      await expectForbidden403ish(garbage as never)
    }
  })

  /** The 400 shape the box validation answers. */
  async function expectForbidden403ish(box: never): Promise<void> {
    let thrown: unknown
    try {
      await stopGpuBoxNow(box)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Response)
    expect((thrown as Response).status).toBe(400)
  }

  it('stops through the sidecar and answers with the fresh state', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) =>
      url === `${MODAL_BASE}/stop`
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, stopped: ['ct-a'] })))
        : Promise.resolve(new Response('{}'))) as never)
    const state = await stopGpuBoxNow('small')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${MODAL_BASE}/stop`)
    expect(JSON.parse(String(init.body))).toEqual({ box: 'small' })
    expect(state).toHaveProperty('keepRunning')
  })

  it('refuses an unconfigured control route with the panel’s own words', async () => {
    configureDeployment()
    let thrown: unknown
    try {
      await stopGpuBoxNow('small')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('no token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses the 27B on the OpenRouter route: no Modal box of ours to stop', async () => {
    configureModal()
    process.env.LARGE_LLM_ROUTE = 'openrouter'
    process.env.LARGE_LLM_MODEL = 'openrouter/openai.gpt-4o-mini'
    let thrown: unknown
    try {
      await stopGpuBoxNow('large')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('OpenRouter')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries a failed stop out to the panel instead of swallowing it', async () => {
    configureModal()
    fetchMock.mockImplementation(((url: string) =>
      url === `${MODAL_BASE}/stop`
        ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'quota' })))
        : Promise.resolve(new Response('{}'))) as never)
    let thrown: unknown
    try {
      await stopGpuBoxNow('large')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('stop its containers')
    expect((thrown as Error).message).toContain('quota')
  })
})

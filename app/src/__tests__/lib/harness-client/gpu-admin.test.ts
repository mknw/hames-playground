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
} from '../../../lib/harness-client/gpu-admin.server'
import { resetLargeWake, resetSmallWake } from '../../../lib/inference/wake.server'
import { resetLargeActivity } from '../../../lib/inference/large-activity.server'
import { resetSmallActivity } from '../../../lib/inference/cold-start.server'

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
    expect(state).toEqual({
      keepRunning: true,
      switchedOnAt,
      configured: true,
      largeEurPerHour: 4.6,
      smallEurPerHour: 1.07418,
      largeOnOpenRouter: false,
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

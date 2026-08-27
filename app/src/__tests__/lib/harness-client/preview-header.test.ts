/**
 * Preview-header server actions — the browser-reachable half.
 *
 * Every export of a `'use server'` module is an RPC a client can call, so the
 * cases here are mostly about the gate and about who the owner is:
 *
 *   - both exports authenticate before touching a resource;
 *   - NEITHER takes an owner id, so a caller cannot read or write someone
 *     else's preference — the id is resolved from the session and passed down
 *     to `db/user-prefs.server.ts`, which is deliberately not a `'use server'`
 *     module for exactly that reason;
 *   - an unknown tier is refused rather than stored;
 *   - `'verda'` is refused when the endpoint is unconfigured, because storing
 *     it would turn a header click into a broken chat on the next message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

const isBypassEnabled = vi.fn(() => false)
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'bypass-user', email: 'dev@example.invalid' },
}))

const getStoredInferenceTier = vi.fn<(id: string) => Promise<'verda' | 'anthropic' | null>>(
  async () => null,
)
vi.mock('../../../lib/db/user-prefs.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/db/user-prefs.server')>(
    '../../../lib/db/user-prefs.server',
  )
  return {
    ...actual,
    getStoredInferenceTier: (id: string) => getStoredInferenceTier(id),
  }
})

const countActiveUsers = vi.fn(async () => 3)
const getUsageToday = vi.fn(async () => ({
  totalTokens: 1234,
  llmCalls: 10,
  turns: 4,
  verdaCallShare: 0.5,
}))
vi.mock('../../../lib/db/conversations.server', () => ({
  ACTIVE_WINDOW_MINUTES: 15,
  countActiveUsers: () => countActiveUsers(),
}))
vi.mock('../../../lib/metrics/preview-counters.server', () => ({
  getUsageToday: () => getUsageToday(),
}))

import {
  getPreviewHeaderState,
  igniteVerdaBox,
} from '../../../lib/harness-client/preview-header.server'
import { noteCallLatency, resetCallLatency } from '../../../lib/metrics/call-latency.server'
import { resetVerdaWake, VERDA_WAKE_FAILED } from '../../../lib/inference/wake.server'
import {
  noteVerdaCallCompleted,
  resetVerdaActivity,
} from '../../../lib/inference/verda-activity.server'

const ENV_KEYS = [
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
  // The private tier is two models since 2026-08-26, and `verdaConfigured()`
  // asks about both — so a fixture that configures only the 27B leaves the
  // switch's private position DISABLED.
  'SMALL_LLM_BASE_URL',
  // Cleared per test and restored after, so the wake's own defaults apply
  // everywhere except where a case sets its budget deliberately — see
  // `shortWakeBudget`.
  'VERDA_WAKE_TIMEOUT_MS',
  'VERDA_WAKE_ATTEMPT_TIMEOUT_MS',
  'VERDA_WAKE_POLL_INTERVAL_MS',
] as const
let saved: Record<string, string | undefined>

/** BOTH endpoints the private tier needs — the 27B and the 4B summarizer. A
 *  fixture that sets only the first describes a deployment the switch refuses
 *  to offer, which is the case the "is anthropic when it is not" tests cover. */
function configureVerda(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
}

/**
 * A wake budget measured in milliseconds, for the one case that lets the poll
 * run out.
 *
 * The wake POLLS (#291): a 5xx is a box that is coming up, so it is retried for
 * the whole of `VERDA_WAKE_TIMEOUT_MS` — 600s by default. A rejection case that
 * stubs a 503 and waits for the poll to give up therefore does not assert
 * anything at all; it hangs until vitest kills the test at 5s, which reports as
 * a timeout rather than as the behaviour the case is named for. The fix is to
 * make the budget the test's own: the box still never comes up, the poll still
 * ends the only way it can, and it does so in milliseconds.
 *
 * All three are set together — a budget below one attempt would be the wake's
 * own edge case rather than this file's subject, and a poll interval left at 5s
 * would sleep out the budget between two attempts.
 */
function shortWakeBudget(): void {
  process.env.VERDA_WAKE_TIMEOUT_MS = '60'
  process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = '20'
  process.env.VERDA_WAKE_POLL_INTERVAL_MS = '1'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(false)
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: 'a@example.invalid' })
  getStoredInferenceTier.mockResolvedValue(null)
  resetCallLatency()
  resetVerdaWake()
  resetVerdaActivity()
  // The wake ping is a hand-rolled `fetch`; stubbing it is what keeps this file
  // hermetic while still exercising the real `ensureVerdaAwake`, which is the
  // whole point of the cases below — a mock of that function would prove the
  // action calls SOMETHING, not that it joins the dedupe every other caller uses.
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

let fetchMock: ReturnType<typeof vi.fn>

afterEach(() => {
  vi.unstubAllGlobals()
  resetVerdaWake()
  resetVerdaActivity()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('getPreviewHeaderState', () => {
  it('reports the tier a new chat starts on, and the counters', async () => {
    configureVerda()
    getStoredInferenceTier.mockResolvedValue('anthropic')

    const state = await getPreviewHeaderState()

    expect(getStoredInferenceTier).toHaveBeenCalledWith('user-1')
    expect(state).toMatchObject({
      tier: 'anthropic',
      verdaAvailable: true,
      activeUsers: 3,
      activeWindowMinutes: 15,
      usage: { totalTokens: 1234, turns: 4, verdaCallShare: 0.5 },
    })
    expect(state.generatedAt).toBeGreaterThan(0)
  })

  it('reports the latency of the tier this user is ON, not of the other one', async () => {
    // The number sits beside the switch, so the two have to describe the same
    // thing: reading the wrong tier's window would tell a user on Anthropic how
    // fast the self-hosted box is, which is an answer to a question the strip
    // is not asking.
    configureVerda()
    noteCallLatency('verda', 30_000)
    noteCallLatency('anthropic', 900)

    getStoredInferenceTier.mockResolvedValue('anthropic')
    expect((await getPreviewHeaderState()).latency).toEqual({ p50Ms: 900, samples: 1 })

    getStoredInferenceTier.mockResolvedValue('verda')
    expect((await getPreviewHeaderState()).latency).toEqual({ p50Ms: 30_000, samples: 1 })
  })

  it('says "not measured" rather than 0 before any call has completed', async () => {
    configureVerda()
    const state = await getPreviewHeaderState()
    expect(state.latency).toEqual({ p50Ms: null, samples: 0 })
  })

  it('falls back to the preview default when the user has never chosen', async () => {
    configureVerda()
    expect((await getPreviewHeaderState()).tier).toBe('verda')
  })

  it('reports the verda position unavailable when the endpoint is unset', async () => {
    const state = await getPreviewHeaderState()
    expect(state.verdaAvailable).toBe(false)
    expect(state.tier).toBe('anthropic')
  })

  it('refuses an unauthenticated caller before reading anything', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Unauthorized'))

    await expect(getPreviewHeaderState()).rejects.toThrow('Unauthorized')
    expect(getStoredInferenceTier).not.toHaveBeenCalled()
    expect(countActiveUsers).not.toHaveBeenCalled()
    expect(getUsageToday).not.toHaveBeenCalled()
  })

  it('serves the shared bypass identity in dev', async () => {
    isBypassEnabled.mockReturnValue(true)
    await getPreviewHeaderState()

    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(getStoredInferenceTier).toHaveBeenCalledWith('bypass-user')
  })
})

// The SETTER moved with the switch: it is `setConversationTier` in
// `harness-client/actions.server.ts` now, and its tests moved with it (the
// owner-from-session rule, the unknown-tier refusal, the unconfigured-verda
// refusal, and that opting OUT still works). This module no longer changes
// anything — the strip describes the box and the deployment, not a conversation.

describe('igniteVerdaBox', () => {
  it('authenticates before it starts anything', async () => {
    // Same gate as the rest of the module (`SD-13`), and it matters more here
    // than on a read: this export is the one that spends GPU seconds.
    configureVerda()
    getAuthenticatedUser.mockRejectedValue(new Error('nope'))

    await expect(igniteVerdaBox()).rejects.toThrow('nope')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes no owner id, so a caller cannot start the box as someone else', () => {
    // The whole module's rule. Pinned by arity rather than by reading, because
    // an added parameter is exactly the change that would slip past a reviewer.
    expect(igniteVerdaBox.length).toBe(0)
  })

  it('refuses when there is no endpoint, instead of fetching a malformed URL', async () => {
    await expect(igniteVerdaBox()).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wakes a cold box and answers with the state it is now in', async () => {
    configureVerda()

    const state = await igniteVerdaBox()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The ping stamps the warm clock, so the strip's next render has a number to
    // count down — which is the point of the button.
    expect(state.warmth.state).toBe('warm')
    expect(state.warmth.secondsUntilScaledown).toBeGreaterThan(0)
  })

  it('JOINS an in-flight wake rather than starting a second one', async () => {
    // The property the owner asked for by name. The deployment is a single
    // replica where concurrency is queueing, so a click that opened its own ping
    // beside a turn's would make both wait two cold starts. It holds because
    // this action calls the SAME `ensureVerdaAwake` the turn runner does; a
    // second wake path would not inherit it.
    configureVerda()
    let release: () => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(
          (resolve) => (release = () => resolve(new Response('{}', { status: 200 }))),
        ),
    )

    const clicks = [igniteVerdaBox(), igniteVerdaBox(), igniteVerdaBox()]
    // Drain the microtask queue completely rather than tick once: each click
    // awaits its own gate before reaching the wake, so a single tick would leave
    // two of them short of the line this test is about and pass for the wrong
    // reason. After this, all three have had every chance to send a request.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release()
    await Promise.all(clicks)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on a box that is already up', async () => {
    // Clicking a warm indicator must not bill GPU seconds. `ensureVerdaAwake`
    // returns on `verdaProvenWarm` before touching the network.
    configureVerda()
    noteVerdaCallCompleted()

    const state = await igniteVerdaBox()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.warmth.state).toBe('warm')
  })

  it('REJECTS when the box does not come up, rather than reporting cold', async () => {
    // A wake that failed and a box that is merely cold look identical in the
    // returned state, so the failure has to travel as a rejection or the strip
    // would settle back to "cold" and say nothing happened.
    //
    // The 503 is a box that is starting and never finishes, which is exactly
    // what the name says — and under #291's poll it is RETRIED, so the case only
    // reaches its assertion inside a budget it sets itself (`shortWakeBudget`).
    configureVerda()
    shortWakeBudget()
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))

    await expect(igniteVerdaBox()).rejects.toThrow(VERDA_WAKE_FAILED)
    // It kept trying rather than giving up on the first 5xx — the property that
    // makes this case a poll running out, and not a refusal by another name.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('REJECTS at once when the deployment refuses the request outright', async () => {
    // The other half of the wake's failure policy (`isRefusal`): a 400 for an
    // unknown model id is a property of the REQUEST, so no retry can fix it and
    // the poll ends on the spot. Here that is the difference between a user
    // being told and a spinner running out a budget on a one-line
    // misconfiguration.
    configureVerda()
    fetchMock.mockResolvedValue(new Response('unknown model', { status: 400 }))

    await expect(igniteVerdaBox()).rejects.toThrow(VERDA_WAKE_FAILED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

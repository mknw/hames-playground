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
const setStoredInferenceTier = vi.fn<(id: string, tier: 'verda' | 'anthropic') => Promise<void>>(
  async () => {},
)
vi.mock('../../../lib/db/user-prefs.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/db/user-prefs.server')>(
    '../../../lib/db/user-prefs.server',
  )
  return {
    ...actual,
    getStoredInferenceTier: (id: string) => getStoredInferenceTier(id),
    setStoredInferenceTier: (id: string, tier: 'verda' | 'anthropic') =>
      setStoredInferenceTier(id, tier),
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
  setPreviewInferenceTier,
} from '../../../lib/harness-client/preview-header.server'
import { noteCallLatency, resetCallLatency } from '../../../lib/metrics/call-latency.server'

const ENV_KEYS = ['VERDA_INFERENCE_ENDPOINT', 'VERDA_INFERENCE_API_KEY'] as const
let saved: Record<string, string | undefined>

function configureVerda(): void {
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(false)
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: 'a@example.invalid' })
  getStoredInferenceTier.mockResolvedValue(null)
  resetCallLatency()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('getPreviewHeaderState', () => {
  it('reports the signed-in user’s tier and the counters', async () => {
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

describe('setPreviewInferenceTier', () => {
  it('stores the choice against the SESSION’s user, never a supplied one', async () => {
    configureVerda()
    await setPreviewInferenceTier('anthropic')

    expect(setStoredInferenceTier).toHaveBeenCalledWith('user-1', 'anthropic')
    // The signature takes exactly one argument — the tier. An owner id here
    // would let the caller choose whose preference to write.
    expect(setPreviewInferenceTier.length).toBe(1)
  })

  it('returns the state the header should now show, from the server', async () => {
    configureVerda()
    getStoredInferenceTier.mockResolvedValue('verda')

    const state = await setPreviewInferenceTier('verda')
    expect(state.tier).toBe('verda')
  })

  it('refuses an unauthenticated caller before writing', async () => {
    configureVerda()
    getAuthenticatedUser.mockRejectedValue(new Error('Unauthorized'))

    await expect(setPreviewInferenceTier('verda')).rejects.toThrow('Unauthorized')
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('refuses a tier it does not recognise rather than storing it', async () => {
    await expect(setPreviewInferenceTier('openai')).rejects.toThrow(/Unknown inference tier/)
    await expect(setPreviewInferenceTier(null)).rejects.toThrow(/Unknown inference tier/)
    await expect(setPreviewInferenceTier({ tier: 'verda' })).rejects.toThrow(
      /Unknown inference tier/,
    )
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('refuses the verda position when the endpoint is unconfigured', async () => {
    // Storing it would park a preference that `runWithInferenceTier` throws on,
    // so the user's next message breaks — and the alternative the flag exists
    // to prevent (quietly running on Anthropic instead) is worse still.
    await expect(setPreviewInferenceTier('verda')).rejects.toThrow(
      /self-hosted inference endpoint is not configured/,
    )
    expect(setStoredInferenceTier).not.toHaveBeenCalled()
  })

  it('still allows opting OUT when the endpoint is unconfigured', async () => {
    await expect(setPreviewInferenceTier('anthropic')).resolves.toMatchObject({
      tier: 'anthropic',
    })
  })
})

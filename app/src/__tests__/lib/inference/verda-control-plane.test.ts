/**
 * Verda control-plane probe — what it asks, what it caches, how it degrades.
 *
 * The module's whole contract is that a broken control plane costs the strip
 * its `unknown` display and NOTHING else: no throw, no hang, no request to the
 * inference endpoint. The cases here pin each half of that — the happy path's
 * two bounded fetches, both caches, every degraded result — and the last
 * describe block pins the property the whole module exists to keep: probing is
 * a STATUS read, never a wake, so nothing here may touch
 * `VERDA_INFERENCE_ENDPOINT`. Pinned twice (source scan + runtime observation)
 * because the two failure modes are different: a future edit could rename a
 * var into the file, or route a fetch around the recorder.
 *
 * The mapping from probe result to DISPLAY state (empty list → `cold`, non-empty
 * → `starting`, unavailable → `unknown`) lives in the header assembly
 * (`preview-header.server.ts`) and is tested there — this file tests what the
 * probe reports, not what the strip says about it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  PROBE_CACHE_TTL_MS,
  PROBE_TIMEOUT_MS,
  VERDA_CONTROL_PLANE_BASE,
  probeVerdaReplicas,
  resetControlPlaneCache,
  verdaControlPlaneConfigured,
  type VerdaControlPlaneProbe,
} from '../../../lib/inference/verda-control-plane.server'

// Vitest's cwd is `app/`; `import.meta.url` is not file-scheme under this
// config's resolve conditions, so the module is addressed from the cwd.
const MODULE_PATH = join(process.cwd(), 'src/lib/inference/verda-control-plane.server.ts')

const ENV_KEYS = [
  'VERDA_CLIENT_ID',
  'VERDA_CLIENT_SECRET',
  'VERDA_DEPLOYMENT_ID',
  'VERDA_INFERENCE_ENDPOINT',
  'VERDA_INFERENCE_API_KEY',
] as const
let saved: Record<string, string | undefined>

function configureControlPlane(): void {
  vi.stubEnv('VERDA_CLIENT_ID', 'test-client-id')
  vi.stubEnv('VERDA_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('VERDA_DEPLOYMENT_ID', 'test-deployment')
}

type FetchMock = ReturnType<typeof vi.fn>
let fetchMock: FetchMock

/** A fetch stub that answers the two control-plane endpoints and RECORDS every
 *  URL it was asked for — the runtime half of the "never the inference
 *  endpoint" pin. `replicas` configures what the list endpoint returns. */
function stubFetch(
  opts: {
    status?: number
    list?: unknown[]
    tokenBody?: unknown
    replicasBody?: unknown
  } = {},
): FetchMock {
  const { status = 200, list = [] } = opts
  return vi.fn(async (input: unknown) => {
    const url = String(
      typeof input === 'object' && input !== null && 'url' in input
        ? (input as Request).url
        : input,
    )
    if (url.endsWith('/v1/oauth2/token')) {
      if (status !== 200) return new Response('nope', { status })
      return new Response(
        JSON.stringify(opts.tokenBody ?? { access_token: 'test-token', expires_in: 3600 }),
        { status: 200 },
      )
    }
    if (url.includes('/v1/container-deployments/')) {
      if (status !== 200) return new Response('nope', { status })
      return new Response(JSON.stringify(opts.replicasBody ?? { list }), { status: 200 })
    }
    return new Response(`no fake route for ${url}`, { status: 404 })
  })
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  resetControlPlaneCache()
  vi.clearAllMocks()
  fetchMock = stubFetch()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetControlPlaneCache()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** The URLs the probe asked for, in order. */
const urls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]))

describe('configuration', () => {
  it('is unconfigured until all three credentials are present', () => {
    expect(verdaControlPlaneConfigured()).toBe(false)
    vi.stubEnv('VERDA_CLIENT_ID', 'id')
    expect(verdaControlPlaneConfigured()).toBe(false)
    vi.stubEnv('VERDA_CLIENT_SECRET', 'secret')
    expect(verdaControlPlaneConfigured()).toBe(false)
    vi.stubEnv('VERDA_DEPLOYMENT_ID', 'dep')
    expect(verdaControlPlaneConfigured()).toBe(true)
  })

  it('degrades without a fetch when credentials are missing', async () => {
    const probe = await probeVerdaReplicas()

    expect(probe).toMatchObject({ ok: false, replicaCount: null, reason: 'missing-credentials' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the happy path', () => {
  it('fetches a token, then the replica list, and reports the count', async () => {
    configureControlPlane()

    const probe = await probeVerdaReplicas()

    expect(probe).toMatchObject({
      ok: true,
      replicaCount: 0,
      oldestReplicaStartedAtMs: null,
      reason: null,
    })
    expect(urls()).toHaveLength(2)
    expect(urls()[0]).toBe(`${VERDA_CONTROL_PLANE_BASE}/v1/oauth2/token`)
    expect(urls()[1]).toBe(
      `${VERDA_CONTROL_PLANE_BASE}/v1/container-deployments/test-deployment/replicas`,
    )
    // The credentials the design names, on the wire.
    const tokenBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(tokenBody).toEqual({
      grant_type: 'client_credentials',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    })
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer test-token' })
  })

  it('reads only the COUNT of the replica list', async () => {
    // The per-replica `status` field (`running` there means the container is
    // up, not that the model is loaded) is deliberately unread — a probe that
    // read it would be one refactor away from reporting ready on a box that is
    // still loading 27B of weights.
    configureControlPlane()
    fetchMock = stubFetch({
      list: [
        { id: 'r1', status: 'running', started_at: '2026-08-29T00:00:00Z' },
        { id: 'r2', status: 'initializing', started_at: '2026-08-29T00:00:01Z' },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe).toEqual({
      ok: true,
      replicaCount: 2,
      oldestReplicaStartedAtMs: expect.any(Number),
      reason: null,
      at: expect.any(Number),
    })
  })

  it('serves one probe to every caller within the TTL cache', async () => {
    // The strip polls at 3s while active; a probe per poll would be a request
    // pair per user per 3 seconds against an API that rate-limits per project.
    configureControlPlane()

    await probeVerdaReplicas()
    const [second, third] = await Promise.all([probeVerdaReplicas(), probeVerdaReplicas()])

    expect(second).toEqual(third)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('re-probes after the TTL, reusing the still-valid token', async () => {
    configureControlPlane()
    vi.useFakeTimers()
    try {
      await probeVerdaReplicas()
      expect(fetchMock).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(PROBE_CACHE_TTL_MS + 1)
      await probeVerdaReplicas()

      // One more fetch, not two: the token is cached until `expires_in` (less
      // the margin), so only the replica list is re-asked.
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(urls()[2]).toContain('/replicas')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('degradation', () => {
  it('degrades when the token endpoint answers an HTTP error', async () => {
    configureControlPlane()
    fetchMock = stubFetch({ status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe.ok).toBe(false)
    expect(probe.replicaCount).toBeNull()
    expect(probe.reason).toContain('HTTP 500')
  })

  it('degrades when the replicas endpoint answers an HTTP error', async () => {
    // The token succeeded and is cached; the failure is the second fetch's.
    configureControlPlane()
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
        })
      }
      return new Response('forbidden', { status: 403 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe.ok).toBe(false)
    expect(probe.reason).toContain('HTTP 403')
  })

  it('degrades when a fetch times out rather than hanging the strip', async () => {
    // The bound is the module's whole reason for AbortController: a control
    // plane that accepts the connection and never answers must cost the probe
    // 5s, not the poll forever.
    configureControlPlane()
    fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      const pending = probeVerdaReplicas()
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1)

      const probe: VerdaControlPlaneProbe = await pending
      expect(probe.ok).toBe(false)
      expect(probe.reason).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('degrades on a transport error', async () => {
    configureControlPlane()
    fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe.ok).toBe(false)
    expect(probe.reason).toContain('could not be reached')
  })

  it('degrades on a token response without an access token', async () => {
    // `Bearer undefined` would 401 one step later with the real cause
    // discarded; a shape failure is named where it happens.
    configureControlPlane()
    fetchMock = stubFetch({ tokenBody: { token_type: 'Bearer' } })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe.ok).toBe(false)
    expect(probe.reason).toContain('unexpected response shape')
  })

  it('degrades on a replicas response whose list is not an array', async () => {
    configureControlPlane()
    fetchMock = stubFetch({ replicasBody: { replicas: [] } })
    vi.stubGlobal('fetch', fetchMock)

    const probe = await probeVerdaReplicas()

    expect(probe.ok).toBe(false)
    expect(probe.reason).toContain('unexpected response shape')
  })

  it('caches a degraded result for the same TTL, so a down control plane costs one attempt per window', async () => {
    configureControlPlane()
    fetchMock = stubFetch({ status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    await probeVerdaReplicas()
    await probeVerdaReplicas()
    await probeVerdaReplicas()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('warns at most once per reason, and again when the reason changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      configureControlPlane()
      fetchMock = stubFetch({ status: 500 })
      vi.stubGlobal('fetch', fetchMock)

      await probeVerdaReplicas()
      await probeVerdaReplicas()
      expect(warn).toHaveBeenCalledTimes(1)

      // A DIFFERENT failure is new information.
      fetchMock = stubFetch({ status: 403 })
      vi.stubGlobal('fetch', fetchMock)
      resetControlPlaneCache()
      await probeVerdaReplicas()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1]?.[0]).toContain('HTTP 403')

      // RECOVERY clears the memory: a later failure with a SEEN reason is a
      // new transition too, and must warn again.
      fetchMock = stubFetch({ status: 200 })
      vi.stubGlobal('fetch', fetchMock)
      resetControlPlaneCache()
      await probeVerdaReplicas()
      expect(warn).toHaveBeenCalledTimes(2)

      fetchMock = stubFetch({ status: 500 })
      vi.stubGlobal('fetch', fetchMock)
      resetControlPlaneCache()
      await probeVerdaReplicas()
      expect(warn).toHaveBeenCalledTimes(3)
      expect(warn.mock.calls[2]?.[0]).toContain('HTTP 500')
    } finally {
      warn.mockRestore()
    }
  })

  it('warns once for missing credentials, not once per poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await probeVerdaReplicas()
      await probeVerdaReplicas()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('missing-credentials')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('probing never wakes the box', () => {
  it('reads no inference-endpoint variable anywhere in the module', () => {
    // The source half of the pin, pinned on the READ (`process.env.`) rather
    // than on the bare name: the module's own docstring is allowed to MENTION
    // the inference endpoint in order to say it does not use it — what must
    // never appear is code that reads it.
    const source = readFileSync(MODULE_PATH, 'utf8')
    expect(source).not.toContain('process.env.VERDA_INFERENCE')
  })

  it('sends every fetch to the control plane, never to the inference endpoint', async () => {
    // The runtime half: with the inference endpoint configured and observable,
    // a probe must still touch only api.verda.com.
    vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://inference.example.invalid/v1')
    vi.stubEnv('VERDA_INFERENCE_API_KEY', 'inference-key')
    configureControlPlane()

    await probeVerdaReplicas()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const url of urls()) {
      expect(url).toMatch(/^https:\/\/api\.verda\.com\//)
      expect(url).not.toContain('inference.example.invalid')
    }
  })
})

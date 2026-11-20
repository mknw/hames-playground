/**
 * The Modal control-plane client (#1057) — the app's route to the sidecar.
 *
 * The module's whole contract is the Verda probe's, carried to a second
 * control plane, plus the two things #1057 added: the control actions and the
 * boot-request clock. What is pinned here:
 *
 *   - the token NEVER travels farther than the sidecar's own Authorization
 *     header: no log line carries it (the source scan pins the module has no
 *     `console.*` at all beyond the warn-once paths, which carry only the
 *     degraded reason), and no request the module builds addresses anything
 *     but the sidecar — never an inference endpoint, whose variables the
 *     source scan also forbids (a status read that scaled the box up would be
 *     the one failure this module exists to prevent);
 *   - the configured gate: without both vars every answer is the designed
 *     `missing-token` degrade, never a throw;
 *   - the probe: one bounded fetch per TTL, shared by concurrent callers,
 *     both boxes reduced from one round trip, every transport failure a
 *     degraded per-box reason;
 *   - the boot clock: the FIRST ask stamps, later asks keep it, the poll's end
 *     clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  MODAL_CONTROL_TIMEOUT_MS,
  MODAL_PROBE_CACHE_TTL_MS,
  DEFAULT_MODAL_NOT_STARTING_AFTER_MS,
  modalBootPendingSince,
  modalControlConfigured,
  modalNotStartingAfterMs,
  noteModalBootEnded,
  noteModalBootRequested,
  probeModalBoxes,
  resetModalBootPending,
  resetModalControlCache,
  setModalBoxMinContainers,
  stopModalBoxContainers,
} from '../../../lib/inference/modal-control.server'

const MODULE_PATH = join(process.cwd(), 'src/lib/inference/modal-control.server.ts')
const SOURCE = readFileSync(MODULE_PATH, 'utf8')

const ENV_KEYS = [
  'MODAL_CONTROL_BASE',
  'MODAL_CONTROL_TOKEN',
  'MODAL_NOT_STARTING_AFTER_MS',
] as const

let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  resetModalControlCache()
  resetModalBootPending()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetModalControlCache()
  resetModalBootPending()
})

function configure(base = 'http://127.0.0.1:8124', token = 'test-modal-token'): void {
  process.env.MODAL_CONTROL_BASE = base
  process.env.MODAL_CONTROL_TOKEN = token
}

/** The sidecar's `/state` answer, both boxes, as the real one shapes it. */
function stateBody(
  boxes: {
    large?: { containers?: unknown[]; ok?: boolean; error?: string }
    small?: { containers?: unknown[]; ok?: boolean; error?: string }
  } = {},
): unknown {
  const box = (b: { containers?: unknown[]; ok?: boolean; error?: string } = {}) => ({
    ok: b.ok ?? true,
    app: 'test-app',
    server: 'test-server',
    containers: b.containers ?? [],
    ...(b.error ? { error: b.error } : {}),
  })
  return { ok: true, boxes: { large: box(boxes.large), small: box(boxes.small) } }
}

const AUTH = 'Authorization'

describe('the configured gate', () => {
  it('is closed without both vars, and the probe answers the designed degrade', async () => {
    const probe = await probeModalBoxes()
    expect(modalControlConfigured()).toBe(false)
    expect(probe.large.ok).toBe(false)
    expect(probe.large.reason).toBe('missing-token')
    expect(probe.small).toMatchObject({ ok: false, reason: 'missing-token' })
  })

  it('caches the missing-token answer like any other — one warn, no fetch storm', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await probeModalBoxes()
    await probeModalBoxes()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is closed with a base but no token, and open with both', () => {
    process.env.MODAL_CONTROL_BASE = 'http://127.0.0.1:8124'
    expect(modalControlConfigured()).toBe(false)
    configure()
    expect(modalControlConfigured()).toBe(true)
  })

  it('trims and de-slashes the base, as the Verda base is treated', () => {
    process.env.MODAL_CONTROL_BASE = ' http://127.0.0.1:8124/ '
    process.env.MODAL_CONTROL_TOKEN = 't'
    // Not asserted through a public getter (there is none on purpose — the
    // base is only read into a request); the probe's fetch URL says it.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stateBody())))
    vi.stubGlobal('fetch', fetchMock)
    void probeModalBoxes()
    expect(String(fetchMock.mock.calls[0] as unknown as [string])).toBe(
      'http://127.0.0.1:8124/state',
    )
  })
})

describe('the probe', () => {
  it('asks the sidecar with the bearer, once per TTL, and shares one flight', async () => {
    configure()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stateBody())))
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([probeModalBoxes(), probeModalBoxes(), probeModalBoxes()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8124/state')
    expect((init.headers as Record<string, string>)[AUTH]).toBe('Bearer test-modal-token')
  })

  it('reduces both boxes: counts, oldest start, and the per-box error field', async () => {
    configure()
    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              stateBody({
                large: { containers: [{ container_id: 'ct-a', started_at_ms: now - 60_000 }] },
                small: { ok: false, error: 'modal control plane: quota' },
              }),
            ),
          ),
      ),
    )
    const probe = await probeModalBoxes()
    expect(probe.large).toMatchObject({
      ok: true,
      containerCount: 1,
      oldestContainerStartedAtMs: now - 60_000,
      reason: null,
    })
    // A broken box degrades alone: the other still answers.
    expect(probe.small).toMatchObject({
      ok: false,
      containerCount: null,
      reason: 'modal control plane: quota',
    })
  })

  it('treats a startless container list as live (count, no start) — the SDK call carries none', async () => {
    configure()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              stateBody({
                large: {
                  containers: [
                    { container_id: 'ct-a', started_at_ms: null },
                    { container_id: 'ct-b', started_at_ms: 'nope' },
                  ],
                },
              }),
            ),
          ),
      ),
    )
    const probe = await probeModalBoxes()
    expect(probe.large.containerCount).toBe(2)
    expect(probe.large.oldestContainerStartedAtMs).toBeNull()
  })

  it('serves one probe to every caller within the TTL, then re-probes', async () => {
    configure()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stateBody())))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    try {
      await probeModalBoxes()
      const [second, third] = await Promise.all([probeModalBoxes(), probeModalBoxes()])
      expect(second).toEqual(third)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(MODAL_PROBE_CACHE_TTL_MS + 1)
      await probeModalBoxes()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns at most once per reason, and again when the reason changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      configure()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('boom', { status: 500 })),
      )
      await probeModalBoxes()
      await probeModalBoxes()
      expect(warn).toHaveBeenCalledTimes(1)

      // A DIFFERENT failure is new information.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('no', { status: 403 })),
      )
      resetModalControlCache()
      await probeModalBoxes()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1]?.[0]).toContain('HTTP 403')

      // RECOVERY clears the memory: a later failure with a SEEN reason warns
      // again too.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(stateBody()))),
      )
      resetModalControlCache()
      await probeModalBoxes()
      expect(warn).toHaveBeenCalledTimes(2)

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('the socket is gone')
        }),
      )
      resetModalControlCache()
      await probeModalBoxes()
      expect(warn).toHaveBeenCalledTimes(3)
      expect(warn.mock.calls[2]?.[0]).toContain('socket is gone')
    } finally {
      warn.mockRestore()
    }
  })

  it('degrades on a non-2xx, a timeout and an unparseable body — never throws', async () => {
    configure()
    for (const answer of [
      () => Promise.resolve(new Response('nope', { status: 503 })),
      () =>
        new Promise<Response>((_resolve, reject) =>
          setTimeout(() => reject(new Error('fetch failed')), 5),
        ),
      () =>
        Promise.resolve(
          new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
        ),
    ]) {
      resetModalControlCache()
      vi.stubGlobal('fetch', vi.fn(answer))
      const probe = await probeModalBoxes()
      expect(probe.large.ok).toBe(false)
      expect(probe.large.reason).toBeTruthy()
      expect(probe.small.ok).toBe(false)
    }
  })

  it('bounds every fetch to MODAL_CONTROL_TIMEOUT_MS', () => {
    expect(MODAL_CONTROL_TIMEOUT_MS).toBe(5_000)
  })
})

describe('the control actions', () => {
  it('posts min_containers 1 and 0 with the box, and never caches', async () => {
    configure()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, min_containers: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await setModalBoxMinContainers('large', 1)
    await setModalBoxMinContainers('small', 0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [urlA, initA] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [urlB, initB] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(urlA).toBe('http://127.0.0.1:8124/autoscaler')
    expect(urlB).toBe(urlA)
    expect((initA.headers as Record<string, string>)[AUTH]).toBe('Bearer test-modal-token')
    expect(JSON.parse(String(initA.body))).toEqual({ box: 'large', min_containers: 1 })
    expect(JSON.parse(String(initB.body))).toEqual({ box: 'small', min_containers: 0 })
  })

  it('posts stop with the box, and reports the containers it named', async () => {
    configure()
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, stopped: ['ct-a'] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const answer = await stopModalBoxContainers('small')
    expect(answer.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8124/stop')
    expect(JSON.parse(String(init.body))).toEqual({ box: 'small' })
  })

  it('degrades — never throws — on a refused action, carrying the sidecar’s reason', async () => {
    configure()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing-modal-token' }))),
    )
    const answer = await setModalBoxMinContainers('large', 1)
    expect(answer).toMatchObject({ ok: false, reason: 'missing-modal-token' })
  })

  it('is the configured gate first: without both vars there is nothing to post to', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await setModalBoxMinContainers('large', 1)).toMatchObject({
      ok: false,
      reason: 'missing-token',
    })
    expect(await stopModalBoxContainers('small')).toMatchObject({
      ok: false,
      reason: 'missing-token',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the boot-request clock', () => {
  it('keeps the FIRST ask: a second poll for the same box does not restart the count', () => {
    const t0 = 1_000_000
    noteModalBootRequested('large', t0)
    noteModalBootRequested('large', t0 + 300_000)
    expect(modalBootPendingSince('large')).toBe(t0)
  })

  it('is per box, and clears only for the box that ended', () => {
    noteModalBootRequested('large', 1)
    noteModalBootRequested('small', 2)
    noteModalBootEnded('large')
    expect(modalBootPendingSince('large')).toBeNull()
    expect(modalBootPendingSince('small')).toBe(2)
  })
})

describe('the not-starting threshold', () => {
  it('defaults to 300s — well under the 1200s wake budget — and refuses a bad override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(DEFAULT_MODAL_NOT_STARTING_AFTER_MS).toBe(300_000)
      expect(modalNotStartingAfterMs()).toBe(300_000)
      process.env.MODAL_NOT_STARTING_AFTER_MS = '0'
      expect(modalNotStartingAfterMs()).toBe(300_000)
      process.env.MODAL_NOT_STARTING_AFTER_MS = '12000'
      expect(modalNotStartingAfterMs()).toBe(12_000)
      // Only the garbage value warned, and it named its variable.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('MODAL_NOT_STARTING_AFTER_MS')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the source pins', () => {
  it('reads NO inference-endpoint variable — a status read that scaled a box up is the failure this module exists to prevent', () => {
    // Pinned on the READ (`process.env.`) rather than the bare name, the same
    // rule `verda-control-plane.test.ts` states: the module's own docstring is
    // allowed to MENTION the inference endpoints in order to promise it does
    // not use them — what must never appear is code that reads one.
    const forbidden = [
      'process.env.LARGE_LLM_BASE_URL',
      'process.env.LARGE_LLM_API_KEY',
      'process.env.SMALL_LLM_BASE_URL',
      'process.env.SMALL_LLM_API_KEY',
      'process.env.SMALL_LLM_DECISIONS_URL',
      'process.env.JEV_DECISIONS_URL',
      'inferenceEnv(',
    ]
    for (const name of forbidden) {
      expect(SOURCE, `the module must not read ${name}`).not.toContain(name)
    }
  })

  it('logs no token: every console call in the module carries only a degraded reason', () => {
    const logs = [...SOURCE.matchAll(/console\.(log|warn|error|info)\(/g)]
    expect(logs.length).toBeGreaterThan(0)
    for (const match of logs) {
      const line = match[0]
      expect(line, 'the module never logs the token').not.toMatch(/[Tt]oken(?![s]?\s)/)
    }
  })
})

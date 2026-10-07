/**
 * The joint memory wake (#419 D20) — the poll that lets the 4B and the embedder
 * scale to zero.
 *
 * `verda-wake.test.ts` pins the Verda wake this module is modelled on; this
 * file pins the memory wake's deltas from it, which is where its own failures
 * would live:
 *
 *   - the target set follows the TURN's tier (an Anthropic-tier turn never
 *     waits on — or wakes — a 4B it never calls), and the joint promise
 *     resolves only when ALL REQUESTED targets proved up;
 *   - the wake starts only for an agent that opted into memory, and starts
 *     EAGERLY, before the chain's first pattern can run;
 *   - it is fail-open: a failed wake never fails the turn, never blocks a
 *     waiter past its budget, and never sends a call to a public provider;
 *   - both consumers — the recall gate (M1) and `settleMemory` (M2) — attach
 *     to the ONE deduplicated poll through `awaitMemoryWake`, bounded, while
 *     the wake keeps running in the background.
 *
 * The recall gate and `settleMemory` are later slices; their call sites are
 * pinned by fakes here at the seam this slice owns (`ensureMemoryAwake` /
 * `awaitMemoryWake`), which is what makes the M1/M2/M5 slices free to wire
 * without re-deciding any of this. A real `fetch` is stubbed rather than a
 * server started, for the same reason `verda-wake.test.ts` gives: what is
 * being pinned is the requests this module builds and the decisions around
 * them. The live counterpart is one cold-start cycle against the real boxes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

/** The turn's tier, under the test's control — the wake reads it at poll start
 *  through `activeInferenceTier()`, the SAME seam the run frame fills. */
const tier = vi.hoisted(() => ({ current: 'verda' as 'verda' | 'anthropic' }))
vi.mock('@hames-ai/harness-baml/clients.server', () => ({
  activeInferenceTier: () => tier.current,
}))

import {
  ensureMemoryAwake,
  awaitMemoryWake,
  resetMemoryWake,
  MEMORY_WAKE_FAILED,
  MEMORY_WAKE_PROMPT,
  SUMMARIZER_MODEL_ID,
  embedderWakeModel,
  DEFAULT_MEMORY_WAKE_TIMEOUT_MS,
  DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS,
  memoryWakeTimeoutMs,
  memoryWakeAttemptTimeoutMs,
  memoryWakePollIntervalMs,
} from '../../../lib/inference/memory-wake.server'

const SMALL_BASE = 'https://small.test/v1'
const EMBED_BASE = 'https://embed.test/v1'
const SMALL_URL = `${SMALL_BASE}/chat/completions`
const EMBED_URL = `${EMBED_BASE}/embeddings`

/** A 200 from an OpenAI-compatible endpoint, shaped enough to be drained. */
function ok(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A request the endpoint never answers — the drop-during-startup behaviour. It
 * rejects with `AbortError` when the module's own signal fires, which is what
 * node's `fetch` does, so the module's timeout handling is exercised rather
 * than simulated.
 */
function stalls(): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
}

/** A short, deterministic poll: 10 attempts of 10s with a 1s gap, in 100s. */
const FAST_POLL = {
  MEMORY_WAKE_TIMEOUT_MS: '100000',
  MEMORY_WAKE_ATTEMPT_TIMEOUT_MS: '10000',
  MEMORY_WAKE_POLL_INTERVAL_MS: '1000',
}
const FAST_CYCLE_MS = 11_000
const FAST_ATTEMPTS = 10

let fetchMock: ReturnType<typeof vi.fn>
let warn: ReturnType<typeof vi.spyOn>

const WAKE_VARS = [
  'MEMORY_WAKE_TIMEOUT_MS',
  'MEMORY_WAKE_ATTEMPT_TIMEOUT_MS',
  'MEMORY_WAKE_POLL_INTERVAL_MS',
]

beforeEach(() => {
  resetMemoryWake()
  tier.current = 'verda'
  process.env.SMALL_LLM_BASE_URL = SMALL_BASE
  process.env.EMBEDDINGS_LOCAL_URL = EMBED_BASE
  process.env.SMALL_LLM_API_KEY = 'small-key'
  process.env.EMBEDDINGS_LOCAL_API_KEY = 'embed-key'
  for (const name of WAKE_VARS) delete process.env[name]
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetMemoryWake()
  delete process.env.SMALL_LLM_BASE_URL
  delete process.env.EMBEDDINGS_LOCAL_URL
  delete process.env.SMALL_LLM_API_KEY
  delete process.env.EMBEDDINGS_LOCAL_API_KEY
  for (const name of WAKE_VARS) delete process.env[name]
  warn.mockRestore()
})

/** The URLs every request so far was sent to, in order. */
function sentUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]))
}

/** Stub each endpoint by which URL is asked, so per-target behaviour is exact. */
function byUrl(
  small: (url: string, init?: RequestInit) => Promise<Response>,
  embed: (url: string, init?: RequestInit) => Promise<Response>,
) {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    String(url).startsWith(SMALL_BASE) ? small(String(url), init) : embed(String(url), init),
  )
}

/** A target that stalls its first `n` attempts, then answers. Each target
 *  loops independently, so the stall count is per target. */
function stallsFirst(n: number) {
  let calls = 0
  return (url: string | URL, init?: RequestInit) => {
    calls += 1
    return calls <= n ? stalls()(url, init) : Promise.resolve(ok())
  }
}

/** Swallow a rejection so an unhandled one cannot fail an unrelated test. */
function quiet<T>(p: Promise<T>): Promise<T | Error> {
  return p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
}

describe('the requested target set follows the turn’s tier', () => {
  it('requests ONLY the embedder on an anthropic-tier turn', async () => {
    // The 4B serves decide/describe under the private tier only; an
    // Anthropic-tier turn gates through calibrated Jev and describes through
    // the Anthropic chain. Requesting the 4B there would push the joint
    // promise past the gate's 1500ms budget on a turn that only needed the
    // embedder — a spurious `skipped: 'waking'` — and wake a box the turn
    // never uses.
    tier.current = 'anthropic'
    await ensureMemoryAwake(true)
    expect(sentUrls()).toEqual([EMBED_URL])
  })

  it('requests BOTH on a verda-tier turn', async () => {
    await ensureMemoryAwake(true)
    expect(sentUrls()).toEqual([EMBED_URL, SMALL_URL])
  })
})

describe('the opt-in gate', () => {
  it('starts NOTHING for a turn whose agent did not opt into memory', async () => {
    // The same `harnessUsesMemory(patterns)` / `AgentDeps.memory` probe that
    // gates `settleMemory` is what the wiring (M5) passes here. Waking the
    // embedder box for an agent with no memory is GPU seconds spent on
    // nothing — the exact economics that rejected early-start-alone.
    await ensureMemoryAwake(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts the wake for an opted-in turn, eagerly, before anything awaits it', async () => {
    // The value of the wake is the overlap: it must begin the moment the turn
    // calls it — before the chain's first pattern, before anyone waits — so
    // the recall gate's budget usually finds it already landed. A start
    // deferred until first await would lose that overlap one microtask at a
    // time; the assertion is synchronous on purpose.
    const wake = ensureMemoryAwake(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await wake
  })
})

describe('what goes on the wire', () => {
  it('probes with forward passes, never /health or /v1/models', async () => {
    // The Verda wake's measured lesson applies to both boxes: a readiness
    // endpoint answers while the weights are still loading, wrong in both
    // directions. Only a request that makes the box produce something proves
    // it — a 1-token completion, a one-item embedding.
    await ensureMemoryAwake(true)
    expect(fetchMock.mock.calls[0]).toEqual([
      EMBED_URL,
      expect.objectContaining({ method: 'POST' }),
    ])
    expect(fetchMock.mock.calls[1]).toEqual([
      SMALL_URL,
      expect.objectContaining({ method: 'POST' }),
    ])
    for (const url of sentUrls()) {
      expect(url).not.toContain('/models')
      expect(url).not.toContain('health')
    }
  })

  it('the 4B probe is a 1-token completion at temperature 0 (SD-10: fixed literals)', async () => {
    await ensureMemoryAwake(true)
    const init = fetchMock.mock.calls.find(([url]) => url === SMALL_URL)![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      model: SUMMARIZER_MODEL_ID,
      messages: [{ role: 'user', content: MEMORY_WAKE_PROMPT }],
      max_tokens: 1,
      temperature: 0,
    })
  })

  it('the embedder probe is a ONE-ITEM /v1/embeddings (SD-10: fixed literals)', async () => {
    await ensureMemoryAwake(true)
    const init = fetchMock.mock.calls.find(([url]) => url === EMBED_URL)![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      model: embedderWakeModel(),
      input: [MEMORY_WAKE_PROMPT],
    })
  })

  it('carries each endpoint’s own optional key, and joins the base without doubling the slash', async () => {
    process.env.EMBEDDINGS_LOCAL_URL = `${EMBED_BASE}/`
    await ensureMemoryAwake(true)
    const embedInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(fetchMock.mock.calls[0][0]).toBe(EMBED_URL)
    expect((embedInit.headers as Record<string, string>).Authorization).toBe('Bearer embed-key')
    const smallInit = fetchMock.mock.calls[1][1] as RequestInit
    expect((smallInit.headers as Record<string, string>).Authorization).toBe('Bearer small-key')
  })

  it('bounds every attempt with an abort signal — node fetch has no default timeout', async () => {
    await ensureMemoryAwake(true)
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('pins the 4B model id against the .baml declaration', async () => {
    // `SUMMARIZER_MODEL_ID` is a COPY of the `model` line on `LocalQwenSmall` —
    // the probe is a hand-rolled fetch, so it has to name a model and BAML
    // exports nothing to read it from. A server that validates model names
    // 400s a drifting id, which `isRefusal` correctly refuses to retry: memory
    // would be silently off until someone reads the log. This pin makes the
    // copy safe the way `VERDA_MODEL_ID`'s pin does.
    const declared = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/baml_src/local-client.baml'),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(declared).toContain(`model "${SUMMARIZER_MODEL_ID}"`)
  })

  it('pins the embedder model id default against the embeddings module it mirrors', async () => {
    // `embedderWakeModel()` repeats `stash/embeddings.server.ts`'s lookup —
    // `EMBEDDINGS_LOCAL_MODEL`, else that module's `LOCAL_DEFAULT_MODEL`. A
    // probe naming a model the real embedder never sends is a 400 on the
    // server that validates names, so the copy is pinned against the source.
    expect(embedderWakeModel()).toBe(process.env.EMBEDDINGS_LOCAL_MODEL ?? 'Qwen3-Embedding-0.6B')
    const declared = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-patterns/stash/embeddings.server.ts'),
      'utf8',
    )
    expect(declared).toContain(`LOCAL_DEFAULT_MODEL = '${embedderWakeModel()}'`)
  })
})

describe('the three budgets', () => {
  it('ships the unmeasured defaults D20 states, and no Verda number is inherited', () => {
    // The 4B (~2.5GB) and the embedder (639MB) are an order of magnitude
    // smaller than the 27B whose readings sized the Verda wake's 600s, so
    // 180s is a PLACEHOLDER for layer 4 to measure — closer to the truth than
    // the Verda numbers, but still not a reading.
    expect(DEFAULT_MEMORY_WAKE_TIMEOUT_MS).toBe(180_000)
    expect(DEFAULT_MEMORY_WAKE_TIMEOUT_MS).toBeLessThan(600_000)
  })

  it('ships a per-attempt bound a WARM call clears and a cold start does not', () => {
    expect(DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS).toBe(30_000)
    expect(DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(10_000)
  })

  it('leaves room for many attempts inside the overall budget', () => {
    // A poll whose cycle does not divide the budget several times over is a
    // single request wearing a loop.
    const cycle = DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS + DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS
    expect(Math.floor(DEFAULT_MEMORY_WAKE_TIMEOUT_MS / cycle)).toBeGreaterThanOrEqual(5)
  })

  it('takes env overrides, so a different deployment needs no rebuild', () => {
    process.env.MEMORY_WAKE_TIMEOUT_MS = '90000'
    process.env.MEMORY_WAKE_ATTEMPT_TIMEOUT_MS = '20000'
    process.env.MEMORY_WAKE_POLL_INTERVAL_MS = '2500'
    expect(memoryWakeTimeoutMs()).toBe(90_000)
    expect(memoryWakeAttemptTimeoutMs()).toBe(20_000)
    expect(memoryWakePollIntervalMs()).toBe(2_500)
  })

  it('refuses a zero or garbage override rather than honouring it', () => {
    // Through the SAME parser as the Verda wake (`wakeEnvMs`), so the two
    // wakes cannot grow different validation policies either.
    process.env.MEMORY_WAKE_ATTEMPT_TIMEOUT_MS = '0'
    process.env.MEMORY_WAKE_POLL_INTERVAL_MS = 'soon'
    expect(memoryWakeAttemptTimeoutMs()).toBe(DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS)
    expect(memoryWakePollIntervalMs()).toBe(DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS)
  })
})

describe('the joint promise resolves only when all requested targets proved up', () => {
  it('keeps waiting for the 4B after the embedder has answered', async () => {
    // "Wake both containers at the same time" means the wake is done when
    // both are up, not when the faster one is: resolving on the first would
    // let the store's extract/embed calls reach a 4B that is still loading.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    // The EMBEDDER answers its first attempt; the 4B stalls one out.
    byUrl(stallsFirst(1), () => Promise.resolve(ok()))

    const wake = quiet(ensureMemoryAwake(true))
    let settled = false
    void wake.then(() => (settled = true))
    // Attempt 1: the embedder answers inside it, the 4B times out at 10s.
    await vi.advanceTimersByTimeAsync(10_500)
    expect(settled, 'the embedder answered but the joint promise must not resolve').toBe(false)

    // Attempt 2, at 11s: the 4B answers, and the joint promise lands.
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS)
    await wake
    expect(settled).toBe(true)
    expect(sentUrls().filter((u) => u === SMALL_URL)).toHaveLength(2)
  })

  it('joins the whole loop: a caller arriving in the gap attaches, adding no poll', async () => {
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    // Both targets stall two attempts, then answer: the poll ends on attempt
    // 3 — one loop, three requests per target, six in all. A second poll
    // would have made it eight.
    byUrl(stallsFirst(2), stallsFirst(2))

    const first = quiet(ensureMemoryAwake(true))
    // Land the second caller in the GAP between attempt 1 and attempt 2.
    await vi.advanceTimersByTimeAsync(10_500)
    const second = quiet(ensureMemoryAwake(true))
    // Past attempt 3 (22s), where both targets answer.
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 2)

    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})

describe('one deduplicated poll, shared by every module copy', () => {
  it('sends ONE request per target for three simultaneous callers', async () => {
    // The measured failure this prevents (three chats into a sleeping box are
    // one replica's QUEUE, 2026-08-26), at memory scale: the state lives on a
    // `globalThis` symbol, so concurrent opted-in turns share one poll.
    byUrl(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 50)),
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 50)),
    )

    const turns = [ensureMemoryAwake(true), ensureMemoryAwake(true), ensureMemoryAwake(true)]
    await Promise.all(turns)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a FRESH MODULE COPY shares the in-flight poll instead of starting a second one', async () => {
    // The `globalThis` symbol is the point of the dedupe idiom: two loaded
    // copies of this module — a second bundle, a duplicated import — must
    // still share ONE poll, or a copy pair would double every cold start.
    // `vi.resetModules()` + a dynamic import is a genuine fresh copy: fresh
    // module state, same `globalThis`.
    const first = await import('../../../lib/inference/memory-wake.server')
    vi.resetModules()
    const second = await import('../../../lib/inference/memory-wake.server')

    byUrl(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 50)),
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 50)),
    )
    await Promise.all([first.ensureMemoryAwake(true), second.ensureMemoryAwake(true)])
    expect(fetchMock, 'two copies, one poll — two requests, not four').toHaveBeenCalledTimes(2)
  })
})

describe('which failures are retried, and which end the wake on the spot', () => {
  it('a 401 ends the wake immediately and names the target', async () => {
    // A bad key is a property of the request, not of the box's state: every
    // retry would be the same rejection. The message names the TARGET — with
    // two boxes, "it did not wake" without a name is half a diagnosis.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith(EMBED_BASE)
        ? new Response('bad key', { status: 401 })
        : new Promise<Response>(() => {}),
    )
    await ensureMemoryAwake(true)
    expect(fetchMock).toHaveBeenCalledTimes(2) // one per target, no retry
    const message = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(message).toContain(MEMORY_WAKE_FAILED)
    expect(message).toContain('embedder')
    expect(message).toContain('401')
    expect(message).toContain('nothing was sent to any other provider')
  })

  it('a refusal stops the sibling loop — the joint wake is over', async () => {
    // The embedder refuses on attempt 1; the 4B, mid-wake, must not keep
    // hammering its box for the rest of the budget behind a poll nobody is
    // waiting on any more.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    byUrl(() => Promise.resolve(new Response('bad key', { status: 401 })), stalls())
    await ensureMemoryAwake(true)
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 2)
    expect(fetchMock, 'the 4B loop was aborted with the joint wake').toHaveBeenCalledTimes(2)
  })

  it('retries a 5xx — a starting box saying "not yet"', async () => {
    // Including the gateway's own `504 inference request was canceled`, which
    // is what a box that is still starting says.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    let embedCalls = 0
    byUrl(
      () => Promise.resolve(ok()),
      () => {
        embedCalls += 1
        return embedCalls === 1
          ? Promise.resolve(new Response('canceled', { status: 504 }))
          : Promise.resolve(ok())
      },
    )
    const wake = quiet(ensureMemoryAwake(true))
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS)
    await wake
    expect(fetchMock).toHaveBeenCalledTimes(3) // 4B once; embedder 504, then ok
  })

  it('retries a transport error, and the message carries the count and the last error', async () => {
    vi.useFakeTimers()
    process.env.MEMORY_WAKE_TIMEOUT_MS = '4000'
    process.env.MEMORY_WAKE_ATTEMPT_TIMEOUT_MS = '1000'
    process.env.MEMORY_WAKE_POLL_INTERVAL_MS = '500'
    byUrl(
      () => Promise.resolve(ok()),
      async () => {
        throw new TypeError('fetch failed')
      },
    )
    // Four seconds of budget, immediate transport failures: attempts at 0,
    // 1.5 and 3 (the last capped), then the budget expires.
    const wake = quiet(ensureMemoryAwake(true))
    await vi.advanceTimersByTimeAsync(4_000)
    await wake
    const message = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(message).toContain('fetch failed')
    expect(message).toContain('embedder')
    expect(message).toContain('attempts')
  })

  it('treats an UNCONFIGURED endpoint as a refusal, not a retry', async () => {
    // Without EMBEDDINGS_LOCAL_URL the memory pipeline cannot run at all;
    // polling one out would spend the whole budget asking for an address
    // nobody set. The env var is named, because the fix is a one-liner.
    delete process.env.EMBEDDINGS_LOCAL_URL
    await ensureMemoryAwake(true)
    expect(sentUrls().filter((u) => u.startsWith(EMBED_BASE))).toHaveLength(0)
    const message = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(message).toContain('EMBEDDINGS_LOCAL_URL is not set')
  })

  it('pins the refusal classification to the SHARED helper, not a copy', async () => {
    // `isRefusal` moved to a shared export of `wake.server.ts` precisely so
    // the two wakes cannot drift into two answers on the same status. The
    // source scan is the pin: the memory wake imports it and declares no
    // second classification of its own.
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/lib/inference/memory-wake.server.ts'),
      'utf8',
    )
    expect(source).toContain("from './wake.server'")
    expect(source).not.toMatch(/function isRefusal/)
  })
})

describe('the bounded wait both consumers attach through', () => {
  it('expires into "skipped" while the wake keeps running, and lands "awake" later', async () => {
    // The recall gate's contract (M1): the wait costs at most its budget; the
    // wake itself keeps going so the post-reply store and the next turn
    // benefit. A waiter that gave up must not have stopped the poll.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    let embedCalls = 0
    byUrl(
      () => Promise.resolve(ok()),
      (url, init) => {
        embedCalls += 1
        return embedCalls < 3 ? stalls()(url, init) : Promise.resolve(ok())
      },
    )

    void ensureMemoryAwake(true)
    const first = awaitMemoryWake(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await first).toBe('skipped')
    // ...the wake is still running: it lands on the embedder's third attempt.
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 2 + 1_000)
    // The 4B answered its first attempt (1) and the embedder its third (3).
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // The poll has settled and cleared by now: a LATER attach — `settleMemory`
    // minutes into the turn — sees 'awake' and proceeds, without any request.
    const before = fetchMock.mock.calls.length
    expect(await awaitMemoryWake(1_000)).toBe('awake')
    expect(fetchMock).toHaveBeenCalledTimes(before)
  })

  it('attaches to the wake and never STARTS one', async () => {
    // The wake's value is that it began before the chain's first pattern; a
    // waiter that could lazily start a poll would quietly move the start into
    // the gate, losing the overlap. With nothing in flight the answer is
    // immediate either way.
    expect(await awaitMemoryWake(1_000)).toBe('awake')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports "skipped" — never a rejection — when the wake fails inside the budget', async () => {
    fetchMock.mockImplementation(async () => new Response('bad key', { status: 401 }))
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    resetMemoryWake()
    byUrl(
      () => Promise.resolve(ok()),
      () => Promise.resolve(new Response('bad key', { status: 401 })),
    )
    // A fresh poll whose 4B leg refuses: a waiter attached through
    // awaitMemoryWake gets 'skipped', not a throw.
    void ensureMemoryAwake(true)
    await Promise.resolve()
    expect(await awaitMemoryWake(1_000)).toBe('skipped')
  })

  it("reads 'skipped' after a refused wake has settled and cleared (F1)", async () => {
    // THE FAST-REFUSAL TIMELINE, which is the common misconfiguration case: a
    // refusal rejects in MILLISECONDS — long before the detached
    // `compactAndSave` continuation (settleMemory) asks. With only the
    // in-flight slot to consult, a late waiter read 'awake' and proceeded to
    // extract/embed against the misconfigured box; D20's skip-on-rejection
    // was unreachable. The settled poll's outcome is what closes that gap.
    fetchMock.mockImplementation(async () => new Response('bad key', { status: 401 }))
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    expect(await awaitMemoryWake(1_000)).toBe('skipped')

    // Outcome reporting, not retry memoisation: the next turn starts a fresh
    // poll (it does not consult the stale failure), and a landed one reads
    // 'awake' again.
    fetchMock.mockImplementation(async () => ok())
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    expect(await awaitMemoryWake(1_000)).toBe('awake')
  })

  it('clears the budget timer when the wake answers — no timer outlives an answer (F4)', async () => {
    // The race's losing half is a `setTimeout` for up to `budgetMs` (180s for
    // settleMemory's use); on the wake-wins path it must be cleared, not left
    // pending behind a decided race.
    vi.useFakeTimers()
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    expect(await awaitMemoryWake(1_000)).toBe('awake')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the env knobs are documented where a deployment reads them', () => {
  it('every env var the module reads appears in .env.example (F2)', () => {
    // The VERDA_WAKE_* block is the established precedent: a wake's tunable
    // bounds are deployment knobs, documented with their defaults and their
    // reasoning, not discoverable only by reading the module. Source-scan, the
    // uno-fonts pattern: every name this module reads must have a row there.
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/lib/inference/memory-wake.server.ts'),
      'utf8',
    )
    const example = readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8')
    const names = new Set<string>()
    for (const m of source.matchAll(/wakeEnvMs\('([A-Z_]+)'/g)) names.add(m[1])
    for (const m of source.matchAll(/process\.env\.([A-Z_]+)/g)) names.add(m[1])
    for (const m of source.matchAll(/(?:envVar|keyEnvVar): '([A-Z_]+)'/g)) names.add(m[1])
    expect(names.size).toBeGreaterThanOrEqual(8)
    for (const name of names) {
      expect(
        example,
        `${name} is read by memory-wake.server.ts but not documented in .env.example`,
      ).toContain(name)
    }
  })
})

describe('fail-open: a failed wake is not the turn’s failure', () => {
  it('resolves — never throws — when the whole budget expires', async () => {
    // THE D20 CONTRACT: memory is opportunistic. The Verda wake fails the turn
    // visibly because confidential compute must not silently proceed; a
    // failed memory wake leaves the turn exactly as it was, minus memory.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    byUrl(stalls(), stalls())
    const wake = quiet(ensureMemoryAwake(true))
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(wake).resolves.toBeUndefined()
    const message = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(message).toContain(MEMORY_WAKE_FAILED)
    expect(message).toContain(`${FAST_ATTEMPTS} attempts`)
    expect(message).toContain('100s')
  })

  it('a failed poll is retried by the next turn, not remembered', async () => {
    // First wake: the embedder refuses on the spot (400). Second wake: a
    // fresh poll — a remembered rejection would poison every later turn —
    // and both boxes answer. Two requests per poll on the private tier.
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 400 }))
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('no failure ever sends a call to a public provider (SD-12)', async () => {
    // Every failure mode in one sweep — refusal, budget expiry, transport —
    // and after all of it, every request this module has ever sent went to
    // one of the two company-run endpoints. There is no configuration that
    // makes a failed memory wake into a Jev or Anthropic call.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)

    // 1. a refusal (immediate, no timers involved)
    tier.current = 'anthropic'
    fetchMock.mockImplementation(async () => new Response('down', { status: 400 }))
    await expect(ensureMemoryAwake(true)).resolves.toBeUndefined()
    resetMemoryWake()

    // 2. budget expiry on both legs (ten dropped attempts each)
    tier.current = 'verda'
    byUrl(stalls(), stalls())
    const stalled = quiet(ensureMemoryAwake(true))
    await vi.advanceTimersByTimeAsync(100_000)
    await stalled
    resetMemoryWake()

    // 3. transport errors every attempt (immediate failures, 1s gaps)
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })
    const unreachable = quiet(ensureMemoryAwake(true))
    await vi.advanceTimersByTimeAsync(100_000)
    await unreachable

    for (const url of sentUrls()) {
      expect(
        url.startsWith(SMALL_BASE) || url.startsWith(EMBED_BASE),
        `a request left the company-run endpoints: ${url}`,
      ).toBe(true)
    }
    const message = warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(message).toContain('nothing was sent to any other provider')
  })
})

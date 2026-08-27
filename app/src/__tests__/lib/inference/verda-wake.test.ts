/**
 * Wake-then-run — the poll that pays the cold start before the harness starts.
 *
 * `cold-start.test.ts` pins the NOTICE (when it fires, what it may record).
 * This file pins the REQUESTS and the control flow around them, which is where
 * the failures that matter live:
 *
 *   - the wake only happens when the box might be asleep. A ping per turn to a
 *     warm deployment is a request nobody needs and a second of latency on every
 *     message.
 *   - it is a COMPLETION, not `GET /v1/models`. Measured 2026-08-26, that
 *     endpoint answered in 1.2s while a real call on the same deployment took
 *     146s, so a readiness probe built on it reports ready and hands the user the
 *     whole wait anyway.
 *   - it POLLS. Two platform behaviours have been observed on the same
 *     deployment and they are mutually exclusive: on 2026-08-26 requests sent
 *     into a starting box were QUEUED and answered (146s, 71.7s), and on
 *     2026-08-27 every request sent during a ~360s startup was ABANDONED and
 *     never answered even after the box came up. A single long request survives
 *     only the first; short attempts retried until one lands survive both, which
 *     is the property the fake-timer tests below are about.
 *   - concurrent turns share ONE poll. The deployment is a single replica where
 *     concurrency is queueing, so three turns that each ran their own would queue
 *     three sets of attempts and the third user would wait all of them.
 *   - a failure is LOUD and the turn does not run. The two silent alternatives
 *     are both worse than a red turn: proceeding moves the same wait into a call
 *     whose timeout is now sized for a warm box, and falling back sends
 *     confidential prompts to the provider the tier exists to avoid (SD-12).
 *   - the measurement is the WHOLE wait, attributed to the turn that waited it,
 *     and to no other.
 *
 * A real `fetch` is stubbed rather than a server started: what is being pinned is
 * the requests this module builds and the decisions around them, and a loopback
 * server would test node's HTTP stack. The live counterpart is one cold-start
 * cycle against the real deployment, and e2e scenario 8 drives the whole path
 * through the fake endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  ensureVerdaAwake,
  resetVerdaWake,
  VERDA_WAKE_FAILED,
  VERDA_WAKE_PROMPT,
  DEFAULT_VERDA_WAKE_TIMEOUT_MS,
  DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS,
  DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS,
  verdaWakeTimeoutMs,
  verdaWakeAttemptTimeoutMs,
  verdaWakePollIntervalMs,
} from '../../../lib/inference/wake.server'
import {
  noteVerdaCallCompleted,
  resetVerdaActivity,
  verdaLastCallCompletedAt,
  VERDA_MODEL_ID,
} from '../../../lib/inference/verda-activity.server'
import {
  coldStartEstimate,
  resetColdStartHistory,
  runWithColdStartWatch,
  COLD_START_PLAUSIBILITY_FLOOR_MS,
  type ColdStartEstimate,
} from '../../../lib/inference/cold-start.server'

const ENDPOINT = 'https://example.invalid/deployment/v1'

/** A 200 from an OpenAI-compatible endpoint, shaped enough to be drained. */
function ok(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A request the endpoint never answers — the 2026-08-27 behaviour, and the only
 * thing that makes an attempt time out. It rejects with `AbortError` when the
 * module's own signal fires, which is what node's `fetch` does, so the module's
 * timeout handling is exercised rather than simulated.
 */
function stalls(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
}

/** A short, deterministic poll: 10 attempts of 10s with a 1s gap, in 100s. */
const FAST_POLL = {
  VERDA_WAKE_TIMEOUT_MS: '100000',
  VERDA_WAKE_ATTEMPT_TIMEOUT_MS: '10000',
  VERDA_WAKE_POLL_INTERVAL_MS: '1000',
}
const FAST_CYCLE_MS = 11_000
const FAST_ATTEMPTS = 10

let fetchMock: ReturnType<typeof vi.fn>

const WAKE_VARS = [
  'VERDA_WAKE_TIMEOUT_MS',
  'VERDA_WAKE_ATTEMPT_TIMEOUT_MS',
  'VERDA_WAKE_POLL_INTERVAL_MS',
]

beforeEach(() => {
  resetVerdaWake()
  resetVerdaActivity()
  resetColdStartHistory()
  process.env.VERDA_INFERENCE_ENDPOINT = ENDPOINT
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  for (const name of WAKE_VARS) delete process.env[name]
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetVerdaWake()
  resetVerdaActivity()
  resetColdStartHistory()
  delete process.env.VERDA_INFERENCE_ENDPOINT
  delete process.env.VERDA_INFERENCE_API_KEY
  for (const name of WAKE_VARS) delete process.env[name]
})

/** The body of the nth request the module sent. */
function sentBody(n = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[n][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** Swallow a rejection so an unhandled one cannot fail an unrelated test. */
function quiet<T>(p: Promise<T>): Promise<T | Error> {
  return p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
}

describe('when the wake is sent at all', () => {
  it('pings when this process has never seen the box', async () => {
    // `unknown`, not `cold`: the box may well be warm and this process simply
    // restarted. It pings anyway, which costs one 1-token request and is the
    // cheap side of the error — the other side is a user sitting through minutes
    // of silence.
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('pings when a call finished longer ago than the scale-down window', async () => {
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends NOTHING when a recent call proves the box is up', async () => {
    // The whole point of the warm clock. A ping per turn on a warm box is a
    // wasted request and a wasted second on every single message.
    noteVerdaCallCompleted(Date.now())
    await ensureVerdaAwake()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops at ONE attempt when the box answers — a warm box never retries', async () => {
    // The case that makes the whole wake cheap. Every default is chosen so the
    // first attempt covers a warm call with room to spare (single-call 4.1s,
    // 9.9s p95 at 8-way, 2026-08-25), and a second request here would be a
    // regression nothing else would catch.
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('what goes on the wire', () => {
  it('is a completion on /chat/completions, never GET /v1/models', async () => {
    // THE MEASURED REASON THIS IS NOT A READINESS PROBE (2026-08-26): the models
    // endpoint answered a full vLLM payload in 1.2s while a 21-token completion
    // on the same deployment took 146s, because the container was still cold. A
    // 200 there means "the deployment exists and the key is accepted", never
    // "the next call will be quick". Only a request that makes the model produce
    // a token proves the weights are loaded.
    await ensureVerdaAwake()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/chat/completions`)
    expect(init.method).toBe('POST')
    expect(url).not.toContain('/models')
  })

  it('asks for exactly one token at temperature 0', async () => {
    // The cheapest thing that still forces a generation. `max_tokens: 1` rather
    // than 0 because a request rejected before generation proves nothing about
    // readiness, and temperature 0 because nothing reads the answer.
    await ensureVerdaAwake()
    const body = sentBody()
    expect(body.max_tokens).toBe(1)
    expect(body.temperature).toBe(0)
    expect(body.messages).toEqual([{ role: 'user', content: VERDA_WAKE_PROMPT }])
  })

  it('names the model the deployment serves, and carries the key', async () => {
    await ensureVerdaAwake()
    expect(sentBody().model).toBe(VERDA_MODEL_ID)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('carries no conversation, no user and no prompt content (SD-10)', async () => {
    // Every attempt is the same fixed literal. The wake runs on every first turn
    // of every session, so anything derived from the turn would be a per-turn
    // leak into a request nobody audits. Pinned as an exact body rather than by
    // size, because "small" is not the property — "nothing from the turn" is, and
    // an exact comparison is what fails if a future edit threads the user's
    // message through here for a warmer cache.
    await ensureVerdaAwake()
    expect(sentBody()).toEqual({
      model: VERDA_MODEL_ID,
      messages: [{ role: 'user', content: VERDA_WAKE_PROMPT }],
      max_tokens: 1,
      temperature: 0,
    })
  })

  it('sends the SAME body on a retry — a later attempt is not a different request', async () => {
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementationOnce(stalls())
    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS)
    await wake
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentBody(1)).toEqual(sentBody(0))
  })

  it('joins the /v1 base to the path without doubling the slash', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = `${ENDPOINT}/`
    await ensureVerdaAwake()
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/chat/completions`)
  })

  it('bounds every attempt with an abort signal — node fetch has no default timeout', async () => {
    // An unbounded attempt would hang the turn FOREVER, which is strictly worse
    // than the 600s BAML timeout it replaced. It is also what makes the poll a
    // poll: with no per-attempt bound there is nothing to retry FROM.
    // `smoke-verda.ts`'s preflight learned the first half the hard way — an
    // unbounded probe hung a diagnostic for four minutes and then reported the
    // bare string `fetch failed`.
    await ensureVerdaAwake()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('pins the model id against the .baml declaration', async () => {
    // `VERDA_MODEL_ID` is a COPY of the `model` line on `VerdaQwen` — the ping is
    // a hand-rolled fetch, so it has to name a model and BAML exports nothing to
    // read it from. vLLM 400s an unknown id, so drift would break the FIRST call
    // of every session and nothing else. This is the pin that makes the copy
    // safe.
    const declared = readFileSync(path.resolve(process.cwd(), 'baml_src/verda-client.baml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(declared).toContain(`model "${VERDA_MODEL_ID}"`)
  })
})

describe('the three budgets', () => {
  it('ships an overall budget above the longest cold start ever measured', () => {
    // ~360s, 2026-08-27, which is what took this number from 300s to 600s: the
    // old bound expired while the box was still coming up and the turn died for
    // a wait that was going to end.
    expect(DEFAULT_VERDA_WAKE_TIMEOUT_MS).toBe(600_000)
    expect(DEFAULT_VERDA_WAKE_TIMEOUT_MS).toBeGreaterThan(360_000)
  })

  it('ships a per-attempt bound that a WARM call clears and a cold start does not', () => {
    // The two properties that make an attempt an attempt. Above the warm p95
    // (9.9s at 8-way, 2026-08-25) with room, so a warm box answers first time and
    // never retries; far below a cold start, so an abandoned request is abandoned
    // early rather than riding out the whole wait.
    expect(DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS).toBe(30_000)
    expect(DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(10_000)
    expect(DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS).toBeLessThan(72_000)
  })

  it('leaves room for many attempts inside the overall budget', () => {
    // A poll whose cycle does not divide the budget several times over is a
    // single request wearing a loop.
    const cycle = DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS + DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS
    expect(Math.floor(DEFAULT_VERDA_WAKE_TIMEOUT_MS / cycle)).toBeGreaterThanOrEqual(10)
  })

  it('takes env overrides, so a different deployment needs no rebuild', () => {
    process.env.VERDA_WAKE_TIMEOUT_MS = '900000'
    process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = '45000'
    process.env.VERDA_WAKE_POLL_INTERVAL_MS = '2500'
    expect(verdaWakeTimeoutMs()).toBe(900_000)
    expect(verdaWakeAttemptTimeoutMs()).toBe(45_000)
    expect(verdaWakePollIntervalMs()).toBe(2_500)
  })

  it('refuses a zero or garbage override rather than honouring it', () => {
    // `VERDA_WAKE_ATTEMPT_TIMEOUT_MS=0` would abort every attempt before it left
    // the process — a wake that fails instantly, silently, in a loop. Falling
    // back with a warning is the only safe reading of a value that cannot mean
    // what it says.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = '0'
    process.env.VERDA_WAKE_POLL_INTERVAL_MS = 'soon'
    process.env.VERDA_WAKE_TIMEOUT_MS = '-1'
    expect(verdaWakeAttemptTimeoutMs()).toBe(DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS)
    expect(verdaWakePollIntervalMs()).toBe(DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS)
    expect(verdaWakeTimeoutMs()).toBe(DEFAULT_VERDA_WAKE_TIMEOUT_MS)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})

describe('the poll survives a box that drops what it is sent', () => {
  // FAKE TIMERS throughout: the thing under test is a loop whose every step is a
  // multi-second timeout, and `advanceTimersByTimeAsync` is what lets a
  // ten-attempt poll run in a millisecond while still going through every await.

  it('abandons an unanswered attempt and sends another', async () => {
    // THE 2026-08-27 FAILURE, at unit scale. The box was observed dropping every
    // request that arrived while it was starting — a probe held open for 590s got
    // nothing — so a wake that rides one request never learns that the box came
    // up at second 360. Here the first attempt is dropped and the second is the
    // one that finds the box.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementationOnce(stalls())

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchMock, 'it gave up on the first attempt early').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS)

    expect(await wake).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits the configured interval between attempts', async () => {
    // Not zero, deliberately: an attempt costs the deployment a queued request
    // that it has to work through once it is up, so a tight loop makes the box
    // slower to answer the attempt that matters.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementation(stalls())

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(
      fetchMock,
      'the first attempt has timed out but the gap has not elapsed',
    ).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(100_000)
    await wake
  })

  it('keeps trying for the WHOLE budget, then fails visibly', async () => {
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementation(stalls())

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(100_000)
    const err = (await wake) as Error

    expect(fetchMock).toHaveBeenCalledTimes(FAST_ATTEMPTS)
    expect(err.message).toContain(VERDA_WAKE_FAILED)
    // The count and the elapsed time are in the message because they are what
    // separates "the box is slow" from "the endpoint is wrong" for whoever reads
    // it — a poll that made ten attempts and got nothing is a different report
    // from one request that timed out.
    expect(err.message).toContain(`${FAST_ATTEMPTS} attempts`)
    expect(err.message).toContain('100s')
    expect(err.message).toContain('nothing was sent to any other provider')
  })

  it('never overshoots the budget: the last attempt is capped by what is left', async () => {
    // A budget below one attempt's timeout has to still mean what it says. The
    // shape this protects is an operator setting VERDA_WAKE_TIMEOUT_MS low to
    // fail fast and getting a full 30s attempt anyway.
    vi.useFakeTimers()
    process.env.VERDA_WAKE_TIMEOUT_MS = '4000'
    process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = '30000'
    process.env.VERDA_WAKE_POLL_INTERVAL_MS = '1000'
    fetchMock.mockImplementation(stalls())

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(4_000)
    const err = (await wake) as Error
    expect(err.message).toContain(VERDA_WAKE_FAILED)
    // One attempt, cut at the budget rather than at its own 30s — and the
    // message reports the 4s it was really given, not the 30s it asked for.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(err.message).toContain('1 attempt over 4s')
    expect(err.message).toContain('went unanswered for 4s')
  })

  it('records the WHOLE wait, not the winning attempt’s own duration', async () => {
    // The measurement that drop-during-startup would otherwise corrupt: under
    // that behaviour the attempt that succeeds takes milliseconds while the wait
    // was minutes, so recording the winner alone would teach the estimate that
    // cold starts are fast on exactly the platform behaviour that makes them
    // slow.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    // Four attempts dropped, the fifth answers instantly: 4 × 11s of wait.
    fetchMock
      .mockImplementationOnce(stalls())
      .mockImplementationOnce(stalls())
      .mockImplementationOnce(stalls())
      .mockImplementationOnce(stalls())

    const seen: ColdStartEstimate[] = []
    const wake = quiet(
      runWithColdStartWatch(
        (e) => seen.push(e),
        async () => {
          await ensureVerdaAwake()
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 4)
    await wake

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(coldStartEstimate()).toEqual({
      estimateMs: FAST_CYCLE_MS * 4,
      basis: 'measured',
      samples: 1,
    })
    // Sanity on the fixture itself: a reading under the floor would have been
    // dropped and this test would pass for the wrong reason.
    expect(FAST_CYCLE_MS * 4).toBeGreaterThan(COLD_START_PLAUSIBILITY_FLOOR_MS)
  })
})

describe('which failures are retried, and which end it on the spot', () => {
  it('retries a 5xx — a starting box saying "not yet"', async () => {
    // Including the deployment gateway's own `504 inference request was
    // canceled`, observed at 55s under queueing on 2026-08-26. That is a box
    // that is coming up, not a box refusing the request.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'inference request was canceled' }), { status: 504 }),
    )

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS)
    expect(await wake).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries 408 and 429, which are the server asking to be tried again', async () => {
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock
      .mockImplementationOnce(async () => new Response('slow down', { status: 429 }))
      .mockImplementationOnce(async () => new Response('too slow', { status: 408 }))

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 2)
    expect(await wake).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transport error, and says how many times it tried', async () => {
    // The decision worth naming rather than a reflex: a connection refused while
    // an ingress spins up is the behaviour class this poll exists for, so it is
    // retried — and the cost, a genuinely wrong hostname taking the whole budget
    // to say so, is paid back by putting the attempt count and the last error
    // verbatim in the message.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })

    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(100_000)
    const err = (await wake) as Error
    expect(err.message).toContain('fetch failed')
    expect(err.message).toContain('attempts')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('stops DEAD on a 400 — vLLM rejecting the request, not the box waking up', async () => {
    // A property of the request, not of the box's state: an unknown model id or a
    // malformed body is the same rejection on every attempt, so polling it out
    // would turn a one-line misconfiguration into a ten-minute spinner. The body
    // survives into the message, because that is where vLLM says what it did not
    // recognise.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: 'unknown model' }), { status: 400 }),
    )
    const err = (await quiet(ensureVerdaAwake())) as Error
    expect(err.message).toMatch(/did not wake: it answered HTTP 400/)
    expect(err.message).toContain('unknown model')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops DEAD on a 401 — a bad key is not a cold box', async () => {
    fetchMock.mockImplementation(async () => new Response('bad key', { status: 401 }))
    const err = (await quiet(ensureVerdaAwake())) as Error
    expect(err.message).toMatch(/did not wake: it answered HTTP 401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('says that nothing was sent to another provider, on either failure', async () => {
    // The reassurance is the point on a confidential-compute route: the failure
    // mode a user would fear is a silent fall-back, and the error says it did not
    // happen (SD-12).
    fetchMock.mockImplementation(async () => new Response('bad key', { status: 401 }))
    const refused = (await quiet(ensureVerdaAwake())) as Error
    expect(refused.message).toContain('nothing was sent to any other provider')

    resetVerdaWake()
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementation(stalls())
    const expired = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(100_000)
    expect(((await expired) as Error).message).toContain('nothing was sent to any other provider')
  })

  it('names the box once, not twice, however it failed', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('ECONNREFUSED')
    })
    vi.useFakeTimers()
    process.env.VERDA_WAKE_TIMEOUT_MS = '1000'
    process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = '500'
    process.env.VERDA_WAKE_POLL_INTERVAL_MS = '100'
    const wake = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(1_000)
    const err = (await wake) as Error
    const occurrences = (err.message.match(new RegExp(VERDA_WAKE_FAILED, 'g')) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('a failed poll does not stamp the clock — an error is not readiness', async () => {
    // Where this deliberately diverges from the usage observer, which stamps on
    // success or failure alike. Here the stamp is what SKIPS the next wake, so a
    // 400 for an unknown model id or the platform's own 504 would suppress the
    // next one on the strength of a box that answered an error.
    fetchMock.mockImplementation(async () => new Response('nope', { status: 400 }))
    await expect(ensureVerdaAwake()).rejects.toThrow(VERDA_WAKE_FAILED)
    expect(verdaLastCallCompletedAt()).toBeNull()
  })
})

describe('concurrent turns share one poll', () => {
  it('sends ONE request for three simultaneous turns', async () => {
    // The measured failure this prevents: three chats into a sleeping box are one
    // replica's QUEUE, not three parallel cold starts (2026-08-26), so three
    // independent polls would make the third turn wait all of them.
    let release: () => void = () => {}
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = () => resolve(ok()))),
    )

    const turns = [ensureVerdaAwake(), ensureVerdaAwake(), ensureVerdaAwake()]
    // Let the three reach their await before the request resolves.
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release()
    await Promise.all(turns)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares the whole LOOP, not just one request', async () => {
    // The dedupe has to wrap the poll rather than each attempt, or a turn that
    // arrived between two attempts would start a second poll and the burst this
    // is here to prevent would come back one retry later.
    vi.useFakeTimers()
    Object.assign(process.env, FAST_POLL)
    fetchMock.mockImplementationOnce(stalls()).mockImplementationOnce(stalls())

    const first = quiet(ensureVerdaAwake())
    // Land the second turn in the GAP between attempt 1 and attempt 2.
    await vi.advanceTimersByTimeAsync(10_500)
    const second = quiet(ensureVerdaAwake())
    await vi.advanceTimersByTimeAsync(FAST_CYCLE_MS * 2)

    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    // Three: two dropped, one answered. A second poll would have made it four.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('lets the NEXT idle period wake again, rather than caching a success', async () => {
    // The shared promise is an in-flight dedupe, not a memo. A box that went back
    // to sleep after the scale-down window has to be woken again, and the warm
    // clock — not this module — is what decides that.
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Which is why the clock has to be wound back to make the point: a
    // successful wake STAMPS it (see the next test), so within the scale-down
    // window the second turn is right to send nothing. Idle past the window and
    // the wake returns — no memory of the earlier success anywhere.
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a successful wake stamps the warm clock, so the next turn sends nothing', async () => {
    // The clock's own standard is an answered completion on the deployment
    // naming VERDA_MODEL_ID — which is exactly what an attempt is, so it counts
    // as evidence rather than needing a BAML call to confirm it. Without this, a
    // turn arriving after a wake landed but before the first usage sample paid a
    // SECOND wake and was shown a multi-minute countdown that cleared in a second
    // (#279 review, F5).
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(verdaLastCallCompletedAt()).not.toBeNull()

    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects ALL FOUR waiting turns when the shared poll fails', async () => {
    // The fan-out half of the failure, which the single-turn case does not
    // cover: three of these four never sent a request, so their rejection comes
    // from the promise they attached to. Every one of them has to be told, with
    // the user-facing sentence — a waiter that resolved instead would run the
    // harness against a box that is not there, which is the whole thing
    // wake-then-run prevents (#279 review).
    fetchMock.mockImplementation(async () => new Response('unknown model', { status: 400 }))

    const turns = [
      ensureVerdaAwake(),
      ensureVerdaAwake(),
      ensureVerdaAwake(),
      ensureVerdaAwake(),
    ].map((p) => p.catch((err: unknown) => (err instanceof Error ? err.message : String(err))))
    const outcomes = await Promise.all(turns)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outcomes).toHaveLength(4)
    for (const outcome of outcomes) expect(outcome).toContain(VERDA_WAKE_FAILED)

    // And the shared failure did not poison the next wake for any of them.
    fetchMock.mockImplementation(async () => ok())
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
  })

  it('retries after a failed poll instead of remembering the failure', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 400 }))
    await expect(ensureVerdaAwake()).rejects.toThrow(VERDA_WAKE_FAILED)
    // A remembered rejection would make one bad minute poison every later turn.
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('what the wait teaches the estimate', () => {
  /** Collect the notices a watched wake produces. */
  async function watched(body: () => Promise<void>): Promise<ColdStartEstimate[]> {
    const seen: ColdStartEstimate[] = []
    await runWithColdStartWatch((e) => seen.push(e), body)
    return seen
  }

  it('announces the wait BEFORE the first attempt goes out, not after it lands', async () => {
    // Scenario 8's whole assertion, at unit scale: a notice that arrived when the
    // box answered would be a notice about a wait that had already finished.
    // Both events go into ONE ordered list, which is what makes this an ordering
    // assertion rather than two independent "it happened" checks.
    const order: string[] = []
    fetchMock.mockImplementation(async () => {
      order.push('ping')
      return ok()
    })
    await runWithColdStartWatch(
      () => order.push('notice'),
      async () => {
        await ensureVerdaAwake()
      },
    )
    expect(order).toEqual(['notice', 'ping'])
  })

  it('records the wait when the box was provably cold', async () => {
    // FAKE TIMERS, because the thing being measured is a multi-minute wait and
    // the module measures it off `Date.now()`. The stub advances the clock while
    // the request is "in flight", which is the only way to produce a duration
    // above the 36.5s plausibility floor without actually waiting.
    vi.useFakeTimers()
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    fetchMock.mockImplementation(async () => {
      vi.advanceTimersByTime(150_000)
      return ok()
    })
    await watched(async () => {
      await ensureVerdaAwake()
    })
    expect(coldStartEstimate()).toEqual({
      estimateMs: 150_000,
      basis: 'measured',
      samples: 1,
    })
  })

  it('drops a fast wake — a warm box this process had not noticed', async () => {
    // A wake fires on `unknown` too, so a freshly restarted process behind a
    // genuinely warm box measures a handful of milliseconds. The plausibility
    // floor is the only thing between that and a "measured" 4-second cold start
    // being promised to every future user, and the wake is the path that makes it
    // load-bearing rather than theoretical.
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    await watched(async () => {
      await ensureVerdaAwake()
    })
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('records ONE reading for three turns that shared one poll', async () => {
    // A turn that arrived 100s into a 360s wake waited 260s, which is a FRAGMENT
    // of one cold start and not a measurement of anything. Recording it would
    // drag the median towards however late each user happened to arrive, and it
    // CLEARS the plausibility floor — so the floor would not save this one and
    // the "only the turn that started the poll records" rule has to.
    //
    // Three turns, one poll, one reading, and the reading is the poll's own
    // duration rather than any turn's share of it.
    vi.useFakeTimers()
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    let release: () => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            vi.advanceTimersByTime(150_000)
            resolve(ok())
          }
        }),
    )

    const attach = (): Promise<void> =>
      runWithColdStartWatch(
        () => {},
        async () => {
          await ensureVerdaAwake()
        },
      )
    const turns = [attach(), attach(), attach()]
    // Let all three reach their await on the shared promise.
    await Promise.resolve()
    release()
    await Promise.all(turns)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(coldStartEstimate()).toEqual({
      estimateMs: 150_000,
      basis: 'measured',
      samples: 1,
    })
  })

  it('records nothing when the poll failed — the budget is not a cold start', async () => {
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    fetchMock.mockImplementation(async () => new Response('down', { status: 400 }))
    await watched(async () => {
      await ensureVerdaAwake().catch(() => {})
    }).catch(() => [])
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('waits, and announces nothing, with no watch armed', async () => {
    // A triggered run or a script has no listener. The wake is not a UI feature:
    // it still runs, silently.
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

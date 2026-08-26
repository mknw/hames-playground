/**
 * Wake-then-run — the ping that pays the cold start before the harness starts.
 *
 * `cold-start.test.ts` pins the NOTICE (when it fires, what it may record).
 * This file pins the REQUEST and the control flow around it, which is where the
 * failures that matter live:
 *
 *   - the ping only happens when the box might be asleep. A ping per turn to a
 *     warm deployment is a request nobody needs and a second of latency on every
 *     message.
 *   - it is a COMPLETION, not `GET /v1/models`. Measured 2026-08-26, that
 *     endpoint answered in 1.2s while a real call on the same deployment took
 *     146s, so a readiness probe built on it reports ready and hands the user the
 *     whole wait anyway.
 *   - concurrent turns share ONE ping. The deployment is a single replica where
 *     concurrency is queueing, so three turns that each sent their own would
 *     queue three cold starts and the third user would wait all three.
 *   - a failure is LOUD and the turn does not run. The two silent alternatives
 *     are both worse than a red turn: proceeding moves the same wait into a call
 *     whose timeout is now sized for a warm box, and falling back sends
 *     confidential prompts to the provider the tier exists to avoid.
 *   - the measurement is attributed to the turn that actually waited the whole
 *     wait, and to no other.
 *
 * A real `fetch` is stubbed rather than a server started: what is being pinned is
 * the request this module builds and the decisions around it, and a loopback
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
  VERDA_WAKE_TIMEOUT_MS,
  VERDA_WAKE_PROMPT,
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

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetVerdaWake()
  resetVerdaActivity()
  resetColdStartHistory()
  process.env.VERDA_INFERENCE_ENDPOINT = ENDPOINT
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetVerdaWake()
  resetVerdaActivity()
  resetColdStartHistory()
  delete process.env.VERDA_INFERENCE_ENDPOINT
  delete process.env.VERDA_INFERENCE_API_KEY
})

/** The body of the nth request the module sent. */
function sentBody(n = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[n][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('when the ping is sent at all', () => {
  it('pings when this process has never seen the box', async () => {
    // `unknown`, not `cold`: the box may well be warm and this process simply
    // restarted. It pings anyway, which costs one 1-token request and is the
    // cheap side of the error — the other side is a user sitting through 146
    // silent seconds.
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
    // The ping is a fixed literal. It runs on every first turn of every session,
    // so anything derived from the turn would be a per-turn leak into a request
    // nobody audits. Pinned as an exact body rather than by size, because "small"
    // is not the property — "nothing from the turn" is, and an exact comparison
    // is what fails if a future edit threads the user's message through here for
    // a warmer cache.
    await ensureVerdaAwake()
    expect(sentBody()).toEqual({
      model: VERDA_MODEL_ID,
      messages: [{ role: 'user', content: VERDA_WAKE_PROMPT }],
      max_tokens: 1,
      temperature: 0,
    })
  })

  it('joins the /v1 base to the path without doubling the slash', async () => {
    process.env.VERDA_INFERENCE_ENDPOINT = `${ENDPOINT}/`
    await ensureVerdaAwake()
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/chat/completions`)
  })

  it('bounds itself with an abort signal — node fetch has no default timeout', async () => {
    // An unbounded wake would hang the turn FOREVER, which is strictly worse
    // than the 600s BAML timeout it replaced. `smoke-verda.ts`'s preflight
    // learned this the hard way: an unbounded probe hung a diagnostic for four
    // minutes and then reported the bare string `fetch failed`.
    await ensureVerdaAwake()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Above the measured 146s cold start, or it would abort a healthy wake.
    expect(VERDA_WAKE_TIMEOUT_MS).toBeGreaterThan(146_000)
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

describe('concurrent turns share one ping', () => {
  it('sends ONE request for three simultaneous turns', async () => {
    // The measured failure this prevents: three chats into a sleeping box are one
    // replica's QUEUE, not three parallel cold starts (2026-08-26), so three
    // independent pings would make the third turn wait three cold starts.
    let release: () => void = () => {}
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = () => resolve(ok()))),
    )

    const turns = [ensureVerdaAwake(), ensureVerdaAwake(), ensureVerdaAwake()]
    // Let the three reach their await before the ping resolves.
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release()
    await Promise.all(turns)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets the NEXT idle period ping again, rather than caching a success', async () => {
    // The shared promise is an in-flight dedupe, not a memo. A box that went back
    // to sleep after the scale-down window has to be woken again, and the warm
    // clock — not this module — is what decides that.
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Which is why the clock has to be wound back to make the point: a
    // successful ping STAMPS it (see the next test), so within the scale-down
    // window the second turn is right to send nothing. Idle past the window and
    // the ping returns — no memory of the earlier success anywhere.
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a successful ping stamps the warm clock, so the next turn sends nothing', async () => {
    // The clock's own standard is an answered completion on the deployment
    // naming VERDA_MODEL_ID — which is exactly what the ping is, so it counts as
    // evidence rather than needing a BAML call to confirm it. Without this, a
    // turn arriving after a ping landed but before the first usage sample paid a
    // SECOND ping and was shown a ~146s countdown that cleared in a second
    // (#279 review, F5).
    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(verdaLastCallCompletedAt()).not.toBeNull()

    await ensureVerdaAwake()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a ping that ERRORS does not stamp the clock — an error is not readiness', async () => {
    // Where this deliberately diverges from the usage observer, which stamps on
    // success or failure alike. Here the stamp is what SKIPS the next ping, so a
    // 400 for an unknown model id or the platform's own 504 would suppress the
    // next wake on the strength of a box that answered an error.
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }))
    await expect(ensureVerdaAwake()).rejects.toThrow(VERDA_WAKE_FAILED)
    expect(verdaLastCallCompletedAt()).toBeNull()
  })

  it('rejects ALL FOUR waiting turns when the shared ping fails', async () => {
    // The fan-out half of the failure, which the single-turn case does not
    // cover: three of these four never sent a request, so their rejection comes
    // from the promise they attached to. Every one of them has to be told, with
    // the user-facing sentence — a waiter that resolved instead would run the
    // harness against a box that is not there, which is the whole thing
    // wake-then-run prevents (#279 review).
    let fail: () => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail = () => reject(new Error('ECONNREFUSED'))
        }),
    )

    const turns = [
      ensureVerdaAwake(),
      ensureVerdaAwake(),
      ensureVerdaAwake(),
      ensureVerdaAwake(),
    ].map((p) => p.catch((err: unknown) => (err instanceof Error ? err.message : String(err))))
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fail()
    const outcomes = await Promise.all(turns)
    expect(outcomes).toHaveLength(4)
    for (const outcome of outcomes) expect(outcome).toContain(VERDA_WAKE_FAILED)

    // And the shared failure did not poison the next wake for any of them.
    fetchMock.mockImplementation(async () => ok())
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
  })

  it('retries after a failed ping instead of remembering the failure', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }))
    await expect(ensureVerdaAwake()).rejects.toThrow(VERDA_WAKE_FAILED)
    // A remembered rejection would make one bad minute poison every later turn.
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('a box that does not wake is a visible failure', () => {
  it('rejects with the user-facing sentence when the endpoint errors', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'inference request was canceled' }), { status: 504 }),
    )
    // The 504 the deployment's own gateway was observed to send at 55s. It has to
    // survive into the message: "the box refused" and "the box never answered"
    // are different operational problems.
    await expect(ensureVerdaAwake()).rejects.toThrow(/did not wake: it answered HTTP 504/)
    await expect(ensureVerdaAwake()).rejects.toThrow(/inference request was canceled/)
  })

  it('names the timeout rather than reporting `fetch failed`', async () => {
    fetchMock.mockImplementation(async () => {
      const err = new Error('This operation was aborted')
      err.name = 'AbortError'
      throw err
    })
    await expect(ensureVerdaAwake()).rejects.toThrow(/no answer within 300s/)
  })

  it('says that nothing was sent to another provider', async () => {
    // The reassurance is the point on a confidential-compute route: the failure
    // mode a user would fear is a silent fall-back, and the error says it did not
    // happen.
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(ensureVerdaAwake()).rejects.toThrow(/nothing was sent to any other provider/)
  })

  it('wraps a transport error once, not twice', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('ECONNREFUSED')
    })
    const err = await ensureVerdaAwake().then(
      () => new Error('the wake resolved; it was supposed to reject'),
      (e: unknown) => e as Error,
    )
    const occurrences = (err.message.match(new RegExp(VERDA_WAKE_FAILED, 'g')) ?? []).length
    expect(occurrences).toBe(1)
  })
})

describe('what the wait teaches the estimate', () => {
  /** Collect the notices a watched wake produces. */
  async function watched(body: () => Promise<void>): Promise<ColdStartEstimate[]> {
    const seen: ColdStartEstimate[] = []
    await runWithColdStartWatch((e) => seen.push(e), body)
    return seen
  }

  it('announces the wait BEFORE the ping goes out, not after it lands', async () => {
    // Scenario 8's whole assertion, at unit scale: a notice that arrived when the
    // ping resolved would be a notice about a wait that had already finished.
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

  it('records the ping’s duration when the box was provably cold', async () => {
    // FAKE TIMERS, because the thing being measured is a two-minute wait and the
    // module measures it off `Date.now()`. The stub advances the clock while the
    // request is "in flight", which is the only way to produce a duration above
    // the 36.5s plausibility floor without actually waiting.
    vi.useFakeTimers()
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a fast ping — a warm box this process had not noticed', async () => {
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

  it('records ONE reading for three turns that shared one ping', async () => {
    // A turn that arrived 100s into a 146s wake waited 46s, which is a FRAGMENT
    // of one cold start and not a measurement of anything. Recording it would
    // drag the median towards however late each user happened to arrive, and 46s
    // CLEARS the plausibility floor — so the floor would not save this one and
    // the "only the turn that started the ping records" rule has to.
    //
    // Three turns, one ping, one reading, and the reading is the ping's own
    // duration rather than any turn's share of it.
    vi.useFakeTimers()
    try {
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
    } finally {
      vi.useRealTimers()
    }
  })

  it('records nothing when the ping failed — the timeout is not a cold start', async () => {
    noteVerdaCallCompleted(Date.now() - 10 * 60 * 1000)
    fetchMock.mockImplementation(async () => new Response('down', { status: 502 }))
    await watched(async () => {
      await ensureVerdaAwake().catch(() => {})
    }).catch(() => [])
    expect(coldStartEstimate().basis).toBe('default')
  })

  it('waits, and announces nothing, with no watch armed', async () => {
    // A triggered run or a script has no listener. The ping is not a UI feature:
    // it still runs, silently.
    await expect(ensureVerdaAwake()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

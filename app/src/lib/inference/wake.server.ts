/**
 * Wake-then-run — Server Only
 *
 * The self-hosted deployment scales to zero, and #273's decision D-b was what to
 * do about the first call of a session paying the container start plus a 27B
 * weight load. This module is the answer the owner chose. Before a private-tier
 * turn starts its real work, throwaway requests wake the box; the harness calls
 * begin only once one of them answers.
 *
 * ## Why a wake ping and not a longer timeout
 *
 * The alternative — the shipped one until #279 — was to let the first real call
 * absorb the cold start behind a `request_timeout_ms` generous enough to survive
 * it. That worked and cost three things, all of which this removes:
 *
 *  1. **Every warm call inherited the cold-start budget.** A ten-minute timeout
 *     on a route whose warm p95 at 8-way concurrency is 9.9s means a genuinely
 *     hung request is indistinguishable from a working one for ten minutes. With
 *     the wait moved out in front, the BAML client's timeout can be sized for a
 *     warm call (`baml_src/verda-client.baml`, and the number's justification is
 *     there rather than here).
 *  2. **A burst multiplied its own wait.** Three chats into a sleeping box are
 *     one replica's queue, not three parallel cold starts (measured 2026-08-26),
 *     so the third user waited three cold starts. {@link ensureVerdaAwake}
 *     dedupes: concurrent turns share one in-flight wake and all resume when it
 *     lands.
 *  3. **The wait was attributed to a call that was mostly not waiting.** The
 *     cold start is now measured by the request that actually pays it.
 *
 * ## Why it POLLS, which is the 2026-08-27 change
 *
 * It used to be ONE request on a 300s bound. That shape assumes the platform
 * QUEUES a request that arrives while the container is starting and answers it
 * when the weights are loaded — which is what 2026-08-26 measured twice (146s
 * and 71.7s were both exactly such requests). On 2026-08-27 the platform did the
 * other thing, and did it to every request in the startup window:
 *
 *   - the box took **~360s** from first request to available, past the 300s
 *     bound the single ping was given;
 *   - **no request sent during that startup ever completed**, not even after the
 *     box became available. Confirmed independently of the app: a 1-token
 *     `/chat/completions` probe held open for 590s returned nothing, while the
 *     same request answered in seconds once the box was warm.
 *
 * Both behaviours are real observations of the same deployment and neither is a
 * contract, so the wake assumes NEITHER. A poll survives both without having to
 * tell them apart: under queue-and-answer an early attempt eventually lands and
 * the poll simply ends on it; under drop-during-startup every early attempt is
 * abandoned by the platform and a LATER one meets a warm box and answers in
 * seconds. What each attempt buys either way is the same — arriving at the
 * deployment is what triggers the scale-up, so a dropped attempt is not a wasted
 * one.
 *
 * The per-attempt timeout is therefore not a guess about how long a cold start
 * takes; it is how long the poll is willing to bet on the queue-and-answer
 * reading before spending 1 more token on a fresh attempt. See
 * {@link DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS}.
 *
 * ## What an attempt is, precisely
 *
 * `POST /chat/completions` with one user message, `max_tokens: 1`,
 * `temperature: 0`. The cheapest thing that forces the deployment to load the
 * model and produce a token.
 *
 * **NOT `GET /v1/models`**, which is the obvious choice and is wrong in BOTH
 * directions — two live readings, pointing opposite ways, agreeing on the
 * conclusion:
 *
 *   - 2026-08-26 (#273): it answered a full vLLM payload in **1.2s** while a
 *     21-token completion on the same deployment took **146s**. A 200 there means
 *     "the deployment exists and the key is accepted", never "the next call will
 *     be quick", so a probe built on it reports ready and hands the user the whole
 *     wait anyway.
 *   - 2026-08-26, later, verifying this module against a cold box: it **hung** —
 *     no response at 60s, TCP connected in 64ms — while the wake ping on the same
 *     deployment answered in **71.7s**. So a failure there does not mean the
 *     deployment is unreachable either.
 *
 * One endpoint that can be fast on a cold box and hung on a wakeable one is not a
 * readiness signal in either direction. The only probe that proves the model is
 * loaded is one that makes the model produce something, which is why this module
 * treats a `/models` result as diagnostics and never as a decision.
 *
 * ## Which failures are retried, and which end it on the spot
 *
 * Fail-open on the wait, fail-closed on the request. A **4xx other than 408 /
 * 429** ends the poll immediately: a 401 for a bad key and vLLM's 400 for an
 * unknown model id are properties of the request, not of the box's state, so
 * every later attempt would be the same rejection and polling one out for ten
 * minutes turns a one-line misconfiguration into a ten-minute spinner. Anything
 * else — a per-attempt timeout, a 5xx, the deployment gateway's own
 * `504 {"error":"inference request was canceled"}`, and a transport error — is
 * retried, because all four are things a box that is coming up does.
 *
 * The transport case is the one worth naming as a decision rather than a
 * reflex, because it cuts both ways: retrying means a genuinely wrong hostname
 * costs the whole budget before saying so. It is retried anyway. A connection
 * refused while an ingress spins up is the exact behaviour class this poll
 * exists for, an unreachable host fails every turn and an operator sees it once,
 * and the budget-expiry message carries the attempt count and the last error
 * verbatim so the misconfiguration is still diagnosable — late, but named.
 *
 * ## What happens when nothing answers
 *
 * The turn FAILS, visibly, with a message naming the box. It does not fall
 * through to the harness and it does not fall back to Anthropic. Both
 * alternatives are worse than a red turn: running the harness anyway just moves
 * the same wait one layer down into a call whose timeout is now sized for a warm
 * box, and falling back sends confidential-compute prompts to the provider the
 * tier exists to avoid (SD-12). A thrown error reaches the SSE route's `catch`,
 * which emits an `error` frame, and the server-action path rejects — so in both
 * cases the user is told, which is the property #273 asked for ("never a silent
 * hang").
 *
 * ## What it holds, and where
 *
 * One promise, on a `globalThis` symbol — process-local, the same compromise
 * (and the same eventual Redis move) as the warm clock and the cold-start
 * history. The consequence is honest and mild: two app instances would each run
 * their own poll against the same sleeping box, and the box queues or drops
 * them, so the cost of the multi-instance gap is a few wasted 1-token requests
 * rather than a wrong answer.
 *
 * No prompt, no user id, no conversation id — every attempt's content is the
 * same fixed literal (SD-10).
 *
 * ## Two things it deliberately does and does not account for
 *
 * **It stamps the warm clock** on the attempt that answers. The clock's standard
 * is an answered completion on the deployment naming `VERDA_MODEL_ID`, and that
 * is exactly what this is — so without the stamp a turn arriving just after a
 * poll landed, but before the first BAML sample, paid a second poll and was shown
 * a multi-minute countdown that cleared in about a second.  Stamped from here
 * rather than by faking an `LlmUsageSample`: this is not a BAML call and must not
 * enter the token counters or the latency window as one.
 *
 * **Its GPU seconds are NOT priced, and that is a decision rather than an
 * oversight.** The attempts are hand-rolled `fetch`es, so they emit no usage
 * sample and a multi-minute cold start (a 360s one is ≈€0.18 at
 * `VERDA_EUR_PER_HOUR`) is outside the time-priced figure — where before this
 * module existed it sat inside the first call's `timing.durationMs`. Three
 * reasons it stays outside:
 *
 *  1. **A shared wake belongs to no one turn.** Concurrent turns attach to the
 *     same poll, so charging its euros to a step would charge one user for a
 *     wait several of them shared, and charging all of them would multiply one
 *     bill by the size of the burst.
 *  2. **There is no step to hang it on.** Cost is rendered per LLM step from the
 *     conversation blob; a wake fires before the harness starts and produces no
 *     step. Inventing one would put a call in the observability panel that no
 *     pattern made.
 *  3. **The figure already says it excludes this.** Every time-priced number is
 *     labelled a FLOOR (`≥`, "compute time") whose caveat names the cold start
 *     and the scale-down window as the two things it does not include. This
 *     makes that label true rather than breaking it.
 *
 * What is genuinely lost is that on a low-traffic preview the cold start is the
 * single largest GPU-time item, and `settleColdStart` has the number in hand.
 * Surfacing it belongs where an operator reads GPU time — a deployment-level
 * figure, not a per-conversation one — and that is not this module's call to
 * make.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { verdaProvenWarm, settleColdStart, noteVerdaCallStarting } from './cold-start.server'
import { VERDA_MODEL_ID, noteVerdaCallCompleted } from './verda-activity.server'

assertServerOnImport()

/**
 * How long the whole poll is given, across every attempt.
 *
 * **600s**, raised from 300s on 2026-08-27 by a live reading that overran the
 * old bound: the box took **~360s** from first request to available, against
 * earlier cold starts of 146s and 71.7s (2026-08-26). 600s is the measured tail
 * plus a margin of the same order — two of the three readings fit inside the
 * first minute and the third took six, which is a spread wide enough that the
 * next one being worse than 360s is not surprising.
 *
 * A ceiling rather than an expectation, and this is the number that decides how
 * long a user stares at a spinner before being told the box did not wake. Sized
 * generously on purpose: the poll is the one thing in the system whose whole job
 * is to wait, so it is the right place for the slack, and it is the reason every
 * other timeout on this route can be tight. What it must NOT do is drift up
 * without a reading behind it — the estimate the UI counts down
 * (`COLD_START_FALLBACK_MS`) is a separate claim, and a budget far above it just
 * lengthens the worst case for a deployment that is genuinely broken.
 *
 * Overridable per host with `VERDA_WAKE_TIMEOUT_MS`, because the one thing this
 * number describes is a platform's behaviour and a different deployment size
 * (or a different GPU) is a different number.
 */
export const DEFAULT_VERDA_WAKE_TIMEOUT_MS = 600_000

/**
 * How long ONE attempt is given before it is abandoned and a fresh one sent.
 *
 * 30s, and it is not an estimate of anything — a cold start is an order of
 * magnitude longer than this and the poll is expected to spend most of its
 * attempts timing out. It is the price of the bet described in the module
 * docstring: under queue-and-answer, holding an attempt open is how the wait
 * ends, and under drop-during-startup holding it open is how the wait is missed.
 * 30s is short enough that a box which came up at second 40 of a 360s start is
 * met by an attempt within seconds of being ready, and long enough that a WARM
 * box (single-call 4.1s, 9.9s p95 at 8-way, 2026-08-25) answers inside the first
 * attempt with room to spare — which is the case that must never retry, because
 * the first attempt against a warm box is what makes the whole wake cheap.
 *
 * Capped by whatever is left of the overall budget, so the last attempt cannot
 * overshoot it.
 */
export const DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS = 30_000

/**
 * How long the poll waits between a failed attempt and the next one.
 *
 * A few seconds, for one reason: an attempt costs the deployment a queued
 * request and costs us a token, so hammering a starting container adds queue
 * depth that the box has to work through once it is up. It also must not be long
 * — the gap is dead time in which a box that just became ready is not being
 * asked anything, and that dead time lands directly on the user's wait. 5s
 * against a 30s attempt means the poll's granularity on "when did the box come
 * up" is ~35s, which is small against the 360s it is measuring.
 */
export const DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS = 5_000

/**
 * A positive-millisecond env override, or the default.
 *
 * Read per call rather than at module load, the same rule the rest of this route
 * follows: a script that sets the var before importing a pattern has to be seen.
 * A zero, a negative or a garbage value is REFUSED with a warning rather than
 * honoured — `VERDA_WAKE_ATTEMPT_TIMEOUT_MS=0` would abort every attempt before
 * it left the process and turn the wake into a silent, instant failure loop,
 * which is the one outcome worse than a wrong number.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[verda] ${name}=${JSON.stringify(raw)} is not a positive number of ms; ` +
        `falling back to ${fallback}.`,
    )
    return fallback
  }
  return Math.floor(parsed)
}

/** `VERDA_WAKE_TIMEOUT_MS`, or {@link DEFAULT_VERDA_WAKE_TIMEOUT_MS}. */
export function verdaWakeTimeoutMs(): number {
  return envMs('VERDA_WAKE_TIMEOUT_MS', DEFAULT_VERDA_WAKE_TIMEOUT_MS)
}

/** `VERDA_WAKE_ATTEMPT_TIMEOUT_MS`, or
 *  {@link DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS}. */
export function verdaWakeAttemptTimeoutMs(): number {
  return envMs('VERDA_WAKE_ATTEMPT_TIMEOUT_MS', DEFAULT_VERDA_WAKE_ATTEMPT_TIMEOUT_MS)
}

/** `VERDA_WAKE_POLL_INTERVAL_MS`, or
 *  {@link DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS}. */
export function verdaWakePollIntervalMs(): number {
  return envMs('VERDA_WAKE_POLL_INTERVAL_MS', DEFAULT_VERDA_WAKE_POLL_INTERVAL_MS)
}

/**
 * The ping's message text.
 *
 * A literal, exported, and the export is not cosmetic: the hermetic e2e fake
 * hard-fails on a prompt it cannot classify as a BAML function (by design — a
 * canned reply for the wrong output type surfaces three layers away as a
 * validation error and reads like an app bug), so the fake has to recognise this
 * one. Importing the constant is what stops the two drifting.
 */
export const VERDA_WAKE_PROMPT = 'wake'

/** Message the user sees when the box never answered. Exported so a test can
 *  assert the visible string rather than a substring it chose itself. */
export const VERDA_WAKE_FAILED = 'the private inference box did not wake'

/** The sentence every wake failure ends with. The reassurance is the point on a
 *  confidential-compute route: the failure a user would fear is a silent
 *  fall-back, and the message says it did not happen (SD-12). */
const NO_FALLBACK = 'The turn was not started; nothing was sent to any other provider.'

const WAKE_KEY = Symbol.for('kg-agent.verda-wake')
interface WakeState {
  /** The poll currently running — resolving with how long the whole wait took —
   *  shared by every turn that arrived while it was in flight. Cleared when it
   *  settles, so the NEXT idle period gets its own poll rather than a cached
   *  success, and a FAILED poll is retried by the next turn rather than
   *  remembered. */
  inFlight: Promise<number> | null
}
type WakeGlobal = typeof globalThis & { [WAKE_KEY]?: WakeState }
const state: WakeState = ((globalThis as WakeGlobal)[WAKE_KEY] ??= { inFlight: null })

/**
 * Make sure the self-hosted box is up before the caller starts making real
 * calls to it. Resolves immediately when nothing suggests it is asleep.
 *
 * Call it inside the turn's `runWithColdStartWatch` scope: the announcement goes
 * through {@link noteVerdaCallStarting}, the same seam a BAML call uses, so the
 * `warming` frame and its estimate are unchanged and the wait is announced
 * BEFORE the first attempt rather than after it. Without a watch it is silent
 * and still waits — the wake is not a UI feature.
 *
 * @throws when the box did not answer inside {@link verdaWakeTimeoutMs}, or
 * rejected the request outright. The message begins with
 * {@link VERDA_WAKE_FAILED}.
 */
export async function ensureVerdaAwake(now: number = Date.now()): Promise<void> {
  // Proof the box is up is the ONLY thing that skips the wake, and it is the
  // same predicate the notice uses — see `verdaProvenWarm`. `unknown` (this
  // process has never seen a call) does NOT skip: a fresh process behind a warm
  // box pays one wasted 1-token request, where the other error costs a user the
  // whole silent wait.
  if (verdaProvenWarm(now)) return

  // Announce first, poll second. A notice that arrived after the box answered
  // would be a notice about a wait that had already finished — scenario 8's
  // whole assertion is that this lands INSIDE the wait.
  noteVerdaCallStarting(now)

  // One poll, shared — the dedupe wraps the WHOLE loop, not one request, which
  // is what stops a burst turning into several independent polls hammering one
  // replica. `??=` rather than a check-then-set: this is synchronous code
  // between two awaits, so there is no interleaving point, and every turn that
  // arrives while a poll is running attaches to it.
  //
  // WHOSE MEASUREMENT IT IS matters, and this is the only reason the flag exists.
  // The poll's total duration is the cold start; a turn that arrived 100s into it
  // waited 260s, which is a fragment of one wait and not a measurement of
  // anything. Only the turn that STARTED the poll records; the others mark their
  // watch settled with no reading, which is what stops their first (warm, fast)
  // BAML call being recorded as a cold start further downstream.
  const mine = state.inFlight === null
  state.inFlight ??= poll().finally(() => {
    state.inFlight = null
  })
  const durationMs = await state.inFlight

  // Settled in the CALLING turn's async context, deliberately: the watch is
  // per-turn AsyncLocalStorage, and settling inside the shared promise would
  // settle whichever turn happened to create it and leave the others unsettled.
  settleColdStart(mine ? durationMs : undefined)
}

/** Test-only: drop any shared poll so the next call starts a fresh one. */
export function resetVerdaWake(): void {
  state.inFlight = null
}

/** A failure that ends the poll on the spot rather than being retried — see
 *  "Which failures are retried" in the module docstring. Its message is already
 *  the user-facing one. */
class WakeRefused extends Error {}

/**
 * Poll the box until one attempt answers. Resolves with the TOTAL wait, from the
 * first attempt's start; throws when the budget runs out or the deployment
 * refuses the request outright.
 *
 * The duration reaches the history through `settleColdStart`, the SAME funnel a
 * BAML call used before this module existed, so every gate #274 built still
 * applies unchanged: the watch's coldness evidence (this process saw a call
 * finish and the configured scale-down has elapsed) AND the plausibility floor
 * on the reading itself. The floor earns its keep here in a way it did not
 * before — a wake fires on `unknown` too, so a freshly restarted process behind
 * a genuinely warm box measures ~4s on its first attempt, and the floor is the
 * only thing standing between that and a "measured" 4-second cold start.
 *
 * It is the total and not the last attempt's own duration, because the total is
 * what the user waited and what the countdown has to predict. Under
 * drop-during-startup the winning attempt takes seconds while the wait was
 * minutes; recording the winner alone would teach the estimate that cold starts
 * are fast, on exactly the platform behaviour that makes them slow.
 *
 * A FAILED poll records nothing, because there is no duration to record: the box
 * did not come up, so the number would be the budget rather than a cold start.
 */
async function poll(): Promise<number> {
  const budgetMs = verdaWakeTimeoutMs()
  const attemptMs = verdaWakeAttemptTimeoutMs()
  const intervalMs = verdaWakePollIntervalMs()

  const started = Date.now()
  const remaining = (): number => budgetMs - (Date.now() - started)
  let attempts = 0
  // Overwritten by the first attempt, always: `envMs` refuses a non-positive
  // budget, so the loop below runs at least once and this initializer cannot
  // reach the message. It is here because TypeScript needs one, not as a case.
  let lastReason = 'it was never asked'

  while (remaining() > 0) {
    attempts += 1
    // Capped by what is left, so the final attempt cannot overshoot the budget
    // the user was promised — and so a `VERDA_WAKE_TIMEOUT_MS` set BELOW the
    // per-attempt timeout still means what it says rather than being silently
    // rounded up to one full attempt.
    const failure = await attempt(Math.min(attemptMs, remaining()))
    if (failure === null) {
      // THE BOX IS UP, and this is the evidence the warm clock asks for: a
      // completion the deployment answered, on `VERDA_MODEL_ID`. Stamped only on
      // the SUCCESS path, which is where this diverges from the usage observer's
      // rule ("success or failure — a failed call woke the box exactly as much").
      // That rule is safe for a sample: a BAML call that failed still got far
      // enough to be attributed. Here it would be self-defeating — the clock is
      // what makes `verdaProvenWarm()` skip the wake, so stamping it on a 400 for
      // an unknown model id, or on the platform's own 504, would suppress the
      // next wake on the strength of a box that answered an error.
      noteVerdaCallCompleted()
      return Date.now() - started
    }
    lastReason = failure
    // Do not sleep out the tail of the budget: a gap that ends after the budget
    // does is time the user waits for nothing.
    if (remaining() <= 0) break
    await sleep(Math.min(intervalMs, remaining()))
  }

  const waitedS = Math.round((Date.now() - started) / 1000)
  throw new Error(
    `${VERDA_WAKE_FAILED}: ${attempts} attempt${attempts === 1 ? '' : 's'} over ${waitedS}s, ` +
      `and the last one ${lastReason}. The deployment scales to zero and its first call is ` +
      'slow — the longest start measured on it is about 6 minutes (2026-08-27) — but this is ' +
      `past the ${Math.round(budgetMs / 1000)}s this wake is given. ${NO_FALLBACK}`,
  )
}

/**
 * One wake attempt, bounded by `timeoutMs`.
 *
 * Resolves `null` when the box answered, or with a short phrase naming what went
 * wrong when the poll should try again. Throws {@link WakeRefused} for the
 * failures no retry can fix.
 */
async function attempt(timeoutMs: number): Promise<string | null> {
  // Both values are guaranteed present: every path into a private-tier run goes
  // through `assertPrivateTierConfigured()` first (module load, or scope entry
  // in `runWithInferenceTier`). Read here rather than cached at module load for
  // the same reason the rest of this route reads env per call — a script that
  // sets them before importing a pattern has to be seen.
  const base = (process.env.VERDA_INFERENCE_ENDPOINT ?? '').replace(/\/$/, '')
  const key = process.env.VERDA_INFERENCE_API_KEY ?? ''

  // Node's `fetch` has NO default timeout, and an unbounded attempt is the
  // failure this module would otherwise introduce: it would hang the turn
  // forever instead of ending it inside the budget. It is also what makes the
  // poll a poll — without a per-attempt bound there is nothing to retry FROM.
  // The same lesson `smoke-verda.ts`'s preflight learned the hard way: an
  // unbounded probe hung a diagnostic for four minutes and then said
  // `fetch failed`.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: VERDA_MODEL_ID,
        messages: [{ role: 'user', content: VERDA_WAKE_PROMPT }],
        // The cheapest completion that still forces the weights to load. Not
        // zero: some servers treat `max_tokens: 0` as invalid, and a request
        // that is rejected before generation proves nothing about readiness.
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // The body is read for the message, bounded, because the two failures worth
      // telling apart both live in it: the deployment's own `504 {"error":
      // "inference request was canceled"}` and vLLM's 400 on an unknown model id.
      const detail = await res.text().catch(() => '')
      const said = `answered HTTP ${res.status} after ${Date.now() - started}ms${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`
      if (isRefusal(res.status)) {
        throw new WakeRefused(`${VERDA_WAKE_FAILED}: it ${said}. ${NO_FALLBACK}`)
      }
      return said
    }
    // Drain the body. An undrained response can hold the socket, and this is the
    // one request in the system whose reply nobody wants.
    await res.text().catch(() => '')
    return null
  } catch (err) {
    if (err instanceof WakeRefused) throw err
    // `AbortError` is the per-attempt timeout, and it is the expected outcome on
    // a cold box rather than an anomaly — under either platform behaviour most
    // attempts of a real cold start end here.
    if (err instanceof Error && err.name === 'AbortError') {
      return `went unanswered for ${Math.round(timeoutMs / 1000)}s`
    }
    return `could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is this status the deployment saying "no", rather than "not yet"?
 *
 * 4xx except 408 (request timeout) and 429 (rate limited), which are both the
 * server asking to be tried again. Everything at 5xx is retried: that band
 * includes the gateway's own `504 inference request was canceled`, which is
 * precisely what a box that is still starting says.
 */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wake-then-run — Server Only
 *
 * The self-hosted deployment scales to zero, and #273's decision D-b was what to
 * do about the first call of a session paying the container start plus a 27B
 * weight load: **146 seconds**, measured live 2026-08-26. This module is the
 * answer the owner chose. Before a private-tier turn starts its real work, ONE
 * throwaway request wakes the box; the harness calls begin only once it answers.
 *
 * ## Why a wake ping and not a longer timeout
 *
 * The alternative — the shipped one until now — was to let the first real call
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
 *     dedupes: concurrent turns share one in-flight ping and all resume when it
 *     lands.
 *  3. **The wait was attributed to a call that was mostly not waiting.** The
 *     cold start is now measured by the request that actually pays it.
 *
 * ## What the ping is, precisely
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
 * ## What happens when it does not answer
 *
 * The turn FAILS, visibly, with a message naming the box. It does not fall
 * through to the harness and it does not fall back to Anthropic. Both
 * alternatives are worse than a red turn: running the harness anyway just moves
 * the same wait one layer down into a call whose timeout is now sized for a warm
 * box, and falling back sends confidential-compute prompts to the provider the
 * tier exists to avoid. A thrown error reaches the SSE route's `catch`, which
 * emits an `error` frame, and the server-action path rejects — so in both cases
 * the user is told, which is the property #273 asked for ("never a silent
 * hang").
 *
 * ## What it holds, and where
 *
 * One promise, on a `globalThis` symbol — process-local, the same compromise
 * (and the same eventual Redis move) as the warm clock and the cold-start
 * history. The consequence is honest and mild: two app instances
 * would each send their own wake ping into the same sleeping box, and the box
 * queues them, so the cost of the multi-instance gap is one wasted 21-token
 * request rather than a wrong answer.
 *
 * No prompt, no user id, no conversation id — the ping's content is a fixed
 * literal (SD-10).
 *
 * ## Two things it deliberately does and does not account for
 *
 * **It stamps the warm clock** on a successful ping. The clock's standard is an
 * answered completion on the deployment naming `VERDA_MODEL_ID`, and that is
 * exactly what this is — so without the stamp a turn arriving just after a ping
 * landed, but before the first BAML sample, paid a second ping and was shown a
 * "~146s" countdown that cleared in about a second. Stamped from here rather
 * than by faking an `LlmUsageSample`: this is not a BAML call and must not enter
 * the token counters or the latency window as one.
 *
 * **Its GPU seconds are NOT priced, and that is a decision rather than an
 * oversight.** The ping is a hand-rolled `fetch`, so it emits no usage sample
 * and a ~146s cold start (≈€0.07 at `VERDA_EUR_PER_HOUR`) is outside the
 * time-priced figure — where before this module existed it sat inside the first
 * call's `timing.durationMs`. Three reasons it stays outside:
 *
 *  1. **A shared ping belongs to no one turn.** Concurrent turns attach to the
 *     same request, so charging its euros to a step would charge one user for a
 *     wait several of them shared, and charging all of them would multiply one
 *     bill by the size of the burst.
 *  2. **There is no step to hang it on.** Cost is rendered per LLM step from the
 *     conversation blob; a ping fires before the harness starts and produces no
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
 * How long the wake ping is given to answer.
 *
 * 300s, against measured cold starts of **146s** (2026-08-26, a 21-token
 * completion, #273) and **71.7s** (2026-08-26, this module's own first live wake:
 * one token, and the box may have been partway up). A little over double the
 * larger, because two readings are not a distribution and the deployment's
 * behaviour under queueing is still unmeasured (`baml_src/verda-client.baml`
 * records the platform observations). The FALLBACK estimate the UI shows stays at
 * 146s rather than being averaged down: an estimate that errs long costs a
 * pessimistic countdown, and one that errs short is a promise the box breaks. Sized
 * generously on purpose: this is the one request in the system whose whole job
 * is to wait, so it is the right place for the slack, and it is the reason every
 * other timeout on this route can be tight.
 *
 * A ceiling rather than an expectation. Nothing waits it out on a healthy
 * deployment; on an unhealthy one it is the bound on how long a user stares at a
 * spinner before being told the box did not wake.
 */
export const VERDA_WAKE_TIMEOUT_MS = 300_000

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

const WAKE_KEY = Symbol.for('kg-agent.verda-wake')
interface WakeState {
  /** The ping currently on the wire — resolving with how long it took — shared
   *  by every turn that arrived while it was in flight. Cleared when it settles,
   *  so the NEXT idle period gets its own ping rather than a cached success, and
   *  a FAILED ping is retried by the next turn rather than remembered. */
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
 * BEFORE the ping rather than after it. Without a watch it is silent and still
 * waits — the ping is not a UI feature.
 *
 * @throws when the box did not answer inside {@link VERDA_WAKE_TIMEOUT_MS}, or
 * answered with an error. The message begins with {@link VERDA_WAKE_FAILED}.
 */
export async function ensureVerdaAwake(now: number = Date.now()): Promise<void> {
  // Proof the box is up is the ONLY thing that skips the ping, and it is the
  // same predicate the notice uses — see `verdaProvenWarm`. `unknown` (this
  // process has never seen a call) does NOT skip: a fresh process behind a warm
  // box pays one wasted 21-token request, where the other error costs a user the
  // whole silent wait.
  if (verdaProvenWarm(now)) return

  // Announce first, ping second. A notice that arrived after the ping resolved
  // would be a notice about a wait that had already finished — scenario 8's
  // whole assertion is that this lands INSIDE the wait.
  noteVerdaCallStarting(now)

  // One ping, shared. `??=` rather than a check-then-set: this is synchronous
  // code between two awaits, so there is no interleaving point, and every turn
  // that arrives while a ping is on the wire attaches to it instead of adding
  // another request to a single replica's queue.
  //
  // WHOSE MEASUREMENT IT IS matters, and this is the only reason the flag exists.
  // The ping's duration is the cold start; a turn that arrived 100s into it
  // waited 46s, which is a fragment of one wait and not a measurement of
  // anything. Only the turn that STARTED the ping records; the others mark their
  // watch settled with no reading, which is what stops their first (warm, fast)
  // BAML call being recorded as a cold start further downstream.
  const mine = state.inFlight === null
  state.inFlight ??= ping().finally(() => {
    state.inFlight = null
  })
  const durationMs = await state.inFlight

  // Settled in the CALLING turn's async context, deliberately: the watch is
  // per-turn AsyncLocalStorage, and settling inside the shared promise would
  // settle whichever turn happened to create it and leave the others unsettled.
  settleColdStart(mine ? durationMs : undefined)
}

/** Test-only: drop any shared ping so the next call starts a fresh one. */
export function resetVerdaWake(): void {
  state.inFlight = null
}

/**
 * One wake request. Resolves with how long it took; throws on anything else.
 *
 * The duration reaches the history through `settleColdStart`, the SAME funnel a
 * BAML call used before this module existed, so every gate #274 built still
 * applies unchanged: the watch's coldness evidence (this process saw a call
 * finish and the configured scale-down has elapsed) AND the plausibility floor
 * on the reading itself. The floor earns its keep here in a way it did not
 * before — a wake ping fires on `unknown` too, so a freshly restarted process
 * behind a genuinely warm box measures ~4s, and the floor is the only thing
 * standing between that and a "measured" 4-second cold start.
 *
 * A FAILED ping records nothing, because there is no duration to record: the box
 * did not come up, so the number would be the timeout rather than a cold start.
 */
async function ping(): Promise<number> {
  // Both values are guaranteed present: every path into a private-tier run goes
  // through `assertPrivateTierConfigured()` first (module load, or scope entry
  // in `runWithInferenceTier`). Read here rather than cached at module load for
  // the same reason the rest of this route reads env per call — a script that
  // sets them before importing a pattern has to be seen.
  const base = (process.env.VERDA_INFERENCE_ENDPOINT ?? '').replace(/\/$/, '')
  const key = process.env.VERDA_INFERENCE_API_KEY ?? ''

  // Node's `fetch` has NO default timeout, and an unbounded wake is the failure
  // this module would otherwise introduce: it would hang the turn forever
  // instead of the 180s the client's own calls are bounded by. The same lesson
  // `smoke-verda.ts`'s preflight learned the hard way — an unbounded probe hung
  // a diagnostic for four minutes and then said `fetch failed`.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VERDA_WAKE_TIMEOUT_MS)
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
      throw new Error(
        `${VERDA_WAKE_FAILED}: it answered HTTP ${res.status} after ` +
          `${Date.now() - started}ms${detail ? ` — ${detail.slice(0, 300)}` : ''}. ` +
          'The turn was not started; nothing was sent to any other provider.',
      )
    }
    // Drain the body. An undrained response can hold the socket, and this is the
    // one request in the system whose reply nobody wants.
    await res.text().catch(() => '')
    // THE BOX IS UP, and this is the evidence the warm clock asks for: a
    // completion the deployment answered, on `VERDA_MODEL_ID`. Stamped only on
    // the SUCCESS path, which is where this diverges from the usage observer's
    // rule ("success or failure — a failed call woke the box exactly as much").
    // That rule is safe for a sample: a BAML call that failed still got far
    // enough to be attributed. Here it would be self-defeating — the clock is
    // what makes `verdaProvenWarm()` skip the ping, so stamping it on a 400 for
    // an unknown model id, or on the platform's own 504, would suppress the next
    // wake on the strength of a box that answered an error.
    noteVerdaCallCompleted()
    return Date.now() - started
  } catch (err) {
    // `AbortError` is the timeout, and it is the case worth naming explicitly:
    // "it did not answer in five minutes" is actionable where "fetch failed" is
    // the string that made the smoke script's own hang undiagnosable.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `${VERDA_WAKE_FAILED}: no answer within ${Math.round(VERDA_WAKE_TIMEOUT_MS / 1000)}s. ` +
          'The deployment scales to zero and its first call is slow, but this is past the ' +
          'measured cold start. The turn was not started; nothing was sent to any other provider.',
      )
    }
    // Already ours (the non-OK branch above) — do not wrap it twice.
    if (err instanceof Error && err.message.startsWith(VERDA_WAKE_FAILED)) throw err
    throw new Error(
      `${VERDA_WAKE_FAILED}: ${err instanceof Error ? err.message : String(err)}. ` +
        'The turn was not started; nothing was sent to any other provider.',
      { cause: err },
    )
  } finally {
    clearTimeout(timer)
  }
}

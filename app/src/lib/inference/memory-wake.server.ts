/**
 * The joint memory wake — Server Only (#419 D20)
 *
 * Memory's two private boxes — the 4B summarizer (`SMALL_LLM_BASE_URL`, the
 * `describe`/`decide` model) and the embedder (`EMBEDDINGS_LOCAL_URL`) — no
 * longer have to be always-on (owner decision 6026903497 (b): "it doesn't have
 * to be always-on if we wake both containers at the same time"). This module is
 * the wake that replaces the requirement, modelled line-for-line on
 * {@link ./wake.server.ts}'s Verda wake: one deduplicated poll, shared by every
 * turn that arrives while it is in flight, retrying short bounded attempts
 * until one proves the boxes up. Read that module for the reasoning this one
 * inherits — why a forward pass and not a readiness endpoint, why it polls
 * rather than rides one long request, and why the dedupe wraps the whole loop.
 *
 * ## How it differs from the Verda wake — three ways, each deliberate
 *
 * **Two targets, one wake — and the target set follows the TURN's tier.** The
 * poll runs one loop per **requested** target, concurrently, and resolves only
 * when **all requested** targets proved up. The embedder leg is always
 * requested (every tier's memory pipeline embeds); the 4B leg only when
 * `activeInferenceTier()` is `verda`, because the 4B serves `decide`/`describe`
 * under the private tier only — an Anthropic-tier turn gates through calibrated
 * Jev and describes through the Anthropic chain. Without that gate a slow 4B
 * would push the joint promise past the recall gate's 1500 ms budget and cause
 * a spurious `skipped: 'waking'` on a turn that only needed the embedder, and
 * every idle Anthropic-tier turn would wake a box it never uses. The owner's
 * words are "wake both containers at the same time" — true whenever both are
 * that turn's targets. The target set is fixed when the poll STARTS; a turn of
 * the other tier joining an in-flight poll attaches to the requested set that
 * is already running, which is the dedupe doing its job (at most one poll per
 * process, ever).
 *
 * **Failure is fail-open, because memory is not the turn.** The Verda wake
 * fails the TURN visibly — confidential compute must not silently fall back.
 * A failed memory wake must not: it is an opportunistic feature on a turn that
 * has other work to do. So {@link ensureMemoryAwake} never rejects — it logs
 * the failure and resolves, and the turn proceeds with memory simply absent.
 * **No wake failure ever sends a call to a public provider** (SD-12) — there is
 * no fallback to Jev or Anthropic, and the failure message says so in the same
 * sentence the Verda wake uses. The callers that must LEARN what happened use
 * {@link awaitMemoryWake}, below.
 *
 * **The bounds are unmeasured, and say so.** The Verda numbers are sized to a
 * 27 B weight load; the 4B is ~2.5 GB Q8_0 and the embedder 639 MB, so the
 * defaults here (`MEMORY_WAKE_TIMEOUT_MS` 180 s overall, 30 s per attempt, 5 s
 * between attempts) are stated as placeholders for layer 4 to measure, not as
 * readings. All three are env-tunable through the SAME parser the Verda wake
 * uses ({@link wakeEnvMs}), so the two wakes cannot grow different validation
 * policies either.
 *
 * ## The two entry points, and who calls which
 *
 * - **{@link ensureMemoryAwake}** — the turn start (wiring slice M5, before the
 *   chain's first pattern). The `optsIn` argument is the memory opt-in probe's
 *   answer (`harnessUsesMemory(patterns)` / `AgentDeps.memory`, the same probe
 *   that gates `settleMemory`): `false` starts NOTHING, because waking the
 *   embedder box for an agent with no memory would be GPU seconds spent on
 *   nothing — the same economics that rejected early-start-alone.
 * - **{@link awaitMemoryWake}** — the waiters. The recall gate (slice M1) waits
 *   on it bounded by its own `gate.timeoutMs` and records `skipped: 'waking'`
 *   when it comes back `'skipped'`; `settleMemory` (slice M2) waits bounded by
 *   `MEMORY_WAKE_TIMEOUT_MS` — acceptable in the detached continuation that has
 *   already answered the user — and skips the store when it comes back
 *   `'skipped'`. Both attach to the SAME in-flight poll {@link ensureMemoryAwake}
 *   started; neither can start a second one.
 *
 * No prompt, no user id, no conversation id — every attempt's content is the
 * same fixed literal (SD-10), exactly as in the Verda wake.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { activeInferenceTier } from '@hames-ai/harness-baml/clients.server'
import { isRefusal, wakeEnvMs, NOTHING_SENT_ELSEWHERE } from './wake.server'

assertServerOnImport()

/**
 * How long the whole poll is given, across every attempt: **180s**.
 *
 * UNMEASURED, and stated as that rather than derived: the boxes being woken are
 * an order of magnitude smaller than the 27B whose readings sized the Verda
 * wake (600s against a ~360s measured tail), so those numbers are NOT
 * inherited. 180s is a cold start of the same shape, shorter — one overall
 * budget to be replaced by the first real measurement (eval slice M11's
 * `smoke-embed.ts` and layer 4's wake scenario are where a reading arrives).
 * Like every number in this module it is env-tunable, because the one thing it
 * describes is a platform's behaviour.
 */
export const DEFAULT_MEMORY_WAKE_TIMEOUT_MS = 180_000

/**
 * How long ONE attempt is given before it is abandoned and a fresh one sent:
 * **30s** — the same bet the Verda wake makes, and not an estimate of load time
 * either. It is how long the poll bets on the queue-and-answer reading before
 * spending one more token, and it must stay well clear of a warm call (a warm
 * embedder answers a one-item probe in milliseconds; a warm 4B in seconds), so
 * a warm box never retries.
 *
 * Capped by whatever is left of the overall budget, so the last attempt cannot
 * overshoot it.
 */
export const DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS = 30_000

/**
 * How long the poll waits between a failed attempt and the next one: **5s**, for
 * the Verda wake's reason — an attempt costs the deployment a queued request,
 * so hammering a starting container adds queue depth the box has to work
 * through once it is up; and the gap must not be long, because it is dead time
 * in which a box that just became ready is not being asked anything.
 */
export const DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS = 5_000

/** `MEMORY_WAKE_TIMEOUT_MS`, or {@link DEFAULT_MEMORY_WAKE_TIMEOUT_MS}. */
export function memoryWakeTimeoutMs(): number {
  return wakeEnvMs('MEMORY_WAKE_TIMEOUT_MS', DEFAULT_MEMORY_WAKE_TIMEOUT_MS)
}

/** `MEMORY_WAKE_ATTEMPT_TIMEOUT_MS`, or
 *  {@link DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS}. */
export function memoryWakeAttemptTimeoutMs(): number {
  return wakeEnvMs('MEMORY_WAKE_ATTEMPT_TIMEOUT_MS', DEFAULT_MEMORY_WAKE_ATTEMPT_TIMEOUT_MS)
}

/** `MEMORY_WAKE_POLL_INTERVAL_MS`, or
 *  {@link DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS}. */
export function memoryWakePollIntervalMs(): number {
  return wakeEnvMs('MEMORY_WAKE_POLL_INTERVAL_MS', DEFAULT_MEMORY_WAKE_POLL_INTERVAL_MS)
}

/**
 * The prefix of every memory-wake failure message. Exported so a test can
 * assert the visible string rather than a substring it chose itself. Unlike the
 * Verda wake's, a memory-wake failure is never user-facing — memory is
 * opportunistic and the turn is unaffected — so this names the thing that did
 * not wake for whoever reads the log, not for a spinner.
 */
export const MEMORY_WAKE_FAILED = 'the memory inference box did not wake'

/**
 * The wake probe's message text — a fixed literal (SD-10), the 4B leg's only
 * content. The embedder leg embeds the same literal.
 */
export const MEMORY_WAKE_PROMPT = 'wake'

/**
 * The model id the 4B probe names. A COPY of the `model` line on
 * `LocalQwenSmall` (`packages/harness-baml/baml_src/local-client.baml`) — the
 * probe is a hand-rolled fetch, so it has to name a model and BAML exports
 * nothing to read it from. The copy is pinned against the declaration by
 * `memory-wake.test.ts`, the same way `VERDA_MODEL_ID` is pinned against
 * `verda-client.baml`: a drifting id is a 400 from a server that validates
 * model names, which `isRefusal` correctly treats as a misconfiguration and
 * ends the wake on — silently disabling memory until someone reads the log.
 */
export const SUMMARIZER_MODEL_ID = 'qwen3.5-4b-instruct'

/**
 * The model id the embedder probe names — the same lookup
 * `stash/embeddings.server.ts` does (`EMBEDDINGS_LOCAL_MODEL`, else its
 * `LOCAL_DEFAULT_MODEL`), because a server that validates model names rejects
 * the probe for a name the real embedder would never send. The default literal
 * is a copy of that module's, pinned against it by test; the env override is
 * read per call, so an operator re-pointing the embedder at a differently-named
 * deployment needs no rebuild.
 */
export function embedderWakeModel(): string {
  return process.env.EMBEDDINGS_LOCAL_MODEL ?? 'Qwen3-Embedding-0.6B'
}

/**
 * One wake target. The labels carry the env var that names the endpoint,
 * because a target that never answers has to be diagnosable from the failure
 * message alone — the Verda lesson ("late, but named") applied per target.
 */
interface WakeTarget {
  /** Human-readable name, used in every failure message about this target. */
  readonly label: string
  /** The env var holding this target's OpenAI-compatible base URL (`/v1`). */
  readonly envVar: string
  /** The env var holding this target's optional bearer key, if it checks one. */
  readonly keyEnvVar: string
  /** The probe request's path and body — a forward pass, never a readiness GET. */
  readonly probe: (base: string) => { path: string; body: Record<string, unknown> }
}

/**
 * The 4B summarizer's probe: a 1-token completion at temperature 0. The
 * cheapest request that forces the weights to load and one token out —
 * `max_tokens: 1`, not 0, because a request rejected before generation proves
 * nothing about readiness. The Verda module's `/v1/models` lesson applies
 * verbatim: a readiness GET answers while the weights are still loading, in
 * BOTH directions wrong.
 */
const SUMMARIZER: WakeTarget = {
  label: 'the 4B summarizer (SMALL_LLM_BASE_URL)',
  envVar: 'SMALL_LLM_BASE_URL',
  keyEnvVar: 'SMALL_LLM_API_KEY',
  probe: (_base) => ({
    path: '/chat/completions',
    body: {
      model: SUMMARIZER_MODEL_ID,
      messages: [{ role: 'user', content: MEMORY_WAKE_PROMPT }],
      max_tokens: 1,
      temperature: 0,
    },
  }),
}

/**
 * The embedder's probe: a ONE-ITEM `POST /v1/embeddings`. The cheapest forward
 * pass an embedding server can serve — one input, the fixed literal — and the
 * only request shape that proves the embedding weights are loaded. The model id
 * is the one the real embedder would send (see {@link embedderWakeModel}).
 */
const EMBEDDER: WakeTarget = {
  label: 'the embedder (EMBEDDINGS_LOCAL_URL)',
  envVar: 'EMBEDDINGS_LOCAL_URL',
  keyEnvVar: 'EMBEDDINGS_LOCAL_API_KEY',
  probe: (_base) => ({
    path: '/embeddings',
    body: { model: embedderWakeModel(), input: [MEMORY_WAKE_PROMPT] },
  }),
}

/**
 * The requested target set for THIS turn: the embedder always, the 4B only on
 * the private tier — the tier gate that keeps an Anthropic-tier turn from
 * waiting on (and waking) a 4B it never calls. Read at poll START; see the
 * module docstring for what that means when a turn of the other tier joins an
 * in-flight poll.
 */
function requestedTargets(): WakeTarget[] {
  const targets: WakeTarget[] = [EMBEDDER]
  if (activeInferenceTier() === 'verda') targets.push(SUMMARIZER)
  return targets
}

const MEMORY_WAKE_KEY = Symbol.for('hames-app.memory-wake')
interface MemoryWakeState {
  /**
   * The poll currently running — shared by every caller that arrived while it
   * was in flight. Cleared when it settles, so the NEXT idle period gets its
   * own poll rather than a cached success: an in-flight dedupe, not a memo. A
   * FAILED poll is likewise retried by the next caller rather than remembered
   * (the boxes may well be up by then; the probe is the cheapest way to ask).
   */
  inFlight: Promise<void> | null
  /**
   * The LAST poll's settled promise, kept so a waiter arriving after the poll
   * ended can still read its OUTCOME. It must exist, because a failed poll
   * reaches the same cleared `inFlight` a landed one does — and a refusal
   * rejects in MILLISECONDS (an unconfigured endpoint, a bad key, an unknown
   * model id), long before the detached `compactAndSave` continuation asks, so
   * D20's skip-on-rejection would be unreachable on exactly the common
   * misconfiguration timeline if `awaitMemoryWake` could only see a poll in
   * flight. Cleared when a new poll starts. This is outcome reporting for
   * waiters, not retry memoisation: the START path never consults it, and a
   * failed outcome is superseded by the next poll, not remembered by it.
   */
  settled: Promise<void> | null
}
type MemoryWakeGlobal = typeof globalThis & { [MEMORY_WAKE_KEY]?: MemoryWakeState }
const state: MemoryWakeState = ((globalThis as MemoryWakeGlobal)[MEMORY_WAKE_KEY] ??= {
  inFlight: null,
  settled: null,
})

/**
 * Start (or join) the joint memory wake for a turn that opted into memory.
 *
 * `optsIn` is the memory opt-in probe's answer — the same
 * `harnessUsesMemory(patterns)` / `AgentDeps.memory` probe that gates
 * `settleMemory`, supplied by the turn wiring (slice M5). `false` starts
 * nothing and resolves immediately: the wake is the first act of an OPTED-IN
 * turn, and no agent without memory pays GPU seconds on one.
 *
 * Never rejects — FAIL-OPEN (D20). A failed wake is logged with the full
 * message (the target that did not answer, its attempt count, the elapsed time
 * and the last error verbatim) and the turn proceeds; memory is simply absent.
 * Callers that must distinguish "up" from "not yet" attach through
 * {@link awaitMemoryWake}, which observes the same in-flight poll.
 *
 * Resolves as soon as every requested target answered its forward pass — which,
 * on a warm box, is the first attempt: two cheap requests, the cheapest warm
 * check there is. (There is deliberately no warm-clock skip like the Verda
 * wake's `verdaProvenWarm`: the small boxes have no usage observer to stamp,
 * and a probe pair costs milliseconds — it IS the warm check.)
 */
export async function ensureMemoryAwake(optsIn: boolean): Promise<void> {
  if (!optsIn) return

  // One poll, shared — the dedupe wraps the WHOLE loop (a poll = all requested
  // target loops), not one request, exactly as in the Verda wake: every caller
  // that arrives while a poll is running attaches to it, and a burst against
  // the same sleeping box is one queue rather than N independent polls.
  if (state.inFlight === null) {
    // A new poll supersedes the last one's outcome: the waiters it mattered to
    // have been told, and a fresh poll must not inherit a stale 'skipped'.
    state.settled = null
    const done = pollTargets(requestedTargets()).finally(() => {
      // Keep the settled poll's OUTCOME readable by late waiters (see
      // `settled`), then clear the in-flight slot: an in-flight dedupe, not a
      // memo.
      state.settled = done
      state.inFlight = null
    })
    // The rejection is reported through `state.settled` and through every
    // waiter's own attach; this no-op catch is what keeps it from surfacing as
    // an unhandled rejection in the window where nobody is waiting yet.
    done.catch(() => {})
    state.inFlight = done
  }

  try {
    await state.inFlight
  } catch (err) {
    // Fail-open (D20): a failed memory wake must never fail the turn and must
    // never send a call to a public provider. The log carries the full message
    // — the failed target, the attempts, the elapsed time, the last error —
    // because for an opportunistic feature the log IS the surface.
    console.warn(`[memory-wake] ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * How a waiter should proceed after attaching to the wake.
 *
 * `'awake'` — the wake landed inside the caller's budget (or nothing is in
 * flight and the LAST poll landed: the boxes are at least not mid-wake).
 * `'skipped'` — the budget expired first, the wake FAILED while the caller
 * waited, or the last poll FAILED before the caller arrived: either way the
 * caller attaches nothing (the gate records `skipped: 'waking'`; the store
 * writes nothing) and the turn proceeds. The wake itself keeps running in the
 * background either way, so the post-reply store and the next turn benefit.
 */
export type MemoryWakeOutcome = 'awake' | 'skipped'

/**
 * Attach to the in-flight memory wake, bounded by `budgetMs` — the ONE bounded
 * wait both consumers use, so the gate (slice M1) and the store (slice M2)
 * cannot grow different wait semantics.
 *
 * Attaches to the poll {@link ensureMemoryAwake} started — it never starts one,
 * because the wake's whole value is that it began BEFORE the chain's first
 * pattern and has been running concurrently with routing and the gate ever
 * since. When no poll is in flight, the LAST poll's outcome is consulted
 * (`state.settled`): a landed wake reads `'awake'` and the caller proceeds —
 * which is what makes `settleMemory` work minutes after a successful wake
 * cleared itself — while a FAILED wake still reads `'skipped'`, because D20's
 * skip-on-rejection must survive the fast-refusal timeline: a refused wake
 * rejects in milliseconds and clears `inFlight` long before the detached
 * `compactAndSave` continuation asks. The failed outcome persists only until
 * the next {@link ensureMemoryAwake} starts a fresh poll — outcome reporting
 * for waiters, not retry memoisation.
 *
 * Never rejects and never waits past `budgetMs`: a wake that fails or stalls is
 * `'skipped'`, not an error — the same fail-open contract
 * {@link ensureMemoryAwake} gives the turn, expressed for waiters.
 */
export async function awaitMemoryWake(budgetMs: number): Promise<MemoryWakeOutcome> {
  const wake = state.inFlight ?? state.settled
  if (!wake) return 'awake'
  // The budget timer is cleared when the wake wins, so a fast answer does not
  // leave a `setTimeout` pending for up to `budgetMs` (180s for `settleMemory`'s
  // use) behind a race that is already decided.
  let budgetExpired: () => void = () => {}
  const expired = new Promise<'skipped'>((resolve) => {
    budgetExpired = () => resolve('skipped')
  })
  const timer = setTimeout(budgetExpired, budgetMs)
  try {
    return await Promise.race([
      wake.then(
        () => 'awake' as const,
        () => 'skipped' as const,
      ),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only: drop any shared poll so the next call starts a fresh one. */
export function resetMemoryWake(): void {
  state.inFlight = null
  state.settled = null
}

/**
 * Poll every requested target concurrently; resolve only when ALL of them
 * proved up; reject (naming the first target that failed) the moment any one
 * of them refuses or exhausts its budget.
 */
async function pollTargets(targets: readonly WakeTarget[]): Promise<void> {
  // A shared abort closes the poll as a WHOLE: when one target refuses or
  // expires, the joint wake is over — its promise has rejected, the callers
  // have been told — and a sibling loop still hammering its own box for the
  // rest of its budget is a poll without a waiter. Aborted loops stop before
  // their next attempt and discard the attempt in flight.
  const shared = new AbortController()
  const loops = targets.map((t) => pollTarget(t, shared.signal))
  // Promise.all rejects on the FIRST failure and abandons the rest; the
  // pre-attached catches keep the abandoned loops' own rejections (a sibling
  // that also refused, a discarded in-flight attempt) from surfacing as
  // unhandled rejections.
  for (const loop of loops) loop.catch(() => {})
  try {
    await Promise.all(loops)
  } catch (err) {
    shared.abort()
    throw err
  }
}

/**
 * Poll ONE target until an attempt answers. Resolves when it does; throws with
 * a message naming THIS target — which is what Promise.all surfaces as the
 * joint wake's failure — when the target refuses outright or the budget runs
 * out. The message carries the attempt count, the elapsed time and the last
 * error verbatim (the Verda wake's diagnosability rule, applied per target).
 */
async function pollTarget(target: WakeTarget, shared: AbortSignal): Promise<void> {
  const budgetMs = memoryWakeTimeoutMs()
  const attemptMs = memoryWakeAttemptTimeoutMs()
  const intervalMs = memoryWakePollIntervalMs()

  const started = Date.now()
  const remaining = (): number => budgetMs - (Date.now() - started)
  let attempts = 0
  // Overwritten by the first attempt, always: `wakeEnvMs` refuses a
  // non-positive budget, so the loop below runs at least once and this
  // initializer cannot reach the message. It is here because TypeScript needs
  // one, not as a case.
  let lastReason = 'it was never asked'

  while (remaining() > 0) {
    // A sibling's failure ended the joint wake; this loop is a remainder of a
    // poll nobody is waiting on any more.
    if (shared.aborted) return
    attempts += 1
    // Capped by what is left, so the final attempt cannot overshoot the budget.
    const failure = await attemptTarget(target, Math.min(attemptMs, remaining()), shared)
    if (failure === null) return
    lastReason = failure
    // Do not sleep out the tail of the budget.
    if (remaining() <= 0) break
    await sleep(Math.min(intervalMs, remaining()))
  }

  const waitedS = Math.round((Date.now() - started) / 1000)
  throw new Error(
    `${MEMORY_WAKE_FAILED}: ${target.label} did not answer — ${attempts} ` +
      `attempt${attempts === 1 ? '' : 's'} over ${waitedS}s, and the last one ${lastReason}. ` +
      `Memory stays off for now; ${NOTHING_SENT_ELSEWHERE}`,
  )
}

/** A failure that ends a target's poll on the spot rather than being retried —
 *  see "Which failures are retried" in `wake.server.ts`, whose classification
 *  ({@link isRefusal}) is the shared authority on what counts. */
class MemoryWakeRefused extends Error {}

/**
 * One wake attempt against ONE target, bounded by `timeoutMs`.
 *
 * Resolves `null` when the target answered its forward pass, or with a short
 * phrase naming what went wrong when the poll should try again. Throws
 * {@link MemoryWakeRefused} for the failures no retry can fix — a
 * misconfiguration, named by target and status. Node's `fetch` has NO default
 * timeout and an unbounded attempt would hang the poll forever, so every
 * attempt carries its own abort — plus the shared signal, so ending the joint
 * wake ends every loop's attempt with it.
 */
async function attemptTarget(
  target: WakeTarget,
  timeoutMs: number,
  shared: AbortSignal,
): Promise<string | null> {
  // An unconfigured endpoint is a refusal, not a retry: without the URL the
  // memory pipeline cannot run at all, so polling one out would spend the whole
  // budget asking for an address nobody set. The message names the env var —
  // the same "late, but named" rule as every other failure.
  const base = (process.env[target.envVar] ?? '').replace(/\/$/, '')
  if (!base) {
    throw new MemoryWakeRefused(
      `${MEMORY_WAKE_FAILED}: ${target.label} is not configured — ${target.envVar} is not set, ` +
        `so memory cannot run at all. Memory stays off for now; ` +
        `${NOTHING_SENT_ELSEWHERE}`,
    )
  }
  const { path, body } = target.probe(base)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onSharedAbort = (): void => controller.abort()
  shared.addEventListener('abort', onSharedAbort, { once: true })
  const started = Date.now()
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Sent even when empty, as the BAML `openai-generic` client does: a
        // server that checks keys 401s loudly on its own, which `isRefusal`
        // then refuses to retry — a bad key is a misconfiguration, not a cold
        // box.
        Authorization: `Bearer ${process.env[target.keyEnvVar] ?? ''}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      // Bounded read of the body — the two failures worth telling apart both
      // live in it (vLLM's 400 on an unknown model id, a gateway's own 504).
      const detail = await res.text().catch(() => '')
      const said = `answered HTTP ${res.status} after ${Date.now() - started}ms${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`
      if (isRefusal(res.status)) {
        throw new MemoryWakeRefused(
          `${MEMORY_WAKE_FAILED}: ${target.label} refused the wake — it ${said}. ` +
            `Memory stays off for now; ${NOTHING_SENT_ELSEWHERE}`,
        )
      }
      return said
    }
    // Drain the body — an undrained response can hold the socket, and this is
    // the one request in the system whose reply nobody wants.
    await res.text().catch(() => '')
    return null
  } catch (err) {
    if (err instanceof MemoryWakeRefused) throw err
    // Aborted because the JOINT wake ended (a sibling refused), not because
    // this attempt timed out: report it as discarded and let the loop's
    // `shared.aborted` check stop it.
    if (shared.aborted) return 'was discarded when the joint wake ended'
    // `AbortError` is the per-attempt timeout, and on a cold box it is the
    // EXPECTED outcome of most attempts — the poll exists to replace it.
    if (err instanceof Error && err.name === 'AbortError') {
      return `went unanswered for ${Math.round(timeoutMs / 1000)}s`
    }
    return `could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer)
    shared.removeEventListener('abort', onSharedAbort)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

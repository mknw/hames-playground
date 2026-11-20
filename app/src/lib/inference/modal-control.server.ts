/**
 * The Modal control plane, as the app reaches it — Server Only.
 *
 * The deployment's two GPU boxes are Modal apps that scale to zero, and every
 * question the app has about them — is one up? how long has it been booting?
 * boot it / keep it up / stop it — is a CONTROL-plane question, whose answers
 * until #1057 were inferred from this process's own clocks because the app had
 * no route to Modal's control API at all: Modal's JavaScript SDK (npm `modal`)
 * has no `Server` class (its `App` exposes `info`/`stats`/`stop`;
 * `updateAutoscaler` exists only on the Function class), so the one SDK that
 * covers `Server._experimental_list_containers()` and
 * `Server.update_autoscaler(min_containers=…)` is the Python one
 * (`deploy/modal/ops.py`'s calls, pinned `modal==1.6.1`). The route this module
 * takes is the **control sidecar** (`deploy/modal/control_sidecar.py`): a small
 * Python service on the host that holds the Modal workspace token the app must
 * never see and answers this module over an authenticated local socket. The
 * finding and the choice are in the PR body and `deploy/modal/README.md`;
 * what belongs here is the contract.
 *
 * ## Deliberately NOT the inference endpoint
 *
 * This module NEVER touches `LARGE_LLM_BASE_URL`, `SMALL_LLM_BASE_URL` or
 * either key: a status read that sent a request to the model endpoint would
 * SCALE THE BOX UP — billing GPU seconds for a look (`small-gpu.server.ts`
 * states the same rule). Everything here speaks only to the sidecar, and the
 * sidecar speaks only to Modal's control plane. A source-scan test pins that
 * no inference-endpoint variable is read in this file.
 *
 * ## Degradation is the designed no-token mode
 *
 * `MODAL_CONTROL_BASE` + `MODAL_CONTROL_TOKEN` unset (the whole deployment
 * today) is not an error: `modalControlConfigured()` is false, every probe
 * answers `{ok: false, reason: 'missing-token'}`, and the callers fall back to
 * today's behaviour — the admin panel says "Modal control unavailable (no
 * token)", the keep-running switch drives the boxes through keep-warm pings,
 * and the wake poll never consults Modal. The token itself is read only into
 * a request header, never logged (no `console.*` in this file carries it) and
 * never sent to the browser.
 *
 * ## Caching
 *
 * The probe result is cached process-side for {@link MODAL_PROBE_CACHE_TTL_MS}
 * on a `globalThis` symbol (HPR-safe, the same shape as the Verda probe
 * `verda-control-plane.server.ts` — which this module mirrors deliberately:
 * two control-plane clients should not have two cache disciplines), and
 * concurrent callers share one in-flight probe. Failures are cached too, so a
 * down sidecar costs one bounded attempt per TTL. The control ACTIONS are
 * never cached: they are RPCs from a click.
 *
 * No user id, no conversation id, no prompt, no content — the probe carries a
 * deployment token and two box names (SD-10).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

/**
 * The sidecar's base URL (for example `http://127.0.0.1:8124`), from the
 * runtime env. Read per call, not at module load — the same rule the rest of
 * the inference route follows: a script that sets the var before importing a
 * pattern has to be seen. Unset means Modal control is unavailable and every
 * consumer falls back to today's behaviour.
 */
export function modalControlBase(): string | null {
  const raw = process.env.MODAL_CONTROL_BASE?.trim()
  return raw ? raw.replace(/\/$/, '') : null
}

/**
 * The bearer the sidecar demands (`MODAL_CONTROL_TOKEN`). This is NOT the
 * Modal workspace token — that one lives only in the sidecar's env
 * (`deploy/modal/control_sidecar.py`); this one authorizes the app to the
 * sidecar. Never logged, never rendered, never sent to the browser.
 */
function modalControlToken(): string | null {
  const raw = process.env.MODAL_CONTROL_TOKEN?.trim()
  return raw ? raw : null
}

/** Is the Modal control route available at all? Both halves must be present. */
export function modalControlConfigured(): boolean {
  return modalControlBase() !== null && modalControlToken() !== null
}

/** One bounded fetch to the sidecar. Transport errors, timeouts and non-2xx
 *  become one `Error` naming the route — degraded, never thrown to a caller. */
async function sidecarFetch(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const base = modalControlBase()
  if (base === null) throw new Error('no MODAL_CONTROL_BASE')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `the Modal control sidecar answered HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return await res.json().catch(() => {
      throw new Error('the Modal control sidecar answered a body that is not JSON')
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`the Modal control sidecar timed out after ${timeoutMs}ms`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

function bearerHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${modalControlToken() ?? ''}`,
    'Content-Type': 'application/json',
  }
}

// ============================================================================
// The read path: GET /state
// ============================================================================

/** Which of the two self-deployed boxes a state read or control action
 *  addresses. `large` is the 27B (`LARGE_LLM_BASE_URL`), `small` the 4B
 *  summarizer (`SMALL_LLM_BASE_URL`) — the same ids `cold-start.server.ts`
 *  and `wake.server.ts` use, so the three modules name one box set. */
export type ModalBox = 'large' | 'small'

/**
 * Which boxes this deployment drives through Modal is NOT decided here: the
 * 27B rides Modal only while `LARGE_LLM_ROUTE` is not `openrouter`, and that
 * route knowledge already lives where the wake and the keep-running loop read
 * it (`@hames-ai/harness-baml/inference-env.server`, `largeOnOpenRouter`) —
 * the callers name the boxes, this module serves whichever they name.
 */

/** One container Modal reports for a box. */
export interface ModalContainer {
  id: string
  /** Epoch ms of its start; `null` while Modal still lists it as `Pending`. */
  startedAtMs: number | null
  /** Registered to serve requests (the SDK's serving registry): `true` once its
   *  boot is done, `false` while it boots, `null` when the sidecar could not
   *  read the registry. The ONLY gate on asking the box anything. */
  ready: boolean | null
}

/** One box's answer from the sidecar, already reduced to what any caller
 *  asks of it. `ok: false` is the degraded result — the reason is for the
 *  admin panel and the log, and the callers fall back to their own clocks. */
export interface ModalBoxProbe {
  ok: boolean
  /** Containers the control plane reports for this box; `null` when the read
   *  failed. Zero is a real answer: observed scaled-to-zero. */
  containerCount: number | null
  /** The oldest container's start, epoch ms, when the sidecar reports one —
   *  the one honest elapsed-time base for a booting box's countdown and an
   *  up box's "up since". `null` when the read failed or no container has a
   *  start yet (Modal prints a queued task's start as `Pending`). */
  oldestContainerStartedAtMs: number | null
  /** Every container Modal has CREATED for the box, booting and queued ones
   *  included — the sidecar's list is Modal's task list (`modal container
   *  list`), NOT the serving registry: a container registers to serve only
   *  after its `@modal.enter` boot finishes, and both boxes boot inside it, so
   *  the registry is empty for the whole 8–15 minute boot. `[]` when the read
   *  failed or the box has none. */
  containers: ModalContainer[]
  /** When `!ok`: `missing-token`, `timeout`, `http …`, `unauthorized`, or the
   *  sidecar's own per-box error. For the panel and the log, never the UI. */
  reason: string | null
}

/** Both boxes, in one round trip — the admin payload and the wake's
 *  not-starting check both want the pair, and the sidecar answers the pair
 *  from one request. */
export interface ModalControlProbe {
  large: ModalBoxProbe
  small: ModalBoxProbe
  /** When this reading was taken. */
  at: number
}

/** How long ONE sidecar read or autoscaler call is given. A slow sidecar
 *  degrades the answer, never hangs a poll. 15s, not the Verda probe's 5s: the
 *  sidecar's task list is a fresh `modal container list` process (an SDK
 *  import and a gRPC call — seconds), bounded at 12s on its own side. */
export const MODAL_CONTROL_TIMEOUT_MS = 15_000

/** How long a STOP is given. The sidecar lists the containers and then runs
 *  one `modal container stop` process per container (20s each at most), so the
 *  read bound would report a failure for a stop that was still going through. */
export const MODAL_CONTROL_STOP_TIMEOUT_MS = 70_000

/** How long one probe serves every caller of this process. The admin panel and
 *  the strip poll at 3–15s; 12s rides the same band the Verda probe chose. */
export const MODAL_PROBE_CACHE_TTL_MS = 12_000

const CACHE_KEY = Symbol.for('hames-app.modal-control')
interface CacheState {
  probe: { result: ModalControlProbe; fetchedAt: number } | null
  inFlight: Promise<ModalControlProbe> | null
  lastWarnedReason: string | null
}
type CacheGlobal = typeof globalThis & { [CACHE_KEY]?: CacheState }
const state: CacheState = ((globalThis as CacheGlobal)[CACHE_KEY] ??= {
  probe: null,
  inFlight: null,
  lastWarnedReason: null,
})

/** Test-only reset: both caches and the warn-once memory. */
export function resetModalControlCache(): void {
  state.probe = null
  state.inFlight = null
  state.lastWarnedReason = null
}

/** At most one warn per reason transition — a poll loop must not warn per
 *  tick about the same down sidecar. */
function warnOnce(reason: string): void {
  if (state.lastWarnedReason === reason) return
  state.lastWarnedReason = reason
  console.warn(
    `[modal] control-plane probe unavailable (${reason}); falling back to the app's own clocks.`,
  )
}

/** The sidecar's per-box JSON, reduced. A missing box in the answer is a
 *  shape failure for that box alone. */
function reduceBox(raw: unknown): ModalBoxProbe {
  const failed = (reason: string): ModalBoxProbe => ({
    ok: false,
    containerCount: null,
    oldestContainerStartedAtMs: null,
    containers: [],
    reason,
  })
  if (typeof raw !== 'object' || raw === null || !('ok' in raw)) {
    return failed('unexpected response shape')
  }
  const box = raw as { ok: unknown; containers?: unknown; error?: unknown }
  if (box.ok !== true) {
    return failed(typeof box.error === 'string' && box.error ? box.error : 'the sidecar refused')
  }
  const containers = Array.isArray(box.containers) ? box.containers : null
  if (containers === null) return failed('unexpected response shape')
  const reduced: ModalContainer[] = containers.map((c) => {
    const row = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {}
    return {
      id: typeof row.container_id === 'string' ? row.container_id : '',
      startedAtMs:
        typeof row.started_at_ms === 'number' && Number.isFinite(row.started_at_ms)
          ? row.started_at_ms
          : null,
      ready: typeof row.ready === 'boolean' ? row.ready : null,
    }
  })
  // A queued container has no start yet; only those that parse count toward
  // the oldest.
  const started = reduced.flatMap((c) => (c.startedAtMs === null ? [] : [c.startedAtMs]))
  return {
    ok: true,
    containerCount: reduced.length,
    oldestContainerStartedAtMs: started.length > 0 ? Math.min(...started) : null,
    containers: reduced,
    reason: null,
  }
}

const MISSING_TOKEN: ModalBoxProbe = {
  ok: false,
  containerCount: null,
  oldestContainerStartedAtMs: null,
  containers: [],
  reason: 'missing-token',
}

async function runProbe(): Promise<ModalControlProbe> {
  try {
    const body = await sidecarFetch(
      '/state',
      { headers: bearerHeaders() },
      MODAL_CONTROL_TIMEOUT_MS,
    )
    const boxes =
      typeof body === 'object' && body !== null && 'boxes' in body
        ? (body as { boxes: unknown }).boxes
        : null
    if (typeof boxes !== 'object' || boxes === null) {
      throw new Error('unexpected response shape')
    }
    return {
      large: reduceBox((boxes as Record<string, unknown>)['large']),
      small: reduceBox((boxes as Record<string, unknown>)['small']),
      at: Date.now(),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      large: { ...MISSING_TOKEN, reason },
      small: { ...MISSING_TOKEN, reason },
      at: Date.now(),
    }
  }
}

/**
 * Both boxes' state from the Modal control plane, cached for
 * {@link MODAL_PROBE_CACHE_TTL_MS} and shared by every caller in this process.
 * NEVER throws: every failure mode is the degraded per-box `{ok: false}`,
 * so a broken sidecar costs a panel line its `unknown` and nothing else.
 * Reading it never sends a request to either box — the sidecar's own contract.
 */
export async function probeModalBoxes(): Promise<ModalControlProbe> {
  if (!modalControlConfigured()) {
    warnOnce('missing-token')
    return { large: MISSING_TOKEN, small: MISSING_TOKEN, at: Date.now() }
  }
  const cached = state.probe
  if (cached && Date.now() - cached.fetchedAt < MODAL_PROBE_CACHE_TTL_MS) return cached.result
  state.inFlight ??= runProbe().finally(() => {
    state.inFlight = null
  })
  const result = await state.inFlight
  state.probe = { result, fetchedAt: Date.now() }
  // A container exists: the boot request WAS answered, whatever the box's own
  // endpoint says yet. The boot clock below means "asked and nothing created",
  // so it ends here — and a later zero reading (the box scaled down, or its
  // container died) must start a fresh count, not inherit hours of an old one.
  for (const box of ['large', 'small'] as const) {
    if (result[box].ok && (result[box].containerCount ?? 0) > 0) noteModalBootEnded(box)
  }
  if (!result.large.ok && result.large.reason) warnOnce(result.large.reason)
  else if (result.large.ok) state.lastWarnedReason = null
  return result
}

/** One box's probe out of the pair. */
export function modalBoxProbe(probe: ModalControlProbe, box: ModalBox): ModalBoxProbe {
  return probe[box]
}

// ============================================================================
// The control path: POST /autoscaler, POST /stop
// ============================================================================

/** What a control action answers: `ok` plus the reason it did not take. The
 *  caller (an admin-gated server action) turns `ok: false` into a thrown
 *  Error carrying the reason, so the panel shows it. */
export interface ModalControlAnswer {
  ok: boolean
  reason: string | null
  /** The `min_containers` Modal reports back from an autoscaler call (`null`
   *  for a stop, or when the answer carried none). The release retry CONFIRMS
   *  against it: an `ok` that does not say 0 is not a release. */
  minContainers: number | null
}

/** Boot (`minContainers: 1`) or release (`minContainers: 0`) a box through its
 *  autoscaler — NO request is sent to the box either way; the autoscaler boots
 *  it without one. Only `min_containers` is passed: the sidecar leaves every
 *  other autoscaler parameter at the value it already had. Never throws. */
export async function setModalBoxMinContainers(
  box: ModalBox,
  minContainers: 0 | 1,
): Promise<ModalControlAnswer> {
  if (!modalControlConfigured()) return { ok: false, reason: 'missing-token', minContainers: null }
  try {
    const body = await sidecarFetch(
      '/autoscaler',
      {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({ box, min_containers: minContainers }),
      },
      MODAL_CONTROL_TIMEOUT_MS,
    )
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      const reason =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'unexpected response shape'
      return { ok: false, reason, minContainers: null }
    }
    const reported = (body as { min_containers?: unknown }).min_containers
    return { ok: true, reason: null, minContainers: typeof reported === 'number' ? reported : null }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), minContainers: null }
  }
}

/** Stop a box's containers NOW — `ops.py stop`'s call, one per container —
 *  instead of waiting out the billed scaledown window. Never throws. */
export async function stopModalBoxContainers(box: ModalBox): Promise<ModalControlAnswer> {
  if (!modalControlConfigured()) return { ok: false, reason: 'missing-token', minContainers: null }
  try {
    const body = await sidecarFetch(
      '/stop',
      { method: 'POST', headers: bearerHeaders(), body: JSON.stringify({ box }) },
      MODAL_CONTROL_STOP_TIMEOUT_MS,
    )
    if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
      const reason =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'unexpected response shape'
      return { ok: false, reason, minContainers: null }
    }
    return { ok: true, reason: null, minContainers: null }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), minContainers: null }
  }
}

// ============================================================================
// "Not starting": the boot-request clock
// ============================================================================

/**
 * After how long a boot the control plane saying "no container" stops being
 * slow and starts being FAILING — the rule the 2026-11-19 morning made
 * necessary: a 27B that could not start answered 237 attempts over 1200 s and
 * the app sat the whole timeout out before failing the turn.
 *
 * **300 s**, deliberately WELL UNDER the 1200 s wake budget
 * (`LARGE_LLM_WAKE_TIMEOUT_MS` as the Modal README ships it): a boot that
 * restores a snapshot has a container up in seconds and finishes in ~157 s at
 * the measured worst, and a full boot has its container up immediately too —
 * the container STARTS fast and boots INSIDE itself. "No container" is read
 * from Modal's TASK list (`modal container list`: queued and booting
 * containers included, with their start time), never from the serving
 * registry — a booting box is in the former for its whole 8–15 minutes and in
 * the latter not at all, so a rule on the registry would end every full boot
 * at 300 s as "failing". A boot that has been
 * asked for five minutes with Modal reporting no container is not booting:
 * the scale-up itself is failing (quota, payment, misconfiguration), and
 * every later attempt is the same rejection — polling it out to 20 minutes
 * turns a one-line misconfiguration into a twenty-minute spinner, the exact
 * failure `wake.server.ts`'s refusal rule exists to prevent.
 *
 * Overridable with `MODAL_NOT_STARTING_AFTER_MS` (a positive number of ms),
 * so a host whose Modal behaves differently — or a test suite that wants the
 * rule observable inside seconds — can move it.
 */
export const DEFAULT_MODAL_NOT_STARTING_AFTER_MS = 300_000

export function modalNotStartingAfterMs(): number {
  const raw = process.env.MODAL_NOT_STARTING_AFTER_MS
  if (raw === undefined || raw === '') return DEFAULT_MODAL_NOT_STARTING_AFTER_MS
  const ms = Math.floor(Number(raw))
  if (!Number.isFinite(ms) || ms <= 0) {
    console.warn(
      `[modal] MODAL_NOT_STARTING_AFTER_MS=${JSON.stringify(raw)} is not a positive number of ms; ` +
        `keeping the default (${DEFAULT_MODAL_NOT_STARTING_AFTER_MS / 1000}s).`,
    )
    return DEFAULT_MODAL_NOT_STARTING_AFTER_MS
  }
  return ms
}

/**
 * Per box: when this process first recorded a boot request that the control
 * plane has not answered with a container, epoch ms, or `null` while no boot
 * is pending. Three things stamp it — the wake poll when it starts asking for
 * a box, the switch's ON, and the keep-running loop's ticks while Modal lists
 * no container — and three end it: a probe that finds a container (the
 * request WAS answered), the poll ending, and the switch's OFF. The admin
 * panel and the header read the same clock, so the two surfaces cannot
 * disagree about when a failing start began.
 */
const BOOT_KEY = Symbol.for('hames-app.modal-boot-pending')
interface BootState {
  pendingSince: Partial<Record<ModalBox, number>>
}
const boot: BootState = ((globalThis as typeof globalThis & { [BOOT_KEY]?: BootState })[
  BOOT_KEY
] ??= {
  pendingSince: {},
})

/** Test-only reset. */
export function resetModalBootPending(): void {
  boot.pendingSince = {}
}

/** The wake poll calls this when it starts asking a box to boot. Idempotent:
 *  a later poll for the same box keeps the ORIGINAL stamp, which is the one
 *  honest "asked since" — restamping per poll would reset the not-starting
 *  threshold with every turn and name a five-minute failure a fresh start. */
export function noteModalBootRequested(box: ModalBox, at: number = Date.now()): void {
  boot.pendingSince[box] ??= at
}

/** The wake poll calls this when its poll for a box ends (answered, failed or
 *  aborted): no boot is pending from THIS process any more. */
export function noteModalBootEnded(box: ModalBox): void {
  delete boot.pendingSince[box]
}

/** When the current unanswered boot request for this box began, epoch ms, or
 *  `null` while none is pending. No `now` parameter: nothing here clears by
 *  age — the poll that stamped the clock clears it when it ends. */
export function modalBootPendingSince(box: ModalBox): number | null {
  return boot.pendingSince[box] ?? null
}

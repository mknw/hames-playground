/**
 * Verda control-plane probe — Server Only
 *
 * The warm clock in `verda-activity.server.ts` is **process-local**: a freshly
 * restarted app instance has never seen a call, and until now the header strip
 * could only say "unknown" about a box it had no reading on. This module is the
 * shared half of that answer: it asks the Verda control plane
 * (https://api.verda.com) how many replicas the deployment currently has, so a
 * user can tell cold from starting — and warm the box — BEFORE sending a first
 * message into a multi-minute wait.
 *
 * ## What the control plane is, and what it is not
 *
 * The control plane is the deployment's own orchestration API, the same one the
 * console uses. It knows whether the container exists; it does NOT know whether
 * the 27B weights are loaded inside it (measured ~360s, 2026-08-27). So its
 * answer maps to exactly two display states:
 *
 * - **empty replica list → `cold`.** Observed scaled-down, not guessed — this
 *   is the warm-to-cold regression the process-local clock could never see on
 *   its own.
 * - **non-empty → `starting`.** A replica present is NOT ready: the weight load
 *   happens inside the container, after the replica reports. Only a real
 *   completion answered by the deployment (`verdaWarmth`'s completion clock)
 *   may flip the strip to `ready` — never this probe, and never a timer.
 *
 * Probe result shape confirmed against the live OpenAPI schema
 * (https://api.verda.com/v1/openapi.json, 2026-08-29):
 * `GET /v1/container-deployments/{name}/replicas` →
 * `{ list: [{ id, status, started_at, … }] }`. The per-replica `status` field
 * (`initializing` / `running` / …) is deliberately NOT read: `running` there
 * means the container process is up, not that the model is loaded, and reading
 * it would invite exactly the ready-too-early bug this module exists to keep
 * out. The state machine asks for the count; the oldest `started_at` rides
 * along only because it is the one honest elapsed-time base for the `starting`
 * countdown.
 *
 * ## Deliberately NOT the inference endpoint
 *
 * This module NEVER touches `VERDA_INFERENCE_ENDPOINT` or
 * `VERDA_INFERENCE_API_KEY`. Waking the box is `ensureVerdaAwake`'s job (a
 * 1-token completion, the only probe that proves the weights are loaded); a
 * status check that sent a request to the model endpoint would scale the box
 * up — billing GPU seconds for a look. A source-scan test pins that no read of
 * an inference-endpoint variable appears in this file.
 *
 * ## Degradation
 *
 * Missing credentials, an HTTP error, a timeout or an unexpected body all
 * resolve to `{ ok: false }` rather than throwing: the strip then shows
 * `unknown` (the error path — it must be unreachable on every happy path) and
 * the ignite button stays available, because `igniteVerdaBox` is independent of
 * this probe. Messaging is never blocked by it. Both fetches are bounded at
 * {@link PROBE_TIMEOUT_MS} — a slow control plane degrades, never hangs the
 * strip. At most one `console.warn` per state transition: a reason that has
 * already been warned about stays quiet until it changes.
 *
 * ## Caching
 *
 * Two caches, both on a `globalThis` symbol (HMR-safe, the same pattern as the
 * warm clock), both process-local — one probe serves every user of THIS
 * instance:
 *
 * - **The OAuth token**, until shortly before its `expires_in` (a 60s safety
 *   margin), because the probe runs on every strip poll.
 * - **The probe result**, for {@link PROBE_CACHE_TTL_MS} — the control plane's
 *   replica list is not going to flip twice within one poll interval, and a
 *   3s-active poll must not turn into a 3s-active probe. Failures are cached
 *   for the same window, so a down control plane costs one bounded attempt per
 *   TTL rather than two per poll. Concurrent callers share one in-flight probe
 *   (the same dedupe shape `wake.server.ts` uses).
 *
 * No user id, no conversation id, no prompt, no content — the probe carries
 * deployment credentials and a deployment id, nothing else (SD-10).
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'

assertServerOnImport()

/** The control plane's base URL. Its own API, not the model endpoint. An env
 *  override exists for the same reason `VERDA_INFERENCE_ENDPOINT` is one: the
 *  hermetic browser suite points this at its fake, and a host can too. Read at
 *  module load — the dev server's environment is fixed at spawn, which is the
 *  only process that legitimately overrides it. */
export const VERDA_CONTROL_PLANE_BASE = (
  process.env.VERDA_CONTROL_PLANE_BASE ?? 'https://api.verda.com'
).replace(/\/$/, '')

/** How long ONE of the two fetches (token, replicas) is given. A slow control
 *  plane degrades the strip to `unknown`; it never hangs a poll that is supposed
 *  to be safe beside a live chat. */
export const PROBE_TIMEOUT_MS = 5_000

/** How long one probe result serves every caller of this process. Inside the
 *  10–15s band the design settled on: short enough that a cold → starting flip
 *  is seen within one settled poll, long enough that the 3s active poll rate
 *  mostly rides the cache. */
export const PROBE_CACHE_TTL_MS = 12_000

/** How early before `expires_in` a cached token is considered stale. */
const TOKEN_EXPIRY_MARGIN_S = 60

/** The two endpoints, from the live schema. */
const TOKEN_PATH = '/v1/oauth2/token'
const replicasPath = (deploymentId: string) =>
  `/v1/container-deployments/${encodeURIComponent(deploymentId)}/replicas`

/** One probe's answer. `ok: false` is the degraded result — the display maps it
 *  to `unknown` and the reason names why, once, in the console. */
export interface VerdaControlPlaneProbe {
  ok: boolean
  /** Number of replicas the deployment reports, when `ok`. `null` otherwise. */
  replicaCount: number | null
  /** When `ok` and the list carries parseable timestamps: the OLDEST replica's
   *  `started_at`, as epoch ms. The display's `starting` countdown subtracts
   *  this from the cold-start estimate — how long the container has actually
   *  been coming up is the one elapsed-time base the strip can observe, and a
   *  countdown re-sent whole on every 3s poll would snap back instead of
   *  falling. `null` when unknown (an unparsable timestamp, or a degraded
   *  result), in which case the estimate is sent whole. */
  oldestReplicaStartedAtMs: number | null
  /** When `!ok`: `missing-credentials`, `timeout`, `network: …`, `http <status>`,
   *  or `unexpected response shape`. For the console, not for the UI. */
  reason: string | null
  /** When this reading was taken (`Date.now()` of the completed probe). */
  at: number
}

/** Are the control-plane credentials present? Absence is a degraded mode, not
 *  a boot failure — the probe is never a hard requirement. */
export function verdaControlPlaneConfigured(): boolean {
  return Boolean(
    process.env.VERDA_CLIENT_ID &&
    process.env.VERDA_CLIENT_SECRET &&
    process.env.VERDA_DEPLOYMENT_ID,
  )
}

const CACHE_KEY = Symbol.for('kg-agent.verda-control-plane')
interface CacheState {
  token: { value: string; expiresAt: number } | null
  probe: { result: VerdaControlPlaneProbe; fetchedAt: number } | null
  inFlight: Promise<VerdaControlPlaneProbe> | null
  lastWarnedReason: string | null
}
type CacheGlobal = typeof globalThis & { [CACHE_KEY]?: CacheState }
const state: CacheState = ((globalThis as CacheGlobal)[CACHE_KEY] ??= {
  token: null,
  probe: null,
  inFlight: null,
  lastWarnedReason: null,
})

/** Test-only reset. Wipes both caches and the warn-once memory. */
export function resetControlPlaneCache(): void {
  state.token = null
  state.probe = null
  state.inFlight = null
  state.lastWarnedReason = null
}

/** At most one warn per state transition: the same reason twice in a row is a
 *  probe loop, not new information, and a top-bar poll that warns every 3s
 *  would drown every other log line. A reason that CHANGES is new information. */
function warnOnce(reason: string): void {
  if (state.lastWarnedReason === reason) return
  state.lastWarnedReason = reason
  console.warn(`[verda] control-plane probe unavailable (${reason}); the strip shows "unknown".`)
}

class ProbeFailed extends Error {}

/** One bounded `fetch`. Aborts at `timeoutMs`; transport errors and non-2xx
 *  become {@link ProbeFailed} with the reason the display will name. */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) throw new ProbeFailed(`${what} answered HTTP ${res.status}`)
    return res
  } catch (err) {
    if (err instanceof ProbeFailed) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProbeFailed(`${what} timed out after ${timeoutMs}ms`)
    }
    throw new ProbeFailed(
      `${what} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A valid OAuth token, from the cache or the token endpoint.
 *
 * Cached until `expires_in` minus a margin, so a token a poll grabs is not the
 * one that expires mid-request. A response without a usable `access_token` is a
 * shape failure, not a blank token — sending `Bearer undefined` to the API
 * would 401 one step later with the real cause already discarded.
 */
async function getAccessToken(timeoutMs: number): Promise<string> {
  const cached = state.token
  if (cached && Date.now() < cached.expiresAt) return cached.value

  const res = await boundedFetch(
    `${VERDA_CONTROL_PLANE_BASE}${TOKEN_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.VERDA_CLIENT_ID ?? '',
        client_secret: process.env.VERDA_CLIENT_SECRET ?? '',
      }),
    },
    timeoutMs,
    'the token endpoint',
  )
  const body: unknown = await res.json().catch(() => null)
  const token =
    typeof body === 'object' && body !== null && 'access_token' in body
      ? (body as { access_token: unknown }).access_token
      : null
  if (typeof token !== 'string' || token.length === 0) {
    throw new ProbeFailed('the token endpoint returned an unexpected response shape')
  }
  const expires_in =
    typeof body === 'object' && body !== null && 'expires_in' in body
      ? (body as { expires_in: unknown }).expires_in
      : null
  if (typeof expires_in === 'number' && Number.isFinite(expires_in) && expires_in > 0) {
    state.token = {
      value: token,
      expiresAt: Date.now() + Math.max(0, expires_in - TOKEN_EXPIRY_MARGIN_S) * 1000,
    }
  }
  return token
}

/**
 * The deployment's current replica state, from the control plane.
 *
 * Only the COUNT and the oldest `started_at` are read, never a per-replica
 * `status` — see the module docstring for why `running` on a replica is not
 * readiness.
 */
async function getReplicas(
  token: string,
  timeoutMs: number,
): Promise<{ count: number; oldestStartedAtMs: number | null }> {
  const deploymentId = process.env.VERDA_DEPLOYMENT_ID ?? ''
  const res = await boundedFetch(
    `${VERDA_CONTROL_PLANE_BASE}${replicasPath(deploymentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
    'the replicas endpoint',
  )
  const body: unknown = await res.json().catch(() => null)
  const list =
    typeof body === 'object' && body !== null && 'list' in body
      ? (body as { list: unknown }).list
      : null
  if (!Array.isArray(list)) {
    throw new ProbeFailed('the replicas endpoint returned an unexpected response shape')
  }
  // The earliest `started_at` on the list, when any of them parse. A single
  // unparsable timestamp is not a shape failure — the schema requires the
  // field, but a countdown base is a nicety, not a claim worth failing over.
  const started = list
    .map((r) =>
      typeof r === 'object' && r !== null && 'started_at' in r
        ? (r as { started_at: unknown }).started_at
        : null,
    )
    .filter((t): t is string => typeof t === 'string')
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t))
  return {
    count: list.length,
    oldestStartedAtMs: started.length > 0 ? Math.min(...started) : null,
  }
}

async function runProbe(): Promise<VerdaControlPlaneProbe> {
  try {
    const token = await getAccessToken(PROBE_TIMEOUT_MS)
    const { count, oldestStartedAtMs } = await getReplicas(token, PROBE_TIMEOUT_MS)
    return {
      ok: true,
      replicaCount: count,
      oldestReplicaStartedAtMs: oldestStartedAtMs,
      reason: null,
      at: Date.now(),
    }
  } catch (err) {
    const reason = err instanceof ProbeFailed ? err.message : String(err)
    return { ok: false, replicaCount: null, oldestReplicaStartedAtMs: null, reason, at: Date.now() }
  }
}

/**
 * The deployment's replica state, cached for {@link PROBE_CACHE_TTL_MS} and
 * shared by every caller in this process. NEVER throws — every failure mode is
 * the degraded `{ ok: false }` result, so a broken control plane costs the
 * strip its `unknown` display and nothing else.
 */
export async function probeVerdaReplicas(): Promise<VerdaControlPlaneProbe> {
  if (!verdaControlPlaneConfigured()) {
    warnOnce('missing-credentials')
    return {
      ok: false,
      replicaCount: null,
      oldestReplicaStartedAtMs: null,
      reason: 'missing-credentials',
      at: Date.now(),
    }
  }

  const cached = state.probe
  if (cached && Date.now() - cached.fetchedAt < PROBE_CACHE_TTL_MS) return cached.result

  // Concurrent callers share one in-flight probe (a burst of strip polls after
  // TTL expiry is one pair of fetches, not one per poll). The cache is written
  // by the probe itself, so the next caller after it settles reads the cache.
  state.inFlight ??= runProbe().finally(() => {
    state.inFlight = null
  })
  const result = await state.inFlight

  state.probe = { result, fetchedAt: Date.now() }
  if (!result.ok && result.reason) warnOnce(result.reason)
  return result
}

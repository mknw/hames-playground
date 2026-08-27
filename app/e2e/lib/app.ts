/**
 * Booting the app path, once, in the right order.
 *
 * ORDER IS THE WHOLE POINT OF THIS FILE. Two things in `src/` read their
 * configuration at MODULE LOAD rather than per call:
 *
 *   - `mcp-client.server.ts` freezes `MCP_GATEWAY_URL` into a `const`.
 *   - `clients.server.ts` runs `assertVerdaConfigured()` at import when
 *     `USE_VERDA_INFERENCE=1`.
 *
 * So every app module is reached through a dynamic `import()` inside
 * {@link bootApp}, after the fakes are listening and `process.env` has been
 * pointed at them. A scenario that statically imported an app module at the top
 * of its file would load it before any of that, connect to whatever is on
 * :8811, and fail in a way that looks like an app bug. Scenarios import from
 * `e2e/lib/*` only.
 *
 * What comes back is a small surface — the two real entry points a chat turn
 * takes, plus the persistence reads a scenario needs to check its work. There
 * is no wrapper logic in between: `runTurn` calls the server action the browser
 * calls, and `runTurnOverSse` calls the route handler the browser POSTs to.
 */

import {
  IS_HERMETIC,
  IS_LIVE,
  HERMETIC_ANTHROPIC_KEY,
  TURN_TIMEOUT_MS,
  WAKE_ATTEMPT_TIMEOUT_MS,
} from './mode'
import { startFakeLlm, type FakeLlm } from './fake-llm'
import { startFakeGateway, type FakeGateway } from './fake-gateway'
import { installHermeticRouting, assertHermeticRouting } from './baml-route'

// ============================================================================
// Types the scenarios use
// ============================================================================

/** One SSE frame, as the browser's `EventSource` would see it. */
export interface SseFrame {
  /** The `event:` name, or `message` for an unnamed data frame. */
  event: string
  data: Record<string, unknown>
  /** `Date.now()` when this reader saw the frame. Frames arrive in order
   *  regardless, so this is not for sequencing — it is for the scenarios whose
   *  claim is about WHEN inside a wait a frame landed (scenario 8: the
   *  cold-start notice reaches the user during the wait, not after it). */
  at: number
}

export interface AppHandles {
  /** The interactive server action — `actions.server.ts#processMessageWithAgent`. */
  runTurn(sessionId: string, message: string, agentId?: string): Promise<TurnResult>
  /** The SSE route — `routes/api/events.ts#POST`. Returns every frame it sent,
   *  in order, plus the HTTP status so a rejected request is visible. */
  runTurnOverSse(body: Record<string, unknown>): Promise<{ status: number; frames: SseFrame[] }>
  /** Set the user's stored inference tier, which is what the header switch
   *  writes and what `runTurnAndPersist` reads once per turn. */
  setTier(tier: 'anthropic' | 'verda'): Promise<void>
  /** The persisted row for a conversation, or null. */
  readRow(sessionId: string): Promise<StoredRow | null>
  /** Delete every row this suite's user owns. Test database only. */
  wipe(): Promise<void>
  /**
   * Forget that this process ever saw the self-hosted box answer, so the next
   * private-tier turn treats it as asleep and polls it awake.
   *
   * NEEDED BECAUSE THIS SUITE IS ONE PROCESS (`isolate: false`, deliberately —
   * see `e2e/vitest.config.ts`), and the warm clock is process state with a
   * 300s default window. The poll's answered attempt stamps that clock, which is
   * correct in production and means the SECOND scenario to want a cold box
   * would silently get a warm one: no poll, so nothing to arm a cold start on
   * and nothing to assert about sharing one. The suite used to get "cold" by
   * accident — the usage observer that stamps the clock is installed in
   * `middleware.ts`, which these scenarios do not load — and #279 made the wake
   * itself stamp it, which turned the accident into a visible failure.
   *
   * Call it in `beforeEach` of any scenario whose subject is the cold path. It
   * models exactly one thing: the box went to sleep and this process has not
   * seen a call since.
   */
  goToSleep(): Promise<void>
  /** The id every turn runs as (the dev-bypass user). */
  readonly userId: string
  readonly fakeLlm: FakeLlm
  readonly fakeGateway: FakeGateway
}

/** The shape of a harness result, narrowed to what a scenario asserts on. */
export interface TurnResult {
  response?: string
  status?: string
  duration_ms?: number
  context?: { events?: Array<{ type: string; data?: unknown }>; status?: string }
}

export interface StoredRow {
  agentId: string
  status: string
  title: string | null
  serializedContext: string
}

// ============================================================================
// Boot
// ============================================================================

let booted: Promise<AppHandles> | null = null

/**
 * Boot once per process and share it. `vitest.config.ts` pins the suite to a
 * single fork precisely so this can be a process-wide singleton: two forks
 * would mean two fakes, two pattern caches and two views of one database.
 *
 * There is deliberately NO matching teardown. A singleton shared across files
 * has no correct place to be closed from: any file's `afterAll` would take the
 * fakes and the pg pool away from the files still to run, and vitest offers no
 * per-fork hook that runs after the last of them (`globalSetup` runs in the
 * main process, not here). So process exit is the teardown — which is what
 * already happened, since the `close()` this used to expose was never called
 * from anywhere. Each scenario file cleans up what it actually owns: its rows.
 */
export function bootApp(): Promise<AppHandles> {
  booted ??= boot()
  return booted
}

async function boot(): Promise<AppHandles> {
  // ---- Credentials -------------------------------------------------------
  // Live mode needs the real ones, and vitest does not load `.env` into
  // `process.env` (Vite only lifts `VITE_*` into `import.meta.env`), so the
  // file is read explicitly — and ONLY in live mode, so a hermetic run cannot
  // pick up a real key by accident.
  if (IS_LIVE) {
    process.loadEnvFile('.env')
    for (const name of [
      'ANTHROPIC_API_KEY',
      'VERDA_INFERENCE_ENDPOINT',
      'VERDA_INFERENCE_API_KEY',
      // The private tier's 4B summarizer. Required in live mode for the same
      // reason as the two above: the tier is refused without it, so a live run
      // would fail every private-tier turn on a missing var rather than on
      // anything about the deployment.
      'SMALL_LLM_BASE_URL',
    ]) {
      if (!process.env[name]) {
        throw new Error(`E2E_LIVE=verda needs ${name} in app/.env (see app/.env.example).`)
      }
    }
  }

  // ---- Fakes -------------------------------------------------------------
  // The gateway is faked in BOTH modes: the live run is a measurement of the
  // inference route, and letting it also depend on Docker, Neo4j and whatever
  // a developer's graph happens to contain would make a red result
  // uninterpretable.
  const fakeGateway = await startFakeGateway()
  process.env.MCP_GATEWAY_URL = fakeGateway.url

  const fakeLlm = await startFakeLlm()
  if (IS_HERMETIC) {
    // The shipped seam: `VerdaQwen` reads this per call. The `/v1` suffix is
    // required by `assertVerdaConfigured()`, which still runs.
    process.env.VERDA_INFERENCE_ENDPOINT = fakeLlm.baseUrl
    process.env.VERDA_INFERENCE_API_KEY = 'e2e-fake-key'
    // The private tier's SECOND model since 2026-08-26: `describe` runs on the 4B
    // `LocalQwenSmall`, and the tier is refused outright without this. Pointed at
    // the SAME fake, which is what lets a scenario tell the two apart — the fake
    // records the `model` field, so a describe call arrives as the 4B's id and a
    // controller call as the 27B's.
    process.env.SMALL_LLM_BASE_URL = fakeLlm.baseUrl
    process.env.SMALL_LLM_API_KEY = 'e2e-fake-key'
    // Poison the real credential — see HERMETIC_ANTHROPIC_KEY.
    process.env.ANTHROPIC_API_KEY = HERMETIC_ANTHROPIC_KEY
    // The wake is a POLL since 2026-08-27, and its shipped per-attempt bound
    // (30s) would cut every one of this fake's injected delays into attempt
    // slices — see WAKE_ATTEMPT_TIMEOUT_MS for why that would make scenarios 3,
    // 4 and 8 measure the poll's cadence instead of the thing each is named for.
    process.env.VERDA_WAKE_ATTEMPT_TIMEOUT_MS = String(WAKE_ATTEMPT_TIMEOUT_MS)
  }
  // Never the process default: every scenario decides its tier per user, the
  // way the header switch does, so a stray deployment default would mask a
  // broken preference read.
  delete process.env.USE_VERDA_INFERENCE

  // ---- Routing -----------------------------------------------------------
  const { b } = await import('../../baml_client')
  if (IS_HERMETIC) {
    installHermeticRouting(b, fakeLlm.baseUrl)
    await assertHermeticRouting(
      () => b.GenerateConversationTitle('e2e preflight'),
      () => fakeLlm.calls.length,
    )
    fakeLlm.reset()
  }

  // ---- App modules (only now) -------------------------------------------
  const actions = await import('../../src/lib/harness-client/actions.server')
  const events = await import('../../src/routes/api/events')
  const prefs = await import('../../src/lib/db/user-prefs.server')
  const conversations = await import('../../src/lib/db/conversations.server')
  const dbClient = await import('../../src/lib/db/client.server')
  const { BYPASS_USER, isBypassEnabled } = await import('../../src/lib/auth/dev-bypass')

  // The suite runs as the dev-bypass user (`SD-15`): both halves of that gate
  // have to be on, and one of them is a Vite compile-time constant, so a
  // config change that stopped reaching `import.meta.env` would otherwise
  // surface as every scenario 401ing.
  if (!isBypassEnabled()) {
    throw new Error(
      'e2e: the dev auth bypass is off, so every turn would 401. vitest.config.ts sets ' +
        'VITE_DEV_BYPASS_AUTH=true — check it reached import.meta.env.',
    )
  }

  const userId = BYPASS_USER.id

  return {
    userId,
    fakeLlm,
    fakeGateway,

    async runTurn(sessionId, message, agentId = 'search') {
      return withTimeout(
        actions.processMessageWithAgent(sessionId, message, agentId) as Promise<TurnResult>,
        `runTurn(${sessionId})`,
      )
    },

    async runTurnOverSse(body) {
      const request = new Request('http://e2e.invalid/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // The handler only ever touches `event.request`, so the rest of the
      // SolidStart APIEvent is not fabricated — a fuller fake would be a
      // second implementation of the framework, not a better test.
      const response = await withTimeout(
        events.POST({ request } as Parameters<typeof events.POST>[0]),
        'runTurnOverSse',
      )
      return { status: response.status, frames: await readSse(response) }
    },

    async setTier(tier) {
      await prefs.setStoredInferenceTier(userId, tier)
    },

    async readRow(sessionId) {
      const row = await conversations.loadConversation(sessionId, userId)
      if (!row) return null
      return {
        agentId: row.agentId,
        status: row.status,
        title: row.title,
        serializedContext: row.serializedContext,
      }
    },

    async goToSleep() {
      const activity = await import('../../src/lib/inference/verda-activity.server')
      const wake = await import('../../src/lib/inference/wake.server')
      activity.resetVerdaActivity()
      // And drop any ping still parked on the shared symbol, so a scenario that
      // just failed one does not attach to its rejected promise.
      wake.resetVerdaWake()
    },

    async wipe() {
      await dbClient.query('DELETE FROM conversations WHERE user_id = $1', [userId])
    },
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read an SSE response to completion.
 *
 * The route closes its own stream from `onSettled`, so this terminates without
 * a timeout of its own — and if it ever does not, {@link withTimeout} around
 * the handler call is what fails, naming the turn rather than hanging the run.
 */
async function readSse(response: Response): Promise<SseFrame[]> {
  if (!response.body) return []
  const frames: SseFrame[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split: number
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const frame = parseFrame(raw)
      if (frame) frames.push(frame)
    }
  }
  const tail = parseFrame(buffer)
  if (tail) frames.push(tail)
  return frames
}

function parseFrame(raw: string): SseFrame | null {
  const at = Date.now()
  const lines = raw.split('\n').filter(Boolean)
  if (lines.length === 0) return null
  let event = 'message'
  const data: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (data.length === 0) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) as Record<string, unknown>, at }
  } catch {
    return { event, data: { raw: data.join('\n') }, at }
  }
}

/** Bound every app-path call, so a hung turn names itself instead of taking
 *  the whole file down with vitest's generic timeout. */
async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`e2e: ${label} exceeded ${TURN_TIMEOUT_MS}ms`)),
          TURN_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A fresh conversation id. Prefixed so a stray row is identifiable in the
 *  test database. */
export function newSessionId(label: string): string {
  return `e2e-${label}-${Math.random().toString(36).slice(2, 10)}`
}

/** Every event of one type in a persisted context blob. */
export function eventsOfType(
  serializedContext: string,
  type: string,
): Array<Record<string, unknown>> {
  const ctx = JSON.parse(serializedContext) as {
    events?: Array<{ type: string; data?: Record<string, unknown> }>
  }
  return (ctx.events ?? []).filter((e) => e.type === type).map((e) => e.data ?? {})
}

/**
 * Block until the LAST turn's detached summarization has landed.
 *
 * WHY THIS EXISTS (#280/#285). `runTurnAndPersist` starts `compactAndSave`
 * DETACHED — deliberately, so the answer reaches the user before the
 * summarization of its tool results is paid for. The turn therefore resolves
 * while a describe-role call is still on its way to the fake, and the fake is a
 * process-wide singleton with ONE call log that scenarios clear between tests.
 *
 * That made `fakeLlm.reset()` a race rather than a boundary: a describe call
 * started by the previous test could be recorded AFTER the reset and read as
 * this test's. In `05-tier-switch` that is a routing assertion reading a call
 * made under the other tier — the turn that leaked it was correct, the turn
 * being asserted on was correct, and the test was red. Red in 2 of 6 runs, and
 * green on every re-run, because the leak window is the few milliseconds
 * between a turn resolving and the next test starting.
 *
 * The fix is #283's first pattern: replace the deadline with a fact. The last
 * thing `compactBulkData` does is write the summaries onto the tool_result
 * events and persist the blob — so a persisted row in which the current turn's
 * successful tool results all carry a summary is PROOF that the detached work
 * has finished, and therefore that its calls are already in the log rather than
 * still in flight. Waiting for the row is waiting for the same event the fake's
 * log was being polled for, minus the ambiguity about which test made the call.
 *
 * SCOPED TO THE LAST TURN, because that is exactly what `compactBulkData`
 * summarizes (it slices from the last `user_message`) — and because an earlier
 * turn's summaries do not necessarily survive: each turn ends by writing back
 * the context it loaded when it STARTED, so a turn that began before the
 * previous turn's detached persist lands overwrites it. So **call this after
 * every turn**, not once at the end of a multi-turn scenario: after each turn it
 * is a fact about that turn, and calling it in the loop is also what keeps the
 * earlier turns' summaries in the blob.
 *
 * Vacuously true for a turn that called no tools, which is correct: there is no
 * detached call to wait for (`compactBulkData` returns before its persist when
 * there is nothing to summarize).
 *
 * The timeout is a FUSE. Nothing should reach it; a run that does has a
 * summarization that never ran, which is what the message says.
 */
export async function settleSummaries(
  app: AppHandles,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await app.readRow(sessionId)
    const pending = row ? unsummarizedInLastTurn(row.serializedContext) : -1
    if (pending === 0) return
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: ${pending} tool result(s) from the last turn of ${sessionId} were still ` +
          `unsummarized after ${timeoutMs}ms. The detached compactAndSave either never ran ` +
          "or never persisted, so no scenario can tell its calls apart from the next test's.",
      )
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** How many of the LAST turn's successful tool results still want a summary —
 *  the same slice and the same filters `compactBulkData` applies. */
function unsummarizedInLastTurn(serializedContext: string): number {
  const ctx = JSON.parse(serializedContext) as {
    events?: Array<{ type: string; data?: Record<string, unknown> }>
  }
  const events = ctx.events ?? []
  let turnStart = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') {
      turnStart = i
      break
    }
  }
  return events
    .slice(turnStart)
    .filter((e) => e.type === 'tool_result')
    .map((e) => e.data ?? {})
    .filter((d) => d.success === true && !d.hidden && !d.archived && !d.summary).length
}

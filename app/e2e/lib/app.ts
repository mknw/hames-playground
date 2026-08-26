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

import { IS_HERMETIC, IS_LIVE, HERMETIC_ANTHROPIC_KEY, TURN_TIMEOUT_MS } from './mode'
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
    // Poison the real credential — see HERMETIC_ANTHROPIC_KEY.
    process.env.ANTHROPIC_API_KEY = HERMETIC_ANTHROPIC_KEY
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

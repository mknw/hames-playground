// The composition root registers the harness client seam (tier policy, model
// tables, cost rates); these tests exercise scopes/rates/windows, so they run
// the same wiring a production turn takes.
import '../../../lib/inference/config.server'
/**
 * `runTurnAndPersist` (`lib/harness-client/turn.server.ts`) — the one
 * implementation of "run a harness turn and persist it" (#226 C5).
 *
 * The harness, the pattern cache, the Postgres layer and the title agent are
 * mocked; what is asserted is the recipe itself, per mode: which context the
 * turn runs on, the scopes it opens, the order it delivers in, what it persists
 * (twice — the turn, then the summaries), and that a failure always leaves the
 * row in a terminal state.
 *
 * The `triggered` block doubles as the regression suite for the drift C5 found:
 * the background path used to skip `compactBulkData` outright, and had no
 * settings scope at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ── harness-patterns: a fake harness whose runs are observable ──────────────
import {
  getRequestUserId,
  getRequestSessionId,
  isAttendedRequest,
} from '../../../lib/harness-client/request-user.server'
import { runtimeConfig } from '@hames-ai/harness-patterns/runtime-config.server'
import { DEFAULT_SETTINGS } from '../../../lib/settings'

/** Every run records the ambient scope it saw. */
const seenScopes: Array<{ userId: string | null; sessionId: string | null }> = []
/** …and whether that scope said a person is waiting on it (all three entry
 *  points record here, `resumeHarness` included). */
const seenAttended: boolean[] = []

type Ctx = { id: string; events: unknown[] }
const runFresh = vi.fn(
  async (message: string, sessionId: string, _data?: unknown, _onEvent?: unknown) => {
    seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
    seenAttended.push(isAttendedRequest())
    return {
      response: `fresh:${message}`,
      serialized: `serialized:${sessionId}`,
      data: {},
      context: { id: `ctx:${sessionId}`, events: [] } as Ctx,
      status: 'running',
    }
  },
)
const harness = vi.fn(() => runFresh)
const continueSession = vi.fn(
  async (serialized: string, _p: unknown, message: string, _onEvent?: unknown) => {
    seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
    seenAttended.push(isAttendedRequest())
    return {
      response: `continued:${message}`,
      serialized: `${serialized}+${message}`,
      data: {},
      context: { id: 'ctx:continued', events: [] } as Ctx,
      status: 'running',
    }
  },
)
const resumeHarness = vi.fn(async (_s: string, _p: unknown, approved: boolean) => {
  seenAttended.push(isAttendedRequest())
  return {
    response: approved ? 'approved' : 'rejected',
    serialized: `resumed:${approved}`,
    data: {},
    context: { id: 'ctx:resumed', events: [] } as Ctx,
    status: 'running',
  }
})
const createContext = vi.fn((message: string, _data: unknown, sessionId: string) => ({
  sessionId,
  events: [{ type: 'user_message', data: { content: message } }],
}))
const serializeContext = vi.fn((ctx: unknown) => JSON.stringify(ctx))
/** Stands in for the real compaction: mutates nothing, but persists like it. */
const compactBulkData = vi.fn(async (_ctx: unknown, onPersist: () => Promise<void>) => {
  await onPersist()
})

/** The real one's shape; the id is fixed so a test can find the event it made. */
const createEvent = vi.fn((type: string, patternId: string, data: unknown) => ({
  id: 'ev-warning',
  type,
  ts: 0,
  patternId,
  data,
}))

vi.mock('@hames-ai/harness-patterns', async () => {
  // The trailing save's merge works on real contexts, so it gets the real
  // helpers; everything that runs a turn stays fake.
  const real = await vi.importActual<typeof import('@hames-ai/harness-patterns/context.server')>(
    '@hames-ai/harness-patterns/context.server',
  )
  return {
    harness,
    continueSession,
    resumeHarness,
    createContext,
    serializeContext,
    compactBulkData,
    createEvent,
    deserializeContext: real.deserializeContext,
    enrichToolResult: real.enrichToolResult,
  }
})

// ── the run frame: the REAL one, with every frame this runner opens recorded ─
//
// #374 replaced three scopes here (`runWithRequestContext` aside) with one run
// frame carrying five slots, so the two recorders this file used to keep —
// one for settings, one for the tier — are one. The per-conversation switch
// acts through the frame's `inference` slot and nowhere else, which is why the
// turn runner is where "the user's preference actually steers the run" is
// provable.
type OpenedFrame = {
  config?: { maxResultForSummary?: number }
  inference?: { tier?: string }
  live?: unknown
}
const openedFrames: OpenedFrame[] = []
vi.mock('@hames-ai/harness-patterns/run-frame.server', async () => {
  const actual = await vi.importActual<
    typeof import('@hames-ai/harness-patterns/run-frame.server')
  >('@hames-ai/harness-patterns/run-frame.server')
  return {
    ...actual,
    withRunFrame: (frame: never, fn: () => Promise<unknown>) => {
      openedFrames.push(frame as OpenedFrame)
      return actual.withRunFrame(frame, fn)
    },
    amendRunFrame: (frame: never, fn: () => Promise<unknown>) => {
      amendedFrames.push(frame as OpenedFrame)
      return actual.amendRunFrame(frame, fn)
    },
  }
})
/** What was amended BELOW the turn frame — today only the live listener, which
 *  is scoped to the main run so a sidecar cannot inherit the user's wire. */
const amendedFrames: OpenedFrame[] = []

/** The tier each opened frame named — the successor of `tierScopes`. */
const tierScopes = {
  get value(): (string | undefined)[] {
    return openedFrames.map((f) => f.inference?.tier)
  },
}

const resolveConversationTier = vi.fn<
  (sessionId: string, userId: string) => Promise<'verda' | 'anthropic'>
>(async () => 'anthropic')
vi.mock('../../../lib/inference/tier.server', () => ({
  resolveConversationTier: (sessionId: string, userId: string) =>
    resolveConversationTier(sessionId, userId),
}))

const beginVerdaTurn = vi.fn()
const endVerdaTurn = vi.fn()
vi.mock('../../../lib/inference/verda-activity.server', () => ({
  beginVerdaTurn: () => beginVerdaTurn(),
  endVerdaTurn: () => endVerdaTurn(),
  // The cold-start watch reads these three to decide whether a wait is worth
  // announcing. Stubbed as a box nobody has called ("starting", never seen), so
  // a turn that arms a watch actually fires its notice — otherwise the
  // concurrent-wake test below would pass by announcing nothing at all.
  verdaWarmth: () => ({ state: 'starting', secondsUntilScaledown: null }),
  verdaLastCallCompletedAt: () => null,
  verdaScaledownSeconds: () => 300,
  // The name `clientOverrideFor` compares against to decide whether a bag is
  // about to wait on the scale-to-zero box.
  VERDA_CLIENT_NAME: 'VerdaQwen',
}))

// The wake ping is MOCKED here, and the split is deliberate: what this file owns
// is the turn's scope plumbing — is the box woken before the harness runs, on the
// right tier, and does a failure end the turn — while `verda-wake.test.ts` owns
// what the ping puts on the wire and how it dedupes. Running the real one here
// would open a socket from a scope test.
const ensureVerdaAwake = vi.fn(async () => {})
vi.mock('../../../lib/inference/wake.server', () => ({
  ensureVerdaAwake: () => ensureVerdaAwake(),
}))

const recordTurn = vi.fn()
vi.mock('../../../lib/metrics/usage-recorder.server', () => ({
  recordTurn: (tier: string) => recordTurn(tier),
}))

// ── session.server (pattern cache + persistence) ────────────────────────────
type Loaded = {
  serializedContext: string
  agentId: string
  kind: string
  status: string
  /** The version the turn's claim holds. */
  version: string
} | null
/** The turn's load is its claim (#458): one statement takes the row and reads it. */
const claimSession = vi.fn<(id: string, userId: string) => Promise<Loaded>>(async () => null)
/** The end-of-turn save hands back the version it wrote. */
const saveSession = vi.fn<(...args: unknown[]) => Promise<string | void>>(async () => 'v-saved')
const getOrBuildPatterns = vi.fn(async (_s: string, agentId: string) => [`patterns:${agentId}`])
vi.mock('../../../lib/harness-client/session.server', () => ({
  claimSession,
  saveSession,
  getOrBuildPatterns,
  // The composition root's deps bag — the title generator takes it now.
  agentDeps: () => ({}),
}))

// ── db/conversations ────────────────────────────────────────────────────────
/** Creates a brand-new conversation's row, claimed by the turn creating it. */
const dbCreateConversation = vi.fn<(row: Record<string, unknown>) => Promise<string | void>>(
  async () => 'v-seed',
)
const dbReleaseConversationClaim = vi.fn<
  (id: string, userId: string, version: string, opts?: { failed?: boolean }) => Promise<boolean>
>(async () => true)
const dbRenewConversationClaim = vi.fn<
  (id: string, userId: string, version: string) => Promise<boolean>
>(async () => true)
/** The trailing pass's write: at a version, and only while no turn holds the row. */
const dbUpdateContextIfUnchanged = vi.fn<
  (id: string, userId: string, serialized: string, version: string) => Promise<boolean>
>(async () => true)
const dbLoadConversation = vi.fn<
  (id: string, userId: string) => Promise<{ serializedContext: string; version: string } | null>
>(async () => null)
const TURN_CLAIM_RENEW_MS = 30_000
vi.mock('../../../lib/db/conversations.server', () => ({
  createConversation: dbCreateConversation,
  releaseConversationClaim: dbReleaseConversationClaim,
  renewConversationClaim: dbRenewConversationClaim,
  updateConversationContextIfUnchanged: dbUpdateContextIfUnchanged,
  loadConversation: dbLoadConversation,
  TURN_CLAIM_RENEW_MS,
  TURN_CLAIM_TTL_SECONDS: 120,
  deriveTitle: (s: string) => s.slice(0, 10),
}))

/** Releases that also marked the turn failed — the row's flip to 'error'. */
const flippedToError = () => dbReleaseConversationClaim.mock.calls.filter((c) => c[3]?.failed)

// ── title agent ─────────────────────────────────────────────────────────────
const runFirstTurnTitleGen = vi.fn<() => Promise<string | null>>(async () => null)
vi.mock('@hames-ai/agents/agents/title-generator.server', () => ({
  runFirstTurnTitleGen: (...a: unknown[]) => runFirstTurnTitleGen(...(a as [])),
}))

const { runTurnAndPersist, TITLE_GEN_TIMEOUT_MS, mergeTrailingPass } =
  await import('../../../lib/harness-client/turn.server')

const TRIGGER = { transcribedCommand: 'do it', shortDescription: 'Do it' }

/** The trailing summarization is detached (nobody waits on a describe call), so
 *  give it a macrotask to land before asserting on it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A stored, resumable row for (`sess`, agent `search`). */
const STORED: Loaded = {
  serializedContext: 'ctx-a',
  agentId: 'search',
  kind: 'conversation',
  status: 'done',
  version: 'v-claim',
}

let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  seenScopes.length = 0
  seenAttended.length = 0
  openedFrames.length = 0
  amendedFrames.length = 0
  // The real `runWithInferenceTier` is used (only the recording is a wrapper),
  // and it refuses the `verda` position unless the endpoint is configured —
  // fail-closed, by design. Fakes: nothing here opens a socket, and the
  // endpoint only has to satisfy the shape check.
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  // The private tier is two models, and the scope refuses to open without both.
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
  ensureVerdaAwake.mockResolvedValue(undefined)
  resolveConversationTier.mockResolvedValue('anthropic')
  claimSession.mockResolvedValue(null)
  saveSession.mockResolvedValue('v-saved')
  dbCreateConversation.mockResolvedValue('v-seed')
  dbReleaseConversationClaim.mockResolvedValue(true)
  dbRenewConversationClaim.mockResolvedValue(true)
  dbUpdateContextIfUnchanged.mockResolvedValue(true)
  dbLoadConversation.mockResolvedValue(null)
  runFirstTurnTitleGen.mockResolvedValue(null)
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  // Drain any detached summarization still in flight, so it cannot land in the
  // middle of the next test.
  await flush()
  logged.mockRestore()
  delete process.env.VERDA_INFERENCE_ENDPOINT
  delete process.env.VERDA_INFERENCE_API_KEY
  delete process.env.SMALL_LLM_BASE_URL
})

function interactive(over: Record<string, unknown> = {}) {
  return {
    mode: 'interactive' as const,
    sessionId: 'sess-1',
    userId: 'user-1',
    agentId: 'search',
    message: 'hello world, this is long',
    ...over,
  }
}

describe('interactive turns', () => {
  it('pre-seeds the sidebar row before running a brand-new conversation (#105)', async () => {
    const result = await runTurnAndPersist(interactive())

    expect(dbCreateConversation).toHaveBeenCalledTimes(1)
    const seeded = dbCreateConversation.mock.calls[0][0]
    expect(seeded).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
      agentId: 'search',
      status: 'running',
      title: 'hello worl',
      // The row it creates RECORDS the tier this turn resolved. For a brand-new
      // chat that value came from the user's last-used seed, and writing it here
      // is what stops the conversation following a later flip made in a
      // different thread — the whole point of the tier being per conversation.
      inferenceTier: 'anthropic',
    })
    expect(dbCreateConversation.mock.invocationCallOrder[0]).toBeLessThan(
      runFresh.mock.invocationCallOrder[0],
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(result.response).toBe('fresh:hello world, this is long')
    expect(saveSession).toHaveBeenCalledWith('sess-1', 'user-1', 'search', 'serialized:sess-1', {
      version: 'v-seed',
      inferenceTier: 'anthropic',
    })
  })

  it('continues a stored context instead of re-running it fresh', async () => {
    claimSession.mockResolvedValue(STORED)

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-2', message: 'follow up' }),
    )

    expect(dbCreateConversation).not.toHaveBeenCalled() // no re-seed for a known row
    expect(harness).not.toHaveBeenCalled()
    // Three arguments, no listener: #374 moved the live listener into the run
    // frame this runner opens, and a nested entry that brought a slot of its
    // own would be refused.
    expect(continueSession).toHaveBeenCalledWith('ctx-a', ['patterns:search'], 'follow up')
    expect(result.response).toBe('continued:follow up')
    expect(saveSession).toHaveBeenCalledWith('sess-2', 'user-1', 'search', 'ctx-a+follow up', {
      version: 'v-claim',
      inferenceTier: 'anthropic',
    })
  })

  it('starts fresh when the agent changed under an existing sessionId', async () => {
    claimSession.mockResolvedValue(STORED)

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-3', agentId: 'general', message: 'hi' }),
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-3', 'general')
    expect(result.response).toBe('fresh:hi')
    expect(saveSession).toHaveBeenCalledWith('sess-3', 'user-1', 'general', 'serialized:sess-3', {
      version: 'v-claim',
      inferenceTier: 'anthropic',
    })
  })

  // 2026-10-03: the two sandbox agents became one, and the claim's load maps a
  // stored legacy id forward. A tab loaded before that deploy still SENDS the
  // old id, so the requested id has to be mapped the same way: compared raw,
  // 'sandbox-session' !== 'sandbox' reads as an agent switch, the turn starts
  // fresh, and its save replaces the conversation with this one message.
  //
  // MUTATION: drop `canonicalAgentId` from `planTurn` → `harness` runs fresh
  // and every assertion below reddens.
  it('continues a stored conversation when the request names its agent by a legacy id', async () => {
    claimSession.mockResolvedValue({ ...STORED, agentId: 'sandbox' })

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-legacy', agentId: 'sandbox-session', message: 'and now?' }),
    )

    expect(harness).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-legacy', 'sandbox')
    expect(result.response).toBe('continued:and now?')
    expect(saveSession).toHaveBeenCalledWith('sess-legacy', 'user-1', 'sandbox', 'ctx-a+and now?', {
      version: 'v-claim',
      inferenceTier: 'anthropic',
    })
  })

  it('exposes the user + conversation to the run as ambient request scope', async () => {
    await runTurnAndPersist(interactive({ sessionId: 'sess-4' }))
    expect(seenScopes).toEqual([{ userId: 'user-1', sessionId: 'sess-4' }])
  })

  it('puts onEvent in the run frame and delivers its hooks in order', async () => {
    const order: string[] = []
    const onEvent = vi.fn()
    claimSession.mockResolvedValue(STORED)
    runFirstTurnTitleGen.mockResolvedValue('A title')
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      order.push('compact')
      await persist()
    })

    await runTurnAndPersist(
      interactive({
        onEvent,
        onResult: () => order.push('result'),
        onTitle: () => order.push('title'),
        onSettled: () => order.push('settled'),
      }),
    )

    await flush()
    // The listener rides the RUN's frame, not the turn's: `runAndSave` amends it
    // around `run(patterns)` and the turn frame's `live` slot stays empty. This
    // assertion used to read `expect(openedFrames[0].live).toBe(onEvent)` and
    // that is exactly what pinned the sidecar leak in — see the dedicated test
    // below, and `run-frame-sidecar.test.ts` for the mechanism.
    expect(openedFrames[0].live).toBeUndefined()
    expect(amendedFrames.map((f) => f.live)).toEqual([onEvent])
    expect(continueSession.mock.calls[0]).toHaveLength(3)
    expect(order).toEqual(['result', 'title', 'settled', 'compact'])
  })

  // B1, PR #382 review. The turn starts a SECOND harness run inside itself —
  // the first-turn title agent — between `done` and the stream closing. Its
  // whole contract is that it fails silently ("all return null … No retry, no
  // error event"), so it must not be holding the SSE writer: on the first head
  // of this PR the listener sat in the TURN frame, `enterRun` handed it to the
  // sidecar, and a failed title generation painted an inline error bubble in
  // the user's transcript.
  //
  // MUTATION: move `live` back into `runTurnAndPersist`'s `withRunFrame` bag →
  // the sidecar sees the listener and the first assertion reddens. The
  // mechanism-level twin is `run-frame-sidecar.test.ts` in the package.
  it('does not hand the SSE listener to the title agent it starts', async () => {
    const onEvent = vi.fn()
    let sidecarLive: unknown = 'not-run'
    let sidecarTier: unknown
    let sidecarBudget: unknown
    runFirstTurnTitleGen.mockImplementation(async () => {
      const { currentRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
      const frame = currentRunFrame()
      sidecarLive = frame?.live
      sidecarTier = frame?.inference?.tier
      sidecarBudget = frame?.config?.maxResultForSummary
      return 'A title'
    })

    await runTurnAndPersist(interactive({ onEvent }))
    await flush()

    // The wire to the user is the main run's, and the sidecar has none.
    expect(sidecarLive).toBeUndefined()
    // What it DOES keep is the turn — SA-M13's reason for opening the frame up
    // here at all. Dropping those would be the opposite overcorrection.
    expect(sidecarTier).toBe('anthropic')
    expect(sidecarBudget).toBe(DEFAULT_SETTINGS.maxResultForSummary)
  })

  it('emits the generated title, and stays quiet when there is none', async () => {
    const onTitle = vi.fn()
    runFirstTurnTitleGen.mockResolvedValue('Quarterly numbers')
    await runTurnAndPersist(interactive({ onTitle }))
    expect(onTitle).toHaveBeenCalledWith('Quarterly numbers')

    onTitle.mockClear()
    runFirstTurnTitleGen.mockResolvedValue(null)
    await runTurnAndPersist(interactive({ onTitle }))
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('settles anyway when title generation hangs past the cap', async () => {
    vi.useFakeTimers()
    try {
      runFirstTurnTitleGen.mockReturnValue(new Promise(() => {}))
      const onSettled = vi.fn()
      const onEvent = vi.fn()
      const turn = runTurnAndPersist(interactive({ onSettled, onEvent }))
      await vi.advanceTimersByTimeAsync(TITLE_GEN_TIMEOUT_MS)
      await turn
      expect(onSettled).toHaveBeenCalled()
      // Still running is not failed: it may yet land and be written through,
      // so nothing is announced. Mutation: treat the cap as a failure (set
      // `failed = true` in the timer branch) → a warning is sent.
      expect(onEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes cleanly when title generation throws — the heuristic title stands', async () => {
    runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
    const onSettled = vi.fn()

    await expect(runTurnAndPersist(interactive({ onSettled }))).resolves.toMatchObject({
      response: 'fresh:hello world, this is long',
    })
    expect(onSettled).toHaveBeenCalled()
    // A side task: the row is never flipped to 'error' for it.
    expect(flippedToError()).toEqual([])
  })

  // #420: the title is generated on the describe-tier summarizer, and when that
  // was down the conversation simply kept its heuristic name — nothing anywhere
  // but the server log said a call had failed.
  describe('a title generation that fails (#420)', () => {
    // Mutation: delete `req.onEvent?.(warning)` → the open stream never
    // carries it.
    it('sends one warning on the still-open stream, BEFORE it closes', async () => {
      runFirstTurnTitleGen.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8095'))
      const order: string[] = []
      const onEvent = vi.fn((e: { type: string }) => order.push(`event:${e.type}`))
      const onSettled = vi.fn(() => order.push('settled'))

      await runTurnAndPersist(interactive({ onEvent, onSettled }))

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent.mock.calls[0][0]).toMatchObject({
        type: 'warning',
        patternId: 'title-gen',
        data: {
          task: 'title',
          message: 'The conversation title could not be generated.',
          error: 'connect ECONNREFUSED 127.0.0.1:8095',
        },
      })
      expect(order).toEqual(['event:warning', 'settled'])
    })

    // Mutation: delete the `mustPersist` save in `compactAndSave` → the notice
    // is gone on reload, which is the only place a later reader can see it.
    // The turn here has NO tool results, so the trailing compaction persists
    // nothing (the real `compactBulkData` returns before `onPersist`) — with
    // tool results its re-save would carry the warning too and hide the gap.
    it('persists the warning with the conversation, so a reload still shows it', async () => {
      runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
      compactBulkData.mockImplementationOnce(async () => {})
      await runTurnAndPersist(interactive())
      await flush()

      const withWarning = dbUpdateContextIfUnchanged.mock.calls.find((call) =>
        call[2].includes('"type":"warning"'),
      )
      expect(withWarning).toBeDefined()
      // At the version the turn's own save wrote, so it lands on that turn.
      expect([withWarning![0], withWarning![1], withWarning![3]]).toEqual([
        'sess-1',
        'user-1',
        'v-saved',
      ])
    })

    // PR #424 review F3: the client paints the answer when the stream closes,
    // so a write between `done` and the close delays the visible answer by a
    // DB round trip the 3 s cap does not bound. The warning's save is the
    // trailing compaction's, after the close.
    // Mutation: `await saveSession(...)` inside `generateTitle` again → the
    // save lands before `settled`.
    it('saves the warning only after the stream has closed, never inside the window', async () => {
      runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
      compactBulkData.mockImplementationOnce(async () => {})
      const order: string[] = []
      saveSession.mockImplementationOnce(async () => {
        order.push('save:turn')
        return 'v-saved'
      })
      dbUpdateContextIfUnchanged.mockImplementationOnce(async (_id, _user, ctx) => {
        order.push(ctx.includes('"type":"warning"') ? 'save:warning' : 'save:other')
        return true
      })
      await runTurnAndPersist(interactive({ onSettled: () => order.push('settled') }))
      await flush()

      expect(order).toEqual(['save:turn', 'settled', 'save:warning'])
    })

    // Mutation: drop `!persisted` from the `mustPersist` check → the
    // compaction's own save and a second one race over the same row.
    it('does not save twice when the compaction already persisted the warning', async () => {
      runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
      await runTurnAndPersist(interactive())
      await flush()
      // The turn's own save, then the compaction's — which carries the warning.
      expect(saveSession).toHaveBeenCalledTimes(1)
      expect(dbUpdateContextIfUnchanged).toHaveBeenCalledTimes(1)
      expect(dbUpdateContextIfUnchanged.mock.calls[0][2]).toContain('"type":"warning"')
    })

    it('a failed save of the warning costs the warning, never the turn', async () => {
      runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
      compactBulkData.mockImplementationOnce(async () => {})
      dbUpdateContextIfUnchanged.mockRejectedValueOnce(new Error('db down')) // the warning's
      const onSettled = vi.fn()
      await expect(runTurnAndPersist(interactive({ onSettled }))).resolves.toBeDefined()
      await flush()
      expect(onSettled).toHaveBeenCalled()
      expect(flippedToError()).toEqual([])
      expect(logged).toHaveBeenCalledWith(
        '[title-gen] could not persist the warning:',
        expect.any(Error),
      )
    })

    // PR #424 review F2: a failure that lands after the cap used to set two
    // locals nobody read again — no warning and, since `runTitleAgent` stopped
    // logging, not even a log line.
    // Mutation: move `console.error` below the `streamOpen` check → silent.
    // Mutation: emit regardless of `streamOpen` → a frame into a closed stream.
    it('logs a failure that lands after the cap, and sends nothing on the closed stream', async () => {
      vi.useFakeTimers()
      try {
        runFirstTurnTitleGen.mockReturnValue(
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('slow 529')), TITLE_GEN_TIMEOUT_MS + 500),
          ),
        )
        const onEvent = vi.fn()
        const turn = runTurnAndPersist(interactive({ onEvent }))
        await vi.advanceTimersByTimeAsync(TITLE_GEN_TIMEOUT_MS)
        await turn
        await vi.advanceTimersByTimeAsync(1_000)

        expect(onEvent).not.toHaveBeenCalled()
        expect(logged).toHaveBeenCalledWith('[title-gen] failed:', expect.any(Error))
      } finally {
        vi.useRealTimers()
      }
    })

    // …and reaches the next load when the turn's trailing save has not
    // happened yet — the one write it may ride, since a save of its own would
    // race the next turn's.
    // Mutation: push into the context only while the stream is open (return
    // before the push when `!streamOpen`) → the late warning never persists.
    it('rides the trailing save when a late failure lands before it', async () => {
      vi.useFakeTimers()
      try {
        runFirstTurnTitleGen.mockReturnValue(
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('slow 529')), TITLE_GEN_TIMEOUT_MS + 500),
          ),
        )
        // The summaries are still being written when the title fails.
        compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
          await new Promise((r) => setTimeout(r, 2_000))
          await persist()
        })
        const turn = runTurnAndPersist(interactive())
        await vi.advanceTimersByTimeAsync(TITLE_GEN_TIMEOUT_MS)
        await turn
        await vi.advanceTimersByTimeAsync(3_000)

        const persisted = dbUpdateContextIfUnchanged.mock.calls.map((c) => c[2])
        expect(persisted.some((ctx) => ctx.includes('"type":"warning"'))).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    // Mutation: call `recordFailure` on success too → a warning per first turn.
    it('says nothing when a title was generated, or there was nothing to name', async () => {
      const onEvent = vi.fn()
      runFirstTurnTitleGen.mockResolvedValue('Quarterly numbers')
      await runTurnAndPersist(interactive({ onEvent }))
      runFirstTurnTitleGen.mockResolvedValue(null)
      await runTurnAndPersist(interactive({ onEvent }))
      expect(onEvent).not.toHaveBeenCalled()
    })
  })

  // SA-M13. The compaction used to be fired off outside the request handler's
  // await chain, so it inherited neither ALS scope: `getRequestSettings()` fell
  // back to DEFAULT_SETTINGS and silently ignored the user's
  // `maxResultForSummary`, and user-scoped work in the persist callback
  // resolved no user.
  it('summarizes and re-persists inside both the request and settings scopes', async () => {
    const seen: { max?: number; userId?: string | null; sessionId?: string | null } = {}
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      seen.max = runtimeConfig().maxResultForSummary
      seen.userId = getRequestUserId()
      seen.sessionId = getRequestSessionId()
      await persist()
    })

    await runTurnAndPersist(
      interactive({ settings: { ...DEFAULT_SETTINGS, maxResultForSummary: 12_345 } }),
    )
    await flush()

    expect(seen).toEqual({ max: 12_345, userId: 'user-1', sessionId: 'sess-1' })
    // Two writes: the turn, then the summarized context on top of it — at the
    // version the turn's save produced, so it cannot land over anything newer.
    // The turn's own save records the tier it ran on; the summarization save
    // writes the context alone, because by then the row already has the tier
    // and re-sending it would be a second writer of the same fact.
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'sess-1',
      'user-1',
      'search',
      'serialized:sess-1',
      { version: 'v-seed', inferenceTier: 'anthropic' },
    )
    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      JSON.stringify({ id: 'ctx:sess-1', events: [] }),
      'v-saved',
    )
  })

  // The turn is already persisted by then, so a failed summary costs summaries
  // — not the turn, and not the row's status.
  it('does not reject or flip the row when the summarization fails', async () => {
    compactBulkData.mockRejectedValueOnce(new Error('describe client down'))

    await expect(runTurnAndPersist(interactive())).resolves.toMatchObject({ status: 'running' })
    await flush()

    expect(flippedToError()).toEqual([])
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('background summarization failed'),
      expect.anything(),
    )
  })
})

// sf-M2/sf-M3: whatever fails, the row must not spin on 'running' forever.
describe('a throw leaves the row in a terminal state', () => {
  it('flips the row to error and rethrows when pattern construction fails', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway unreachable'))

    await expect(runTurnAndPersist(interactive({ sessionId: 'sess-boom' }))).rejects.toThrow(
      'gateway unreachable',
    )

    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('sess-boom', 'user-1', 'v-seed', {
      failed: true,
    })
    expect(compactBulkData).not.toHaveBeenCalled()
  })

  it('flips the row to error when the final persist fails', async () => {
    saveSession.mockRejectedValueOnce(new Error('postgres down'))

    await expect(runTurnAndPersist(interactive({ sessionId: 'sess-save' }))).rejects.toThrow(
      'postgres down',
    )

    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('sess-save', 'user-1', 'v-seed', {
      failed: true,
    })
  })

  it('reports a status flip that itself failed, instead of swallowing it', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway unreachable'))
    dbReleaseConversationClaim.mockRejectedValueOnce(new Error('postgres down too'))

    // The original failure is still what the caller sees…
    await expect(runTurnAndPersist(interactive({ sessionId: 'sess-both' }))).rejects.toThrow(
      'gateway unreachable',
    )
    // …and the fact that the row is now stuck is on the record.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('keep showing as'),
      'sess-both',
      expect.anything(),
    )
  })

  it('leaves the row alone on a successful turn', async () => {
    await runTurnAndPersist(interactive())
    expect(flippedToError()).toEqual([])
    // The save released the claim in the statement that wrote the turn.
    expect(dbReleaseConversationClaim).not.toHaveBeenCalled()
  })
})

describe('triggered turns', () => {
  function triggered(over: Record<string, unknown> = {}) {
    return {
      mode: 'triggered' as const,
      sessionId: 'run-1',
      userId: 'user-1',
      agentId: 'search',
      message: 'do the thing',
      data: { trigger: TRIGGER },
      claimVersion: 'v-trig',
      ...over,
    }
  }

  it('never continues the seeded placeholder — always a fresh run carrying the trigger', async () => {
    // Even with a row present (there always is one, seeded by `seedActionRow`).
    claimSession.mockResolvedValue({ ...STORED, kind: 'action', status: 'running' })

    await runTurnAndPersist(triggered())

    expect(claimSession).not.toHaveBeenCalled()
    expect(continueSession).not.toHaveBeenCalled()
    expect(dbCreateConversation).not.toHaveBeenCalled() // the caller already seeded it
    expect(getOrBuildPatterns).toHaveBeenCalledWith('run-1', 'search')
    expect(harness).toHaveBeenCalledWith('patterns:search')
    expect(runFresh).toHaveBeenCalledWith('do the thing', 'run-1', { trigger: TRIGGER })
    expect(seenScopes).toEqual([{ userId: 'user-1', sessionId: 'run-1' }])
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'run-1',
      'user-1',
      'search',
      'serialized:run-1',
      { version: 'v-trig', inferenceTier: 'anthropic' },
    )
  })

  // A routine stores the agent id it was created with, and so does a client
  // POSTing to `/api/agents/:id` — both may still name a consolidated agent.
  it('runs and persists a routine that names a legacy agent id under the current one', async () => {
    await runTurnAndPersist(triggered({ agentId: 'flavoured-sandbox' }))

    expect(getOrBuildPatterns).toHaveBeenCalledWith('run-1', 'sandbox')
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'run-1',
      'user-1',
      'sandbox',
      'serialized:run-1',
      { version: 'v-trig', inferenceTier: 'anthropic' },
    )
  })

  // #226 C5. The background path skipped `compactBulkData` entirely, so a
  // promoted action's next turn re-fed every raw tool payload into the prompt —
  // the exact thing #83 added compaction to prevent.
  it('summarizes and re-persists the turn, like the interactive path', async () => {
    await runTurnAndPersist(triggered())
    await flush()

    expect(compactBulkData).toHaveBeenCalledTimes(1)
    expect(compactBulkData.mock.calls[0][0]).toEqual({ id: 'ctx:run-1', events: [] })
    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledWith(
      'run-1',
      'user-1',
      JSON.stringify({ id: 'ctx:run-1', events: [] }),
      'v-saved',
    )
  })

  // #226 C5, re-pointed by #374. Off the request path there is no settings
  // payload, but the frame is opened all the same and its `config` slot is
  // seeded with the app's FULL defaults — `runtimeConfig()` has no fall-back
  // left to reach for (ruling D3), and `with-sandbox.server.ts` dereferences
  // `.sandbox` unguarded, so the library's six knobs would not do.
  it('opens a frame seeded with the app defaults when the request carried no settings', async () => {
    let maxSeen: number | undefined
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      maxSeen = runtimeConfig().maxResultForSummary
      await persist()
    })

    await runTurnAndPersist(triggered())
    await flush()

    expect(openedFrames).toHaveLength(1)
    expect(openedFrames[0].config).toEqual(DEFAULT_SETTINGS)
    expect(maxSeen).toBe(DEFAULT_SETTINGS.maxResultForSummary)
  })

  // Deliberate: `seedActionRow` lifted the trigger's short_description into the
  // sticky title column, and `runFirstTurnTitleGen` writes through stickiness.
  it('never generates a title — the trigger description is the title', async () => {
    const onTitle = vi.fn()
    runFirstTurnTitleGen.mockResolvedValue('Something else')

    await runTurnAndPersist(triggered({ onTitle }))

    expect(runFirstTurnTitleGen).not.toHaveBeenCalled()
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('flips the row to error and rethrows, same as the interactive path', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway down'))

    await expect(runTurnAndPersist(triggered({ sessionId: 'run-5' }))).rejects.toThrow(
      'gateway down',
    )

    expect(saveSession).not.toHaveBeenCalled()
    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('run-5', 'user-1', 'v-trig', {
      failed: true,
    })
  })
})

describe('approval turns', () => {
  function approval(over: Record<string, unknown> = {}) {
    return {
      mode: 'approval' as const,
      sessionId: 'sess-7',
      userId: 'user-1',
      approved: true,
      ...over,
    }
  }

  it('resumes the stored context under the row’s own agent, then persists it', async () => {
    claimSession.mockResolvedValue({ ...STORED, agentId: 'general', status: 'paused' })

    const result = await runTurnAndPersist(approval())

    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-7', 'general')
    expect(resumeHarness).toHaveBeenCalledWith('ctx-a', ['patterns:general'], true)
    expect(result.response).toBe('approved')
    expect(saveSession).toHaveBeenNthCalledWith(1, 'sess-7', 'user-1', 'general', 'resumed:true', {
      version: 'v-claim',
      inferenceTier: 'anthropic',
    })
  })

  it('resumes as rejected', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'paused' })
    const result = await runTurnAndPersist(approval({ approved: false }))
    expect(resumeHarness).toHaveBeenCalledWith('ctx-a', ['patterns:search'], false)
    expect(result.response).toBe('rejected')
  })

  // The resumed turn ran tools too, so its results need the same compaction the
  // first half of the turn got.
  it('summarizes and re-persists the resumed turn', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'paused' })

    await runTurnAndPersist(approval())
    await flush()

    expect(compactBulkData).toHaveBeenCalledTimes(1)
    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledWith(
      'sess-7',
      'user-1',
      JSON.stringify({ id: 'ctx:resumed', events: [] }),
      'v-saved',
    )
  })

  it('never re-titles a conversation it resumes', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'paused' })
    await runTurnAndPersist(approval())
    expect(runFirstTurnTitleGen).not.toHaveBeenCalled()
  })

  // A stale approve (double-click, reloaded tab) must not reach the harness: a
  // `Cannot resume` throw from inside the turn would flip a conversation that
  // already completed to 'error'.
  // The refusal comes AFTER the claim (the claim is the read that says the row
  // is not paused), so the claim has to be let go — plainly, without marking a
  // finished conversation failed.
  // MUTATION: drop the release from `runOneTurn`'s `finally` → the release
  // assertion reddens, and the conversation would refuse turns for a lease.
  it('refuses to resume a row that is not paused, releasing the claim and flipping nothing', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'done' })

    await expect(runTurnAndPersist(approval())).rejects.toThrow('No pending approval')

    expect(resumeHarness).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('sess-7', 'user-1', 'v-claim')
    expect(flippedToError()).toEqual([])
  })

  it('refuses a session the user does not own, touching nothing', async () => {
    claimSession.mockResolvedValue(null)

    await expect(runTurnAndPersist(approval({ sessionId: 'sess-9' }))).rejects.toThrow(
      'No active session',
    )

    expect(resumeHarness).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    // Nothing ran and nothing was claimed, so there is nothing to flip, seed
    // or release.
    expect(dbReleaseConversationClaim).not.toHaveBeenCalled()
    expect(dbCreateConversation).not.toHaveBeenCalled()
  })
})

describe("the run frame's inference slot — the per-conversation switch, plumbed", () => {
  it('opens the frame with the tier the CONVERSATION is on', async () => {
    resolveConversationTier.mockResolvedValue('verda')

    await runTurnAndPersist(interactive())

    // Resolved per conversation, not per user: that is what lets an Anthropic
    // chat start while a private one is still waking.
    expect(resolveConversationTier).toHaveBeenCalledWith('sess-1', 'user-1')
    expect(tierScopes.value).toEqual(['verda'])
  })

  it('fills the anthropic position too, rather than leaving the slot empty', async () => {
    // The slot must be filled in BOTH positions: a run whose frame names no
    // tier falls back to the deployment default, so "leave it out when the user
    // picked Anthropic" would silently ignore an opt-out on a Verda-default host.
    resolveConversationTier.mockResolvedValue('anthropic')

    await runTurnAndPersist(interactive())

    expect(tierScopes.value).toEqual(['anthropic'])
  })

  it('resolves against the run’s OWNER, not any caller', async () => {
    // The tier is looked up under the turn's `userId` — the id the entry point
    // authenticated — which is both what stops one user's setting steering
    // another user's triggered run and what scopes the conversation read.
    await runTurnAndPersist(interactive({ userId: 'user-7' }))

    expect(resolveConversationTier).toHaveBeenCalledWith('sess-1', 'user-7')
  })

  it('covers every mode, so no entry point runs untiered', async () => {
    await runTurnAndPersist(interactive())
    await runTurnAndPersist({
      mode: 'triggered',
      sessionId: 'sess-t',
      userId: 'user-1',
      agentId: 'search',
      message: 'go',
      claimVersion: 'v-trig',
    })
    claimSession.mockResolvedValue({ ...STORED, status: 'paused' })
    await runTurnAndPersist({
      mode: 'approval',
      sessionId: 'sess-1',
      userId: 'user-1',
      approved: true,
    })

    expect(tierScopes.value).toEqual(['anthropic', 'anthropic', 'anthropic'])
  })

  it('runs the turn anyway when the preference cannot be read', async () => {
    // A Postgres blip must cost the user their *preference*, not their answer.
    resolveConversationTier.mockRejectedValue(new Error('postgres is down'))

    const result = await runTurnAndPersist(interactive())

    expect(result.response).toBe('fresh:hello world, this is long')
    expect(tierScopes.value).toEqual(['anthropic']) // the deployment default
    expect(logged).toHaveBeenCalled()
  })
})

// Owner decision 2026-10-03: "Routines can mount private skills, not global
// ones for now." The sandbox's skills resolver reads `isAttendedRequest()` per
// run (agent-deps-seam.test.ts); this is where each entry point decides it.
//
// MUTATION: set `attended: true` for every mode in `runTurnAndPersist` → the
// triggered case reddens; drop the flag altogether → the two attended ones do.
describe('the request scope says whether anyone is waiting on the run', () => {
  it('marks an interactive turn attended', async () => {
    await runTurnAndPersist(interactive())
    expect(seenAttended).toEqual([true])
  })

  it('marks an approval attended — a person pressed the button', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'paused' })
    await runTurnAndPersist({
      mode: 'approval',
      sessionId: 'sess-1',
      userId: 'user-1',
      approved: true,
    })
    expect(seenAttended).toEqual([true])
  })

  it('marks a triggered run — a routine, POST /api/agents/:id — unattended', async () => {
    await runTurnAndPersist({
      mode: 'triggered',
      sessionId: 'run-9',
      userId: 'user-1',
      agentId: 'sandbox',
      message: 'nightly report',
      data: { trigger: TRIGGER },
      claimVersion: 'v-trig',
    })
    expect(seenAttended).toEqual([false])
  })
})

describe('what the header learns from a turn', () => {
  it('counts the turn against its tier', async () => {
    resolveConversationTier.mockResolvedValue('verda')

    await runTurnAndPersist(interactive())

    expect(recordTurn).toHaveBeenCalledWith('verda')
  })

  it('brackets a Verda turn with the in-flight gauge', async () => {
    resolveConversationTier.mockResolvedValue('verda')

    await runTurnAndPersist(interactive())

    expect(beginVerdaTurn).toHaveBeenCalledTimes(1)
    expect(endVerdaTurn).toHaveBeenCalledTimes(1)
  })

  it('releases the gauge even when the turn throws', async () => {
    // Without the `finally`, one failed turn pins the header to "answering"
    // for the life of the process.
    resolveConversationTier.mockResolvedValue('verda')
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway down'))

    await expect(runTurnAndPersist(interactive())).rejects.toThrow('gateway down')

    expect(beginVerdaTurn).toHaveBeenCalledTimes(1)
    expect(endVerdaTurn).toHaveBeenCalledTimes(1)
  })

  it('wakes the box BEFORE the harness runs, on a verda turn', async () => {
    // WAKE THEN RUN, and the ORDER is the whole claim. The box scales to zero, so
    // starting the harness first just moves a 146s wait into a call whose timeout
    // is now sized for a warm box (180s) — i.e. the first turn of every session
    // would fail. Asserted by call order against the first thing the run does
    // rather than by "was it called", because a wake that happens after the
    // controller is not a wake.
    resolveConversationTier.mockResolvedValue('verda')
    const order: string[] = []
    dbCreateConversation.mockImplementation(async () => {
      order.push('seed')
      return 'v-seed'
    })
    ensureVerdaAwake.mockImplementation(async () => {
      order.push('wake')
    })
    getOrBuildPatterns.mockImplementation(async () => {
      order.push('patterns')
      return ['patterns:search']
    })

    await runTurnAndPersist(interactive())

    expect(ensureVerdaAwake).toHaveBeenCalledTimes(1)
    // The #105 pre-seed comes FIRST and the wake second — the other half of the
    // ordering, and the half that makes the failure below recordable. A wake
    // ahead of the seed persisted nothing at all when it failed, so a reload lost
    // the user's message.
    expect(order).toEqual(['seed', 'wake', 'patterns'])
  })

  it('leaves an anthropic conversation out of another conversation’s wait', async () => {
    // The point of the per-conversation switch: start an Anthropic chat while a
    // private one is still waking. The Anthropic turn must not inherit the other
    // one's cold-start notice — and both halves of that are AsyncLocalStorage,
    // so the claim is about SCOPE rather than about a flag.
    //
    // It is asserted through the real seam rather than a stub: each turn asks
    // `clientOverrideFor('controller')` from inside its own scopes, which is
    // what every adapter does and what fires the notice. The private turn is
    // parked in its wake while the Anthropic one runs, so the two scopes are
    // genuinely open at once.
    const { clientOverrideFor } = await import('@hames-ai/harness-baml/clients.server')
    const privateWarming = vi.fn()
    const anthropicWarming = vi.fn()
    const overrides: Record<string, { client: string } | undefined> = {}

    let releaseWake: (() => void) | undefined
    const waking = new Promise<void>((resolve) => {
      releaseWake = resolve
    })
    ensureVerdaAwake.mockImplementation(async () => {
      await waking
    })
    getOrBuildPatterns.mockImplementation(async (sessionId: string) => {
      overrides[sessionId] = clientOverrideFor('controller')
      return ['patterns:search']
    })

    resolveConversationTier.mockResolvedValue('verda')
    const privateTurn = runTurnAndPersist(
      interactive({ sessionId: 'sess-private', onWarming: privateWarming }),
    )
    // Let the private turn open its scopes and park on the wake.
    await Promise.resolve()
    await Promise.resolve()

    resolveConversationTier.mockResolvedValue('anthropic')
    await runTurnAndPersist(
      interactive({ sessionId: 'sess-anthropic', onWarming: anthropicWarming }),
    )

    // The Anthropic turn took no override and announced no wait, while the
    // other conversation's scope was open the whole time.
    expect(overrides['sess-anthropic']).toBeUndefined()
    expect(anthropicWarming).not.toHaveBeenCalled()

    releaseWake?.()
    await privateTurn

    // Not vacuous: the private turn really was on the self-hosted route and
    // really did announce its wait, from the same seam.
    expect(overrides['sess-private']).toEqual({ client: 'VerdaQwen' })
    expect(privateWarming).toHaveBeenCalled()
  })

  it('does not wake anything on an anthropic turn', async () => {
    // A metered always-on API has no box to start, and a ping to one would be a
    // request to a deployment this turn is not using.
    await runTurnAndPersist(interactive())

    expect(ensureVerdaAwake).not.toHaveBeenCalled()
  })

  it('ends the turn when the box does not wake, and releases the gauge', async () => {
    // THE VISIBLE-FAILURE HALF of #273 D-b. A wake that fails must not fall
    // through to the harness (same 146s wait, now against a 180s timeout) and
    // must not fall back to Anthropic (confidential prompts to the provider the
    // tier exists to avoid). It throws, the throw reaches the SSE route's `catch`
    // as an `error` frame, and the in-flight gauge is still released — otherwise
    // one dead deployment pins the header to "answering" for the life of the
    // process.
    resolveConversationTier.mockResolvedValue('verda')
    ensureVerdaAwake.mockRejectedValueOnce(
      new Error('the private inference box did not wake: no answer within 300s.'),
    )

    await expect(runTurnAndPersist(interactive())).rejects.toThrow(
      /the private inference box did not wake/,
    )

    // And the harness never started — a partially-run turn on a box that is not
    // there is the outcome this ordering exists to prevent.
    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    expect(beginVerdaTurn).toHaveBeenCalledTimes(1)
    expect(endVerdaTurn).toHaveBeenCalledTimes(1)
    // AND THE ROW IS NOT LEFT SPINNING. The wake moved inside `runAndSave`'s try
    // for this: a first message that cannot wake the box leaves an errored
    // conversation in the sidebar, the same as a first BAML call that fails
    // (#105's property), rather than a row stuck at 'running' or no row at all.
    expect(dbCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1', status: 'running' }),
    )
    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('sess-1', 'user-1', 'v-seed', {
      failed: true,
    })
  })

  it('flips a TRIGGERED run out of running when the box does not wake', async () => {
    // The path with no chat to show an error in, and the one the review proved by
    // execution. `seedActionRow` wrote this row at 'running' before the run and
    // `runAgentInBackground` swallows the rejection with `.catch(() => {})` — on
    // the strength of this function logging the failure and flipping the row. A
    // wake outside the `catch` did neither, so an unattended routine that met a
    // sleeping box left a row spinning forever with no trace anywhere: no chat,
    // no error frame, no log.
    resolveConversationTier.mockResolvedValue('verda')
    ensureVerdaAwake.mockRejectedValueOnce(
      new Error('the private inference box did not wake: no answer within 300s.'),
    )

    await expect(
      runTurnAndPersist({
        mode: 'triggered' as const,
        sessionId: 'run-wake',
        userId: 'user-1',
        agentId: 'search',
        message: 'do the thing',
        data: { trigger: TRIGGER },
        claimVersion: 'v-trig',
      }),
    ).rejects.toThrow(/the private inference box did not wake/)

    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('run-wake', 'user-1', 'v-trig', {
      failed: true,
    })
    // A triggered run has no row to seed — `seedActionRow` already wrote it, and
    // touching it here would overwrite the trigger's own title.
    expect(dbCreateConversation).not.toHaveBeenCalled()
    // The log `runAgentInBackground` relies on, since it is the only trace this
    // path leaves.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('[turn] run failed for run-wake'),
      expect.anything(),
    )
  })

  it('does not touch the gauge for an Anthropic turn', async () => {
    await runTurnAndPersist(interactive())

    expect(beginVerdaTurn).not.toHaveBeenCalled()
    expect(endVerdaTurn).not.toHaveBeenCalled()
    expect(recordTurn).toHaveBeenCalledWith('anthropic')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// #458 — one turn per conversation, and every save at the version it read.
// The statements that refuse are pinned against Postgres in
// `db/conversations.test.ts`, and the whole race end to end in
// `db/context-row-lost-updates.test.ts`; what is pinned here is that the turn
// runner holds the claim, saves at it and lets go of it on every exit path.
// ════════════════════════════════════════════════════════════════════════════

const BUSY = 'A turn is still running in this conversation. Wait for it to finish, then send again.'

describe('one turn per conversation (#458)', () => {
  // The refusal is the turn's outcome — the SSE route turns it into an
  // `event: error` frame. Nothing may run, and nothing of the turn that holds
  // the conversation may be touched.
  // MUTATION: catch the refusal in `claimTurn` and fall through to a fresh
  // conversation → the turn runs and every assertion below reddens.
  it('refuses a turn while another holds the conversation, running and writing nothing', async () => {
    claimSession.mockRejectedValueOnce(new Error(BUSY))

    await expect(runTurnAndPersist(interactive())).rejects.toThrow(BUSY)

    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
    expect(dbCreateConversation).not.toHaveBeenCalled()
    // The claim is the other turn's: not ours to release, its row not ours to fail.
    expect(dbReleaseConversationClaim).not.toHaveBeenCalled()
  })

  it('refuses a second first message on a brand-new chat the same way', async () => {
    dbCreateConversation.mockRejectedValueOnce(new Error(BUSY))

    await expect(runTurnAndPersist(interactive())).rejects.toThrow(BUSY)

    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    expect(dbReleaseConversationClaim).not.toHaveBeenCalled()
  })

  it('refuses an approval while a turn is still running in the conversation', async () => {
    claimSession.mockRejectedValueOnce(new Error(BUSY))

    await expect(
      runTurnAndPersist({
        mode: 'approval',
        sessionId: 'sess-7',
        userId: 'user-1',
        approved: true,
      }),
    ).rejects.toThrow(BUSY)

    expect(resumeHarness).not.toHaveBeenCalled()
  })

  // A triggered run does not claim: the seed created its row claimed, and the
  // run is handed that claim. Claiming again would refuse itself.
  it('runs a triggered turn on the claim its seed took', async () => {
    await runTurnAndPersist({
      mode: 'triggered',
      sessionId: 'run-c',
      userId: 'user-1',
      agentId: 'search',
      message: 'go',
      claimVersion: 'v-trig',
    })

    expect(claimSession).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledWith('run-c', 'user-1', 'search', 'serialized:run-c', {
      version: 'v-trig',
      inferenceTier: 'anthropic',
    })
  })

  describe('the lease', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** A turn parked in its pattern build until `release()`. */
    function parkedTurn(sessionId: string) {
      let release!: () => void
      getOrBuildPatterns.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(['patterns:search']))),
      )
      claimSession.mockResolvedValue(STORED)
      const turn = runTurnAndPersist(interactive({ sessionId }))
      return {
        release: () => release(),
        done: async () => {
          release()
          await vi.advanceTimersByTimeAsync(TITLE_GEN_TIMEOUT_MS)
          return turn
        },
      }
    }

    // A slow turn keeps its conversation; only a dead process loses it.
    // MUTATION: delete the renewal interval → no renewals, and a turn longer
    // than the lease is overtaken by the next one.
    it('renews its claim while it runs, at the version it holds, and stops when it ends', async () => {
      const turn = parkedTurn('sess-long')
      await vi.advanceTimersByTimeAsync(TURN_CLAIM_RENEW_MS * 3 + 10)

      expect(dbRenewConversationClaim).toHaveBeenCalledTimes(3)
      expect(dbRenewConversationClaim).toHaveBeenCalledWith('sess-long', 'user-1', 'v-claim')

      await turn.done()
      await vi.advanceTimersByTimeAsync(TURN_CLAIM_RENEW_MS * 3)
      // MUTATION: drop `clearInterval(renewal)` → renewals carry on after the turn.
      expect(dbRenewConversationClaim).toHaveBeenCalledTimes(3)
    })

    it('says so, once, when a renewal finds the claim taken', async () => {
      dbRenewConversationClaim.mockResolvedValue(false)
      const turn = parkedTurn('sess-lost')
      await vi.advanceTimersByTimeAsync(TURN_CLAIM_RENEW_MS * 3 + 10)

      expect(dbRenewConversationClaim).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('lost the claim on sess-lost'))
      await turn.done()
    })

    it('keeps the turn running when a renewal cannot reach the database', async () => {
      dbRenewConversationClaim.mockRejectedValue(new Error('postgres blip'))
      const turn = parkedTurn('sess-blip')
      await vi.advanceTimersByTimeAsync(TURN_CLAIM_RENEW_MS + 10)

      expect(logged).toHaveBeenCalledWith(
        '[turn] could not renew the claim on %s:',
        'sess-blip',
        expect.any(Error),
      )
      await expect(turn.done()).resolves.toMatchObject({
        response: 'continued:hello world, this is long',
      })
    })
  })

  it('logs a release that fails, and still surfaces the refusal that needed it', async () => {
    claimSession.mockResolvedValue({ ...STORED, status: 'done' })
    dbReleaseConversationClaim.mockRejectedValueOnce(new Error('postgres down'))

    await expect(
      runTurnAndPersist({
        mode: 'approval',
        sessionId: 'sess-7',
        userId: 'user-1',
        approved: true,
      }),
    ).rejects.toThrow('No pending approval')

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('could not release %s'),
      'sess-7',
      expect.any(Error),
    )
  })
})

describe('the trailing pass writes over nothing newer (#458)', () => {
  const ev = (id: string, type: string, data: Record<string, unknown> = {}) => ({
    id,
    type,
    ts: 0,
    patternId: 'p',
    data,
  })

  /** The turn's context: one question, one tool result. */
  function ourTurn() {
    return {
      sessionId: 'sess-1',
      createdAt: 0,
      status: 'running',
      data: {},
      input: 'q',
      events: [
        ev('u1', 'user_message', { content: 'q' }),
        ev('t1', 'tool_result', { tool: 'x', result: 'raw', success: true }),
      ],
    }
  }

  /** The harness hands back `ctx`, and the summary pass enriches it. */
  function runWith(ctx: ReturnType<typeof ourTurn>) {
    runFresh.mockImplementationOnce(async () => ({
      response: 'answer',
      serialized: JSON.stringify(ctx),
      data: {},
      context: ctx as unknown as Ctx,
      status: 'running',
    }))
    compactBulkData.mockImplementationOnce(async (raw: unknown, persist: () => Promise<void>) => {
      const c = raw as ReturnType<typeof ourTurn>
      ;(c.events[1].data as { summary?: string }).summary = 'S'
      c.events.push(ev('w1', 'warning', { task: 'result_summaries' }))
      await persist()
    })
  }

  // The bug this replaces: the pass wrote the WHOLE context it summarized, so
  // when the next turn had finished first, that turn was erased.
  // MUTATION: write `ours` on the retry instead of the merge (overwrite) →
  // `u2`/`a2` and the flag vanish from the written blob.
  it('on a conflict, re-reads the row and applies only its summaries and notices to it', async () => {
    runWith(ourTurn())
    // The next turn finished in between, and the user hid our tool result.
    const fresh = ourTurn()
    ;(fresh.events[1].data as { hidden?: boolean }).hidden = true
    fresh.events.push(
      ev('u2', 'user_message', { content: 'next' }),
      ev('a2', 'assistant_message', { content: 'ans' }),
    )
    dbUpdateContextIfUnchanged.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    dbLoadConversation.mockResolvedValueOnce({
      serializedContext: JSON.stringify(fresh),
      version: 'v-fresh',
    })

    await runTurnAndPersist(interactive())
    await flush()

    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledTimes(2)
    // The first attempt was at the version the turn's own save wrote.
    expect(dbUpdateContextIfUnchanged.mock.calls[0][3]).toBe('v-saved')
    const [id, user, written, version] = dbUpdateContextIfUnchanged.mock.calls[1]
    expect([id, user, version]).toEqual(['sess-1', 'user-1', 'v-fresh'])
    const merged = JSON.parse(written) as ReturnType<typeof ourTurn>
    // The newer turn survives, and the notice lands at the end of its own turn.
    expect(merged.events.map((e) => e.id)).toEqual(['u1', 't1', 'w1', 'u2', 'a2'])
    // Its own field added; the flag someone else wrote kept.
    expect(merged.events[1].data).toMatchObject({ summary: 'S', hidden: true })
  })

  // A newer turn holds the row: writing now would be overwritten by it, or —
  // since it moves the version — refuse that turn's save.
  // MUTATION: fall back to `saveSession` (an unconditional write) after the
  // last attempt → the turn's own save count rises to 2.
  it('gives up after its attempts, says so, and never writes over the row', async () => {
    dbUpdateContextIfUnchanged.mockResolvedValue(false)
    dbLoadConversation.mockResolvedValue({
      serializedContext: JSON.stringify({ events: [] }),
      version: 'v-held',
    })

    await runTurnAndPersist(interactive())
    await flush()

    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledTimes(3)
    expect(saveSession).toHaveBeenCalledTimes(1) // the turn's own, nothing after
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("this turn's summaries and notices are not saved"),
    )
  })

  it('stops, and says why, when the conversation was deleted meanwhile', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbUpdateContextIfUnchanged.mockResolvedValueOnce(false)
    dbLoadConversation.mockResolvedValueOnce(null)

    await runTurnAndPersist(interactive())
    await flush()

    expect(dbUpdateContextIfUnchanged).toHaveBeenCalledTimes(1)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('sess-1 is gone'))
    warned.mockRestore()
  })
})

describe('mergeTrailingPass', () => {
  const ev = (id: string | undefined, type: string, data: Record<string, unknown> = {}) => ({
    id,
    type,
    ts: 0,
    patternId: 'p',
    data,
  })
  const ctxOf = (events: ReturnType<typeof ev>[]) =>
    ({ sessionId: 's', createdAt: 0, status: 'running', data: {}, input: '', events }) as never

  it('never overwrites a summary the fresh copy already has', () => {
    const fresh = ctxOf([ev('t1', 'tool_result', { summary: 'theirs' })])
    const ours = ctxOf([ev('t1', 'tool_result', { summary: 'ours' })])
    const merged = mergeTrailingPass(fresh, ours, 1) as unknown as {
      events: { data: { summary: string } }[]
    }
    expect(merged.events[0].data.summary).toBe('theirs')
  })

  it('copies a summary only onto a tool result with the same id', () => {
    const fresh = ctxOf([ev('t1', 'assistant_message'), ev('t2', 'tool_result')])
    const ours = ctxOf([ev('t1', 'tool_result', { summary: 'S' }), ev('t3', 'tool_result', {})])
    const merged = mergeTrailingPass(fresh, ours, 2) as unknown as {
      events: { data: Record<string, unknown> }[]
    }
    expect(merged.events.map((e) => e.data.summary)).toEqual([undefined, undefined])
  })

  it('does not duplicate an addition the fresh copy already carries', () => {
    const fresh = ctxOf([ev('u1', 'user_message'), ev('w1', 'warning')])
    const ours = ctxOf([ev('u1', 'user_message'), ev('w1', 'warning')])
    const merged = mergeTrailingPass(fresh, ours, 1) as unknown as { events: { id: string }[] }
    expect(merged.events.map((e) => e.id)).toEqual(['u1', 'w1'])
  })

  it('appends an addition whose predecessor the fresh copy no longer has', () => {
    const fresh = ctxOf([ev('x1', 'user_message')])
    const ours = ctxOf([ev('u1', 'user_message'), ev('w1', 'warning'), ev(undefined, 'warning')])
    const merged = mergeTrailingPass(fresh, ours, 1) as unknown as {
      events: { id?: string; type: string }[]
    }
    expect(merged.events.map((e) => e.id ?? e.type)).toEqual(['x1', 'w1', 'warning'])
  })
})

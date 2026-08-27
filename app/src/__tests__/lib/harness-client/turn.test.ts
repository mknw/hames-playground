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

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ── harness-patterns: a fake harness whose runs are observable ──────────────
import {
  getRequestUserId,
  getRequestSessionId,
} from '../../../lib/harness-client/request-user.server'
import { getRequestSettings } from '../../../lib/settings-context.server'
import { DEFAULT_SETTINGS } from '../../../lib/settings'

/** Every run records the ambient scope it saw. */
const seenScopes: Array<{ userId: string | null; sessionId: string | null }> = []

type Ctx = { id: string; events: unknown[] }
const runFresh = vi.fn(
  async (message: string, sessionId: string, _data?: unknown, _onEvent?: unknown) => {
    seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
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
    return {
      response: `continued:${message}`,
      serialized: `${serialized}+${message}`,
      data: {},
      context: { id: 'ctx:continued', events: [] } as Ctx,
      status: 'running',
    }
  },
)
const resumeHarness = vi.fn(async (_s: string, _p: unknown, approved: boolean) => ({
  response: approved ? 'approved' : 'rejected',
  serialized: `resumed:${approved}`,
  data: {},
  context: { id: 'ctx:resumed', events: [] } as Ctx,
  status: 'running',
}))
const createContext = vi.fn((message: string, _data: unknown, sessionId: string) => ({
  sessionId,
  events: [{ type: 'user_message', data: { content: message } }],
}))
const serializeContext = vi.fn((ctx: unknown) => JSON.stringify(ctx))
/** Stands in for the real compaction: mutates nothing, but persists like it. */
const compactBulkData = vi.fn(async (_ctx: unknown, onPersist: () => Promise<void>) => {
  await onPersist()
})

vi.mock('../../../lib/harness-patterns', () => ({
  harness,
  continueSession,
  resumeHarness,
  createContext,
  serializeContext,
  compactBulkData,
}))

// ── settings scope: the real ALS, with the calls recorded ───────────────────
const settingsScopes: unknown[] = []
vi.mock('../../../lib/settings-context.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/settings-context.server')>(
    '../../../lib/settings-context.server',
  )
  return {
    ...actual,
    runWithSettings: (settings: never, fn: () => Promise<unknown>) => {
      settingsScopes.push(settings)
      return actual.runWithSettings(settings, fn)
    },
  }
})

// ── inference tier scope: the real ALS, with the calls recorded ─────────────
// The per-user switch acts here and nowhere else, so the turn runner is where
// "the user's preference actually steers the run" is provable.
const tierScopes: string[] = []
vi.mock('../../../lib/harness-patterns/clients.server', async () => {
  const actual = await vi.importActual<
    typeof import('../../../lib/harness-patterns/clients.server')
  >('../../../lib/harness-patterns/clients.server')
  return {
    ...actual,
    runWithInferenceTier: (tier: 'verda' | 'anthropic', fn: () => Promise<unknown>) => {
      tierScopes.push(tier)
      return actual.runWithInferenceTier(tier, fn)
    },
  }
})

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
type Loaded = { serializedContext: string; agentId: string; kind: string; status: string } | null
const loadSession = vi.fn<(id: string, userId: string) => Promise<Loaded>>(async () => null)
const saveSession = vi.fn(async () => {})
const getOrBuildPatterns = vi.fn(async (_s: string, agentId: string) => [`patterns:${agentId}`])
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession,
  saveSession,
  getOrBuildPatterns,
}))

// ── db/conversations ────────────────────────────────────────────────────────
const dbSaveConversation = vi.fn<(row: Record<string, unknown>) => Promise<void>>(async () => {})
const dbSetConversationStatus = vi.fn<
  (id: string, userId: string, status: string) => Promise<void>
>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  saveConversation: dbSaveConversation,
  setConversationStatus: dbSetConversationStatus,
  deriveTitle: (s: string) => s.slice(0, 10),
}))

// ── title agent ─────────────────────────────────────────────────────────────
const runFirstTurnTitleGen = vi.fn<() => Promise<string | null>>(async () => null)
vi.mock('../../../lib/harness-client/agents/title-generator.server', () => ({
  runFirstTurnTitleGen: (...a: unknown[]) => runFirstTurnTitleGen(...(a as [])),
}))

const { runTurnAndPersist, TITLE_GEN_TIMEOUT_MS } =
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
}

let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  seenScopes.length = 0
  settingsScopes.length = 0
  tierScopes.length = 0
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
  loadSession.mockResolvedValue(null)
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

    expect(dbSaveConversation).toHaveBeenCalledTimes(1)
    const seeded = dbSaveConversation.mock.calls[0][0]
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
    expect(dbSaveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      runFresh.mock.invocationCallOrder[0],
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(result.response).toBe('fresh:hello world, this is long')
    expect(saveSession).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      'search',
      'serialized:sess-1',
      'anthropic',
    )
  })

  it('continues a stored context instead of re-running it fresh', async () => {
    loadSession.mockResolvedValue(STORED)

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-2', message: 'follow up' }),
    )

    expect(dbSaveConversation).not.toHaveBeenCalled() // no re-seed for a known row
    expect(harness).not.toHaveBeenCalled()
    expect(continueSession).toHaveBeenCalledWith(
      'ctx-a',
      ['patterns:search'],
      'follow up',
      undefined,
    )
    expect(result.response).toBe('continued:follow up')
    expect(saveSession).toHaveBeenCalledWith(
      'sess-2',
      'user-1',
      'search',
      'ctx-a+follow up',
      'anthropic',
    )
  })

  it('starts fresh when the agent changed under an existing sessionId', async () => {
    loadSession.mockResolvedValue(STORED)

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-3', agentId: 'general', message: 'hi' }),
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-3', 'general')
    expect(result.response).toBe('fresh:hi')
    expect(saveSession).toHaveBeenCalledWith(
      'sess-3',
      'user-1',
      'general',
      'serialized:sess-3',
      'anthropic',
    )
  })

  it('exposes the user + conversation to the run as ambient request scope', async () => {
    await runTurnAndPersist(interactive({ sessionId: 'sess-4' }))
    expect(seenScopes).toEqual([{ userId: 'user-1', sessionId: 'sess-4' }])
  })

  it('threads onEvent into the run and delivers its hooks in order', async () => {
    const order: string[] = []
    const onEvent = vi.fn()
    loadSession.mockResolvedValue(STORED)
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
    expect(continueSession.mock.calls[0][3]).toBe(onEvent)
    expect(order).toEqual(['result', 'title', 'settled', 'compact'])
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
      const turn = runTurnAndPersist(interactive({ onSettled }))
      await vi.advanceTimersByTimeAsync(TITLE_GEN_TIMEOUT_MS)
      await turn
      expect(onSettled).toHaveBeenCalled()
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
  })

  // SA-M13. The compaction used to be fired off outside the request handler's
  // await chain, so it inherited neither ALS scope: `getRequestSettings()` fell
  // back to DEFAULT_SETTINGS and silently ignored the user's
  // `maxResultForSummary`, and user-scoped work in the persist callback
  // resolved no user.
  it('summarizes and re-persists inside both the request and settings scopes', async () => {
    const seen: { max?: number; userId?: string | null; sessionId?: string | null } = {}
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      seen.max = getRequestSettings().maxResultForSummary
      seen.userId = getRequestUserId()
      seen.sessionId = getRequestSessionId()
      await persist()
    })

    await runTurnAndPersist(
      interactive({ settings: { ...DEFAULT_SETTINGS, maxResultForSummary: 12_345 } }),
    )
    await flush()

    expect(seen).toEqual({ max: 12_345, userId: 'user-1', sessionId: 'sess-1' })
    // Two writes: the turn, then the summarized context on top of it.
    // The turn's own save records the tier it ran on; the summarization save
    // below does NOT pass one, because by then the row already has it and
    // `saveConversation` COALESCEs — re-sending it would be a second writer of
    // the same fact.
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'sess-1',
      'user-1',
      'search',
      'serialized:sess-1',
      'anthropic',
    )
    expect(saveSession).toHaveBeenNthCalledWith(
      2,
      'sess-1',
      'user-1',
      'search',
      JSON.stringify({ id: 'ctx:sess-1', events: [] }),
    )
  })

  // The turn is already persisted by then, so a failed summary costs summaries
  // — not the turn, and not the row's status.
  it('does not reject or flip the row when the summarization fails', async () => {
    compactBulkData.mockRejectedValueOnce(new Error('describe client down'))

    await expect(runTurnAndPersist(interactive())).resolves.toMatchObject({ status: 'running' })
    await flush()

    expect(dbSetConversationStatus).not.toHaveBeenCalled()
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

    expect(dbSetConversationStatus).toHaveBeenCalledWith('sess-boom', 'user-1', 'error')
    expect(compactBulkData).not.toHaveBeenCalled()
  })

  it('flips the row to error when the final persist fails', async () => {
    saveSession.mockRejectedValueOnce(new Error('postgres down'))

    await expect(runTurnAndPersist(interactive({ sessionId: 'sess-save' }))).rejects.toThrow(
      'postgres down',
    )

    expect(dbSetConversationStatus).toHaveBeenCalledWith('sess-save', 'user-1', 'error')
  })

  it('reports a status flip that itself failed, instead of swallowing it', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway unreachable'))
    dbSetConversationStatus.mockRejectedValueOnce(new Error('postgres down too'))

    // The original failure is still what the caller sees…
    await expect(runTurnAndPersist(interactive({ sessionId: 'sess-both' }))).rejects.toThrow(
      'gateway unreachable',
    )
    // …and the fact that the row is now stuck is on the record.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('keep showing as'),
      expect.anything(),
    )
  })

  it('leaves the row alone on a successful turn', async () => {
    await runTurnAndPersist(interactive())
    expect(dbSetConversationStatus).not.toHaveBeenCalled()
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
      ...over,
    }
  }

  it('never continues the seeded placeholder — always a fresh run carrying the trigger', async () => {
    // Even with a row present (there always is one, seeded by `seedActionRow`).
    loadSession.mockResolvedValue({ ...STORED, kind: 'action', status: 'running' })

    await runTurnAndPersist(triggered())

    expect(loadSession).not.toHaveBeenCalled()
    expect(continueSession).not.toHaveBeenCalled()
    expect(dbSaveConversation).not.toHaveBeenCalled() // the caller already seeded it
    expect(getOrBuildPatterns).toHaveBeenCalledWith('run-1', 'search')
    expect(harness).toHaveBeenCalledWith('patterns:search')
    expect(runFresh).toHaveBeenCalledWith('do the thing', 'run-1', { trigger: TRIGGER }, undefined)
    expect(seenScopes).toEqual([{ userId: 'user-1', sessionId: 'run-1' }])
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'run-1',
      'user-1',
      'search',
      'serialized:run-1',
      'anthropic',
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
    expect(saveSession).toHaveBeenNthCalledWith(
      2,
      'run-1',
      'user-1',
      'search',
      JSON.stringify({ id: 'ctx:run-1', events: [] }),
    )
  })

  // #226 C5. Off the request path there is no settings payload, but the scope
  // is opened all the same, so the compaction reads DEFAULT_SETTINGS from a
  // scope rather than from a fallback.
  it('opens a settings scope even with no request settings to put in it', async () => {
    let maxSeen: number | undefined
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      maxSeen = getRequestSettings().maxResultForSummary
      await persist()
    })

    await runTurnAndPersist(triggered())
    await flush()

    expect(settingsScopes).toEqual([undefined])
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
    expect(dbSetConversationStatus).toHaveBeenCalledWith('run-5', 'user-1', 'error')
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
    loadSession.mockResolvedValue({ ...STORED, agentId: 'general', status: 'paused' })

    const result = await runTurnAndPersist(approval())

    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-7', 'general')
    expect(resumeHarness).toHaveBeenCalledWith('ctx-a', ['patterns:general'], true, undefined)
    expect(result.response).toBe('approved')
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'sess-7',
      'user-1',
      'general',
      'resumed:true',
      'anthropic',
    )
  })

  it('resumes as rejected', async () => {
    loadSession.mockResolvedValue({ ...STORED, status: 'paused' })
    const result = await runTurnAndPersist(approval({ approved: false }))
    expect(resumeHarness).toHaveBeenCalledWith('ctx-a', ['patterns:search'], false, undefined)
    expect(result.response).toBe('rejected')
  })

  // The resumed turn ran tools too, so its results need the same compaction the
  // first half of the turn got.
  it('summarizes and re-persists the resumed turn', async () => {
    loadSession.mockResolvedValue({ ...STORED, status: 'paused' })

    await runTurnAndPersist(approval())
    await flush()

    expect(compactBulkData).toHaveBeenCalledTimes(1)
    expect(saveSession).toHaveBeenNthCalledWith(
      2,
      'sess-7',
      'user-1',
      'search',
      JSON.stringify({ id: 'ctx:resumed', events: [] }),
    )
  })

  it('never re-titles a conversation it resumes', async () => {
    loadSession.mockResolvedValue({ ...STORED, status: 'paused' })
    await runTurnAndPersist(approval())
    expect(runFirstTurnTitleGen).not.toHaveBeenCalled()
  })

  // A stale approve (double-click, reloaded tab) must not reach the harness: a
  // `Cannot resume` throw from inside the turn would flip a conversation that
  // already completed to 'error'.
  it('refuses to resume a row that is not paused, touching nothing', async () => {
    loadSession.mockResolvedValue({ ...STORED, status: 'done' })

    await expect(runTurnAndPersist(approval())).rejects.toThrow('No pending approval')

    expect(resumeHarness).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    expect(dbSetConversationStatus).not.toHaveBeenCalled()
  })

  it('refuses a session the user does not own, touching nothing', async () => {
    loadSession.mockResolvedValue(null)

    await expect(runTurnAndPersist(approval({ sessionId: 'sess-9' }))).rejects.toThrow(
      'No active session',
    )

    expect(resumeHarness).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).not.toHaveBeenCalled()
    // Nothing ran, so nothing is mid-flight to flip or seed.
    expect(dbSetConversationStatus).not.toHaveBeenCalled()
    expect(dbSaveConversation).not.toHaveBeenCalled()
  })
})

describe('the inference-tier scope — the per-conversation switch, plumbed', () => {
  it('opens the scope with the tier the CONVERSATION is on', async () => {
    resolveConversationTier.mockResolvedValue('verda')

    await runTurnAndPersist(interactive())

    // Resolved per conversation, not per user: that is what lets an Anthropic
    // chat start while a private one is still waking.
    expect(resolveConversationTier).toHaveBeenCalledWith('sess-1', 'user-1')
    expect(tierScopes).toEqual(['verda'])
  })

  it('opens the anthropic position too, rather than skipping the scope', async () => {
    // The scope must be entered in BOTH positions: a run with no scope falls
    // back to the deployment default, so "skip it when the user picked
    // Anthropic" would silently ignore an opt-out on a Verda-default host.
    resolveConversationTier.mockResolvedValue('anthropic')

    await runTurnAndPersist(interactive())

    expect(tierScopes).toEqual(['anthropic'])
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
    })
    loadSession.mockResolvedValue({ ...STORED, status: 'paused' })
    await runTurnAndPersist({
      mode: 'approval',
      sessionId: 'sess-1',
      userId: 'user-1',
      approved: true,
    })

    expect(tierScopes).toHaveLength(3)
  })

  it('runs the turn anyway when the preference cannot be read', async () => {
    // A Postgres blip must cost the user their *preference*, not their answer.
    resolveConversationTier.mockRejectedValue(new Error('postgres is down'))

    const result = await runTurnAndPersist(interactive())

    expect(result.response).toBe('fresh:hello world, this is long')
    expect(tierScopes).toEqual(['anthropic']) // the deployment default
    expect(logged).toHaveBeenCalled()
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
    dbSaveConversation.mockImplementation(async () => {
      order.push('seed')
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
    const { clientOverrideFor } = await import('../../../lib/harness-patterns/clients.server')
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
    expect(dbSaveConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1', status: 'running' }),
    )
    expect(dbSetConversationStatus).toHaveBeenCalledWith('sess-1', 'user-1', 'error')
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
      }),
    ).rejects.toThrow(/the private inference box did not wake/)

    expect(dbSetConversationStatus).toHaveBeenCalledWith('run-wake', 'user-1', 'error')
    // A triggered run has no row to seed — `seedActionRow` already wrote it, and
    // touching it here would overwrite the trigger's own title.
    expect(dbSaveConversation).not.toHaveBeenCalled()
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

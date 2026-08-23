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
  loadSession.mockResolvedValue(null)
  runFirstTurnTitleGen.mockResolvedValue(null)
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  // Drain any detached summarization still in flight, so it cannot land in the
  // middle of the next test.
  await flush()
  logged.mockRestore()
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
    })
    expect(dbSaveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      runFresh.mock.invocationCallOrder[0],
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(result.response).toBe('fresh:hello world, this is long')
    expect(saveSession).toHaveBeenCalledWith('sess-1', 'user-1', 'search', 'serialized:sess-1')
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
    expect(saveSession).toHaveBeenCalledWith('sess-2', 'user-1', 'search', 'ctx-a+follow up')
  })

  it('starts fresh when the agent changed under an existing sessionId', async () => {
    loadSession.mockResolvedValue(STORED)

    const result = await runTurnAndPersist(
      interactive({ sessionId: 'sess-3', agentId: 'general', message: 'hi' }),
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-3', 'general')
    expect(result.response).toBe('fresh:hi')
    expect(saveSession).toHaveBeenCalledWith('sess-3', 'user-1', 'general', 'serialized:sess-3')
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
    expect(saveSession).toHaveBeenNthCalledWith(
      1,
      'sess-1',
      'user-1',
      'search',
      'serialized:sess-1',
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
    expect(saveSession).toHaveBeenNthCalledWith(1, 'run-1', 'user-1', 'search', 'serialized:run-1')
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
    expect(saveSession).toHaveBeenNthCalledWith(1, 'sess-7', 'user-1', 'general', 'resumed:true')
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

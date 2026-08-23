/**
 * General Agent — degraded-build and compactExecution-scoping behaviour (#27 review).
 *
 * `agents.test.ts` covers the config and the pattern shape. This file covers
 * the two things that only show up when something goes wrong:
 *
 *   - a graph-schema fetch that fails must be LOUD and must not be frozen
 *     into the conversation's cached patterns;
 *   - the compactExecution's view must not treat the planner's best-effort error as
 *     "the work failed", this turn or any turn after it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'
import type { ContextEvent, EventType, UnifiedContext } from '../../../../lib/harness-patterns'

const TOOLS = ['read_neo4j_cypher', 'get_neo4j_schema', 'search', 'Return']

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockDoNotCachePatterns = vi.fn()
vi.mock('../../../../lib/harness-client/session.server', () => ({
  doNotCachePatterns: (...args: unknown[]) => mockDoNotCachePatterns(...args),
}))

const schemaOk = mockCallTool({ responses: { get_neo4j_schema: { Concept: ['name'] } } })
const schemaFails = mockCallTool({ errors: { get_neo4j_schema: 'connection refused' } })
const currentCallTool = { fn: schemaOk }

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: (...args: [string, Record<string, unknown>?]) => currentCallTool.fn(...args),
  listTools: mockListTools(TOOLS),
}))

interface Pattern {
  name: string
  config: { patternId?: string; viewConfig?: unknown }
}

async function buildPatterns(sessionId = 'sess-1'): Promise<Pattern[]> {
  const { generalAgent } = await import('../../../../lib/harness-client/agents/general.server')
  return (await generalAgent.createPatterns(sessionId)) as unknown as Pattern[]
}

beforeEach(() => {
  vi.clearAllMocks()
  currentCallTool.fn = schemaOk
})

describe('general agent — graph schema failure', () => {
  it('warns and refuses the pattern cache when the schema is unavailable', async () => {
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const patterns = await buildPatterns('degraded-session')

    // Still usable — the agent runs blind rather than not at all.
    expect(patterns.map((p) => p.name)).toEqual(['planner', 'simpleLoop', 'compactExecution'])
    // …but loud, and rebuilt next turn instead of schema-less for the session.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('graph schema unavailable'))
    expect(warn.mock.calls[0][0]).toContain('connection refused')
    expect(mockDoNotCachePatterns).toHaveBeenCalledWith('degraded-session')

    warn.mockRestore()
  })

  it('caches normally when the schema resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await buildPatterns('healthy-session')

    expect(mockDoNotCachePatterns).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

type Ev = { type: EventType; ts: number; patternId: string; data: unknown }

function ctxOf(events: Ev[]): UnifiedContext<Record<string, unknown>> {
  return {
    sessionId: 'view-test',
    createdAt: 1,
    events: events as ContextEvent[],
    status: 'running',
    data: {},
    input: '',
  }
}

describe('general agent — compactExecution view scope', () => {
  async function synthView(events: Ev[]) {
    const patterns = await buildPatterns()
    const synth = patterns.find((p) => p.name === 'compactExecution')!
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
    return createEventView(ctxOf(events), synth.config.viewConfig as never, synth.config.patternId)
  }

  const planPatternError: Ev = {
    type: 'error',
    ts: 2,
    patternId: 'plan',
    data: { error: 'planner: 429 overloaded', severity: 'recoverable' },
  }
  const executeEvents: Ev[] = [
    { type: 'pattern_enter', ts: 3, patternId: 'execute', data: {} },
    {
      type: 'tool_result',
      ts: 4,
      patternId: 'execute',
      data: { tool: 'search', success: true, result: 'ok' },
    },
  ]

  it('does not report a best-effort planner error as a failed turn', async () => {
    const view = await synthView([
      {
        type: 'user_message',
        ts: 1,
        patternId: 'harness',
        data: { content: 'why is the sky blue?' },
      },
      planPatternError,
      ...executeEvents,
    ])

    expect(view.hasErrors()).toBe(false)
    expect(view.lastError()).toBeUndefined()
  })

  it('still sees the user message — this chain has nothing else to set the intent', async () => {
    const view = await synthView([
      {
        type: 'user_message',
        ts: 1,
        patternId: 'harness',
        data: { content: 'why is the sky blue?' },
      },
      ...executeEvents,
    ])

    const msg = view.fromAll().ofType('user_message').last(1).get()[0]
    expect((msg?.data as { content: string })?.content).toBe('why is the sky blue?')
  })

  it('still reports an executor error, and only from the current turn', async () => {
    const thisTurnError: Ev = {
      type: 'error',
      ts: 5,
      patternId: 'execute',
      data: { error: 'max turns exhausted', severity: 'recoverable' },
    }
    const view = await synthView([
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'turn 1' } },
      { type: 'error', ts: 2, patternId: 'execute', data: { error: 'an old turn-1 failure' } },
      { type: 'user_message', ts: 3, patternId: 'harness', data: { content: 'turn 2' } },
      ...executeEvents,
      thisTurnError,
    ])

    expect(view.hasErrors()).toBe(true)
    // Events persist across continueSession — the window must expire them, or
    // one bad turn makes the compactExecution apologise for the rest of the thread.
    expect(view.lastError()).toBe('max turns exhausted')
    expect(view.errors().count()).toBe(1)
  })
})

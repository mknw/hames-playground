/**
 * planner Pattern Tests (#27)
 *
 * Covers the pattern itself, the `formatPlanContext` rendering, and the
 * plumbing that carries `scope.data.plan` into the loop patterns' controllers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockListTools } from '../../../mocks/mcp'
import { mockFinalAction } from '../../../mocks/baml'
import type { ContextEvent, EventType, UnifiedContext } from '../../../../lib/harness-patterns'
import type {
  ControllerFnWithLLMData,
  CodeModeControllerFnWithLLMData,
  CriticFnWithLLMData,
} from '../../../../lib/harness-patterns/baml-adapters.server'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: true, data: {} })),
  listTools: mockListTools(['read_neo4j_cypher', 'search']),
}))

const mockPlanner = vi.fn()

vi.mock('../../../../../baml_client', () => ({
  b: {
    Planner: (...args: unknown[]) => mockPlanner(...args),
  },
}))

// Collector must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 120, outputTokens: 60 },
      calls: [
        {
          httpRequest: { body: { messages: [] } },
          provider: 'anthropic',
          clientName: 'PlannerAnthropic',
        },
      ],
    }
    constructor(_name?: string) {}
  }
  class MockBamlValidationError extends Error {}
  return { Collector: MockCollector, BamlValidationError: MockBamlValidationError }
})

type Ev = { type: EventType; ts: number; patternId: string; data: unknown }

function ctxOf(events: Ev[]): UnifiedContext<Record<string, unknown>> {
  const lastUser = events.filter((e) => e.type === 'user_message').slice(-1)[0]
  return {
    sessionId: 'test',
    createdAt: Date.now(),
    events: events as ContextEvent[],
    status: 'running',
    data: {},
    input: lastUser ? (lastUser.data as { content: string }).content : '',
  }
}

const PATTERN_ID = 'planner-test'
const TOOLS = ['read_neo4j_cypher', 'search']

const PLAN = {
  reasoning: 'The graph already holds the concepts; the web only adds recency.',
  plan: '1. Query the graph for Concept nodes.\n2. Search the web only for gaps found in step 1.',
  n_steps: 2,
}

async function load() {
  const { planner, formatPlanContext, DEFAULT_MAX_PLAN_CHARS } =
    await import('../../../../lib/harness-patterns/patterns/planner.server')
  const { createScope } = await import('../../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
  return { planner, formatPlanContext, DEFAULT_MAX_PLAN_CHARS, createScope, createEventView }
}

function userTurn(content: string): Ev[] {
  return [{ type: 'user_message', ts: Date.now(), patternId: 'harness', data: { content } }]
}

describe('planner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlanner.mockResolvedValue(PLAN)
  })

  it('exports a factory returning a ConfiguredPattern with the planner defaults', async () => {
    const { planner } = await load()
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })

    expect(pattern.name).toBe('planner')
    expect(pattern.config.patternId).toBe(PATTERN_ID)
    // The plan is the deliverable: always committed, tracked as plan_created,
    // and best-effort (a failure must not sink the chain).
    expect(pattern.config.commitStrategy).toBe('always')
    expect(pattern.config.trackHistory).toBe('plan_created')
    expect(pattern.config.errorSeverity).toBe('recoverable')
    // One LLM call per chain invocation — never a loop.
    expect(pattern.estimateTurns?.({ maxToolTurns: 5, maxRetries: 3 })).toBe(1)
  })

  it('writes scope.data.plan and emits a plan_created event with LLM call data', async () => {
    const { planner, createScope, createEventView } = await load()
    const ctx = ctxOf(userTurn('Which concepts are missing from the graph?'))
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(mockPlanner).toHaveBeenCalledTimes(1)
    expect((result.data as { plan?: typeof PLAN }).plan).toEqual(PLAN)

    const created = result.events.filter((e) => e.type === 'plan_created')
    expect(created).toHaveLength(1)
    const data = created[0].data as { plan: typeof PLAN; toolCount: number; truncated?: boolean }
    expect(data.plan.n_steps).toBe(2)
    expect(data.toolCount).toBe(2)
    expect(data.truncated).toBeUndefined()
    expect(created[0].llmCall?.functionName).toBe('Planner')
  })

  it('passes the user message, the intent and the schema to the BAML call', async () => {
    const { planner, createScope, createEventView } = await load()
    const ctx = ctxOf(userTurn('raw question'))
    const pattern = planner(TOOLS, { patternId: PATTERN_ID, schema: 'Node: Concept' })
    const scope = createScope(PATTERN_ID, { intent: 'compacted intent' })
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    await pattern.fn(scope, view)

    const [userMessage, intent, tools, context] = mockPlanner.mock.calls[0]
    expect(userMessage).toBe('raw question')
    expect(intent).toBe('compacted intent')
    // The planner sees the same catalog the executor will get.
    expect((tools as Array<{ name: string }>).map((t) => t.name)).toEqual(TOOLS)
    expect(context).toBe('Node: Concept')
  })

  it('caps the plan at maxPlanChars and flags the event as truncated', async () => {
    const { planner, createScope, createEventView } = await load()
    mockPlanner.mockResolvedValueOnce({ ...PLAN, plan: 'x'.repeat(500) })
    const ctx = ctxOf(userTurn('long plan please'))
    const pattern = planner(TOOLS, { patternId: PATTERN_ID, maxPlanChars: 50 })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    const plan = (result.data as { plan: { plan: string } }).plan
    expect(plan.plan.startsWith('x'.repeat(50))).toBe(true)
    expect(plan.plan).toContain('[truncated]')
    const created = result.events.find((e) => e.type === 'plan_created')!
    expect((created.data as { truncated?: boolean }).truncated).toBe(true)
  })

  it('does nothing when there is no user message in context', async () => {
    const { planner, createScope, createEventView } = await load()
    const ctx = ctxOf([])
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(mockPlanner).not.toHaveBeenCalled()
    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
    expect(result.events).toHaveLength(0)
  })

  it('is best-effort: a BAML failure leaves the plan unset and tracks an error', async () => {
    const { planner, createScope, createEventView } = await load()
    mockPlanner.mockRejectedValue(new Error('planner model unavailable'))
    const ctx = ctxOf(userTurn('plan this'))
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors[0].data)).toContain('planner model unavailable')
    // Best-effort: the downstream loop still runs.
    expect((errors[0].data as { severity?: string }).severity).toBe('recoverable')
  })
})

describe('formatPlanContext', () => {
  it('renders reasoning and steps under a labelled heading', async () => {
    const { formatPlanContext } = await load()
    const formatted = formatPlanContext(PLAN)!

    expect(formatted).toContain('PLAN (from previous step')
    expect(formatted).toContain(PLAN.reasoning)
    expect(formatted).toContain('Steps:')
    expect(formatted).toContain('1. Query the graph for Concept nodes.')
  })

  it('returns undefined for an absent or empty plan', async () => {
    const { formatPlanContext } = await load()

    expect(formatPlanContext(undefined)).toBeUndefined()
    expect(formatPlanContext({ reasoning: 'why', plan: '   ', n_steps: 0 })).toBeUndefined()
  })

  it('omits the reasoning line when the planner returned none', async () => {
    const { formatPlanContext } = await load()
    const formatted = formatPlanContext({ reasoning: '', plan: '1. Do it.', n_steps: 1 })!

    expect(formatted).toContain('1. Do it.')
    expect(formatted.split('\n')).toHaveLength(3)
  })
})

describe('plan plumbing into the loop patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('simpleLoop forwards a formatted plan to its controller as planContext', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const controller = vi.fn<ControllerFnWithLLMData>(async () => ({
      action: mockFinalAction('done'),
    }))
    const pattern = simpleLoop(controller, ['Return'], { patternId: 'exec' })
    const scope = createScope('exec', { intent: 'q', plan: PLAN })
    const view = createEventView(ctxOf(userTurn('q')))

    await pattern.fn(scope, view)

    // 10th positional arg of controller(...) is planContext
    const planContext = controller.mock.calls[0][9] as string
    expect(planContext).toContain('PLAN (from previous step')
    expect(planContext).toContain(PLAN.plan)
  })

  it('simpleLoop passes planContext undefined when no planner ran', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const controller = vi.fn<ControllerFnWithLLMData>(async () => ({
      action: mockFinalAction('done'),
    }))
    const pattern = simpleLoop(controller, ['Return'], { patternId: 'exec' })
    const scope = createScope('exec', { intent: 'q' })
    const view = createEventView(ctxOf(userTurn('q')))

    await pattern.fn(scope, view)

    expect(controller.mock.calls[0][9]).toBeUndefined()
  })

  it('actorCritic forwards a formatted plan to its actor as planContext', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const actor = vi.fn<CodeModeControllerFnWithLLMData>(async () => ({
      action: {
        reasoning: 'r',
        tool_name: 'Return',
        tool_args: 'done',
        status: 's',
        is_final: true,
      },
    }))
    const critic = vi.fn<CriticFnWithLLMData>(async () => ({
      result: { is_sufficient: true, explanation: 'ok' },
    }))
    const pattern = actorCritic(actor, critic, ['search'], { patternId: 'ac' })
    const scope = createScope('ac', { intent: 'q', plan: PLAN })
    const view = createEventView(ctxOf(userTurn('q')))

    await pattern.fn(scope, view)

    // 9th positional arg of actor(...) is planContext
    const planContext = actor.mock.calls[0][8] as string
    expect(planContext).toContain('PLAN (from previous step')
    expect(planContext).toContain(PLAN.plan)
  })
})

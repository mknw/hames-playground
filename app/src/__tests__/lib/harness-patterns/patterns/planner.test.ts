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
  ActorControllerFnWithLLMData,
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

  it('records the tool count the model was actually shown, not the name list', async () => {
    const { planner, createScope, createEventView } = await load()
    // 'not_a_real_tool' resolves to nothing in the mocked catalog, so the
    // model sees 2 descriptions while the factory was handed 3 names.
    const pattern = planner([...TOOLS, 'not_a_real_tool'], { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(
      ctxOf(userTurn('plan this')),
      pattern.config.viewConfig,
      PATTERN_ID,
    )

    const result = await pattern.fn(scope, view)

    const created = result.events.find((e) => e.type === 'plan_created')!
    expect((created.data as { toolCount: number }).toolCount).toBe(2)
  })

  it('emits a skipped plan_created when there is no user message in context', async () => {
    const { planner, createScope, createEventView } = await load()
    const ctx = ctxOf([])
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(mockPlanner).not.toHaveBeenCalled()
    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
    // Visible in the panel as a deliberate skip, not as a planner that never ran.
    const created = result.events.filter((e) => e.type === 'plan_created')
    expect(created).toHaveLength(1)
    expect((created[0].data as { skipped?: string }).skipped).toBe('no-message')
    expect((created[0].data as { plan?: unknown }).plan).toBeUndefined()
  })

  it('reads the user message through a view its own viewConfig cannot hide', async () => {
    const { planner, createScope, createEventView } = await load()
    // A caller-supplied viewConfig REPLACES the default. This one scopes to the
    // last pattern, which excludes the harness-level user_message — `fromAll()`
    // would inherit that filter and leave the planner with nothing to plan for.
    const pattern = planner(TOOLS, {
      patternId: PATTERN_ID,
      viewConfig: { fromLastNTurns: 3 },
    })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(
      ctxOf(userTurn('narrow view')),
      pattern.config.viewConfig,
      PATTERN_ID,
    )

    const result = await pattern.fn(scope, view)

    expect(mockPlanner).toHaveBeenCalledTimes(1)
    expect(mockPlanner.mock.calls[0][0]).toBe('narrow view')
    expect((result.data as { plan?: unknown }).plan).toEqual(PLAN)
  })

  it('treats an empty plan as an error, not as a plan', async () => {
    const { planner, createScope, createEventView } = await load()
    // `PlanResult.plan` is a required string and '' satisfies it: the pattern
    // would store it, report "0 steps" in the panel, and inject nothing.
    mockPlanner.mockResolvedValue({ reasoning: 'thought about it', plan: '   ', n_steps: 0 })
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(
      ctxOf(userTurn('plan this')),
      pattern.config.viewConfig,
      PATTERN_ID,
    )

    const result = await pattern.fn(scope, view)

    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
    expect(result.events.filter((e) => e.type === 'plan_created')).toHaveLength(0)
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors[0].data)).toContain('empty plan')
    // Thrown as an LLMCallError carrying the call that produced the empty
    // plan: this is the failure whose prompt you most need to read, so the
    // panel must keep its drill-down rather than get a bare Error.
    expect((errors[0].data as { kind?: string }).kind).toBe('llm_call')
    expect((errors[0] as { llmCall?: { clientName?: string } }).llmCall?.clientName).toBe(
      'PlannerAnthropic',
    )
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

/**
 * `scope.data` is carried from turn to turn: the harness resets only
 * `hasError` / `errorMessage` / `response`, and `serializeContext` is a plain
 * `JSON.stringify`. So every planner exit path that produces no NEW plan must
 * actively clear the old one — otherwise turn 2 executes turn 1's plan, under
 * wording that tells it to prefer the plan over its own judgement.
 */
describe('planner — a carried-over plan never survives a turn without one', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlanner.mockResolvedValue(PLAN)
  })

  it('clears turn 1s plan when the BAML call fails on turn 2', async () => {
    const { planner, formatPlanContext, createScope, createEventView } = await load()
    mockPlanner.mockRejectedValue(new Error('overloaded'))
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    // Turn 2 opens with turn 1's plan already in data — exactly what the chain
    // forwards and what `deserializeContext` restores.
    const scope = createScope(PATTERN_ID, { plan: PLAN })
    const view = createEventView(
      ctxOf([
        ...userTurn('how many nodes are in the graph?'),
        ...userTurn("what's the weather in Paris?"),
      ]),
      pattern.config.viewConfig,
      PATTERN_ID,
    )

    const result = await pattern.fn(scope, view)

    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
    // The executor gets nothing to follow — not the previous question's plan.
    expect(formatPlanContext((result.data as { plan?: typeof PLAN }).plan)).toBeUndefined()
  })

  it('clears a carried plan when there is no user message to plan for', async () => {
    const { planner, createScope, createEventView } = await load()
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, { plan: PLAN })
    const view = createEventView(ctxOf([]), pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
  })

  it('clears a carried plan when the new plan comes back empty', async () => {
    const { planner, createScope, createEventView } = await load()
    mockPlanner.mockResolvedValue({ reasoning: '', plan: '', n_steps: 0 })
    const pattern = planner(TOOLS, { patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, { plan: PLAN })
    const view = createEventView(
      ctxOf(userTurn('a new question')),
      pattern.config.viewConfig,
      PATTERN_ID,
    )

    const result = await pattern.fn(scope, view)

    expect((result.data as { plan?: unknown }).plan).toBeUndefined()
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

    const actor = vi.fn<ActorControllerFnWithLLMData>(async () => ({
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

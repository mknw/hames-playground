/**
 * Raw-LLM visibility on a failed call (#225 owner review).
 *
 * When a model's response cannot be used — BAML could not coerce it, the
 * `tool_args` were cut off at the output cap, the tool name is not on the
 * allowlist, the router invented a route — the ONLY record of what was
 * actually said is `llmCall.rawOutput`. Every `error` event on such a path
 * must carry it; a path that drops it makes the failure undebuggable from the
 * UI, which is the recurring complaint this file exists to prevent.
 *
 * Two families are pinned here, and they fail differently if regressed:
 *  1. the CALL failed → the adapters wrap it as `LLMCallError` so the raw
 *     response survives the throw, and the pattern re-attaches it;
 *  2. the call SUCCEEDED and its CONTENT is the defect → the pattern must
 *     carry the very llmCall it already has in hand onto the error event.
 *
 * Hermetic: `baml_client` and MCP are mocked, and the "collector" is a plain
 * object shaped like `Collector.last` (the adapters only read `.last`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockAction } from '../../mocks/baml'
import { mockCallTool, mockListTools, fixtures } from '../../mocks/mcp'
import type { Collector } from '@boundaryml/baml'
import type { ContextEvent, ErrorEventData, LLMCallData } from '~/lib/harness-patterns/types'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

/** `routeMessageOp` delegates to the REAL implementation by default, so the
 *  router tests below exercise the whole adapter → pattern chain. One test
 *  overrides it, because a `vi.fn()` BAML mock cannot populate a real
 *  Collector and the invented-route path reads the SUCCESSFUL call's llmCall. */
const routeMessageOp = vi.fn()
vi.mock('../../../lib/harness-patterns/routing.server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, routeMessageOp: (...args: unknown[]) => routeMessageOp(...args) }
})

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({ responses: { read_neo4j_cypher: fixtures.neo4j.queryResult } }),
  listTools: mockListTools(['read_neo4j_cypher', 'Return']),
}))

const mockLoopController = vi.fn()
const mockActorController = vi.fn()
const mockCritic = vi.fn()
const mockRouter = vi.fn()
const mockReferenceSelector = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    LoopController: mockLoopController,
    ActorController: mockActorController,
    Critic: mockCritic,
    Router: mockRouter,
    ReferenceSelector: mockReferenceSelector,
  },
}))

/** What the model said, verbatim: the real shape of the failure this fixes —
 *  a tool name and a JSON blob emitted as prose instead of the required
 *  `{reasoning, tool_name, tool_args}` object. */
const RAW_TEXT = 'sandbox_write\n\n{"path":"/work/parse_pdf.py","content":"import pymupdf"}'

/** Collector whose last call carries `RAW_TEXT` and stays well below the cap,
 *  so nothing can be mistaken for truncation. */
const fakeCollector = (rawLlmResponse = RAW_TEXT): Collector =>
  ({
    last: {
      usage: { inputTokens: 554, outputTokens: 2452, cachedInputTokens: 19_514 },
      calls: [{ selected: true, provider: 'anthropic', clientName: 'AnthropicSonnet5' }],
      rawLlmResponse,
    },
  }) as unknown as Collector

/** The single `error` event a pattern run produced. */
const errorEvent = (events: ContextEvent[]) => {
  const found = events.find((e) => e.type === 'error')
  expect(found, 'the run emitted no error event').toBeTruthy()
  return found as ContextEvent & { data: ErrorEventData; llmCall?: LLMCallData }
}

/** A controller/actor result whose call succeeded — the CONTENT is the defect. */
const succeededWith = (action: Partial<Parameters<typeof mockAction>[0]>) => ({
  action: mockAction(action),
  llmCall: {
    functionName: 'LoopController',
    variables: {},
    rawOutput: RAW_TEXT,
  } as LLMCallData,
})

const runPattern = async (
  pattern: { fn: (scope: never, view: never) => Promise<{ events: ContextEvent[] }> },
  data: Record<string, unknown> = {},
  content = 'convert the PDF',
) => {
  const { createScope } = await import('../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../lib/harness-patterns/patterns')
  const scope = createScope('vis-test', data)
  const view = createEventView({
    sessionId: 'test',
    createdAt: 1,
    events: [{ type: 'user_message', ts: 1, patternId: 'harness', data: { content } }],
    status: 'running',
    data: {},
    input: content,
  })
  const result = await pattern.fn(scope as never, view as never)
  return result.events
}

beforeEach(async () => {
  vi.clearAllMocks()
  const actual = await vi.importActual<
    typeof import('../../../lib/harness-patterns/routing.server')
  >('../../../lib/harness-patterns/routing.server')
  routeMessageOp.mockImplementation(actual.routeMessageOp)
})

// ============================================================================
// 1. The call failed — adapters must carry the raw response through the throw
// ============================================================================

describe('adapters: a failed BAML call carries rawOutput through the throw', () => {
  it('LoopController wraps a BamlValidationError as LLMCallError with rawOutput', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')
    mockLoopController.mockRejectedValue(
      new BamlValidationError('prompt', RAW_TEXT, 'missing reasoning', 'missing reasoning'),
    )

    const controller = createLoopControllerAdapter(['read_neo4j_cypher'])
    const err = await controller('q', 'i', '[]', 0, undefined, fakeCollector()).catch((e) => e)

    expect(err).toBeInstanceOf(LLMCallError)
    expect((err as InstanceType<typeof LLMCallError>).llmCall.rawOutput).toBe(RAW_TEXT)
  })

  it('routeMessageOp wraps a failed Router the same way — it used to throw bare', async () => {
    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    const { BamlValidationError } = await import('@boundaryml/baml')
    const { Collector: RealCollector } = await import('@boundaryml/baml')
    mockRouter.mockRejectedValue(
      new BamlValidationError('prompt', RAW_TEXT, 'missing route', 'missing route'),
    )

    // A real Collector: the adapter reads `.last`, and BAML never populated it
    // here, so this also pins that the wrap survives an EMPTY collector — the
    // caller still gets `functionName` + `variables` to render.
    const err = await routeMessageOp('hi', [], undefined, new RealCollector('router')).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(LLMCallError)
    expect((err as InstanceType<typeof LLMCallError>).llmCall.functionName).toBe('Router')
  })
})

// ============================================================================
// 2. simpleLoop — every LLM-attributable break carries the response
// ============================================================================

describe('simpleLoop: error events carry the response that caused them', () => {
  const loop = async (controller: unknown, tools = ['read_neo4j_cypher']) => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    return runPattern(
      simpleLoop(controller as never, tools, { patternId: 'vis-test', maxTurns: 2 }) as never,
    )
  }

  it('a failed controller call → kind llm_call + rawOutput', async () => {
    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const controller = vi.fn().mockRejectedValue(
      new LLMCallError('BamlValidationError: missing reasoning', {
        functionName: 'LoopController',
        variables: {},
        rawOutput: RAW_TEXT,
      }),
    )

    const err = errorEvent(await loop(controller))
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })

  it('unparseable tool_args → the response that produced them', async () => {
    const controller = vi
      .fn()
      .mockResolvedValue(
        succeededWith({ tool_name: 'read_neo4j_cypher', tool_args: 'not json at all' }),
      )

    const err = errorEvent(await loop(controller))
    expect(err.data.error).toContain('Invalid tool_args JSON')
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })

  it('a tool name off the allowlist → the response that named it', async () => {
    const controller = vi
      .fn()
      .mockResolvedValue(succeededWith({ tool_name: 'sandbox_write', tool_args: '{}' }))

    const err = errorEvent(await loop(controller))
    expect(err.data.error).toContain('Tool not allowed')
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })

  it('a genuine TOOL failure carries no llmCall — the response was fine', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')
    const controller = vi
      .fn()
      .mockResolvedValue(succeededWith({ tool_name: 'boom_tool', tool_args: '{}' }))
    vi.mocked(
      (await import('../../../lib/harness-patterns/mcp-client.server')).callTool,
    ).mockResolvedValue({ success: false, error: 'gateway down', data: null })

    const events = await runPattern(
      simpleLoop(controller as never, ['boom_tool'], {
        patternId: 'vis-test',
        maxTurns: 1,
      }) as never,
    )
    const err = errorEvent(events)
    expect(err.data.error).toContain('gateway down')
    expect(err.data.kind).toBeUndefined()
    expect(err.llmCall).toBeUndefined()
  })
})

// ============================================================================
// 3. actorCritic — the in-loop content defects
// ============================================================================

describe('actorCritic: error events carry the actor response', () => {
  const run = async (actor: unknown, tools = ['read_neo4j_cypher']) => {
    const { actorCritic } =
      await import('../../../lib/harness-patterns/patterns/actorCritic.server')
    const critic = vi
      .fn()
      .mockResolvedValue({ result: { is_sufficient: false, explanation: 'no' } })
    return runPattern(
      actorCritic(actor as never, critic as never, tools, {
        patternId: 'vis-test',
        maxRetries: 1,
      }) as never,
    )
  }

  it('a failed actor call → rawOutput on the error event', async () => {
    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const actor = vi.fn().mockRejectedValue(
      new LLMCallError('BamlValidationError: missing tool_name', {
        functionName: 'ActorController',
        variables: {},
        rawOutput: RAW_TEXT,
      }),
    )

    const err = errorEvent(await run(actor))
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })

  it('unparseable tool_args → rawOutput on the error event', async () => {
    const actor = vi
      .fn()
      .mockResolvedValue(
        succeededWith({ tool_name: 'read_neo4j_cypher', tool_args: '{"query": unquoted,,,' }),
      )

    const events = await run(actor)
    const err = events.find(
      (e) => e.type === 'error' && (e.data as ErrorEventData).error.includes('tool_args'),
    ) as ContextEvent & { data: ErrorEventData; llmCall?: LLMCallData }
    expect(err, 'no tool_args error event').toBeTruthy()
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })

  it('a tool name off the allowlist → rawOutput on the error event', async () => {
    const actor = vi
      .fn()
      .mockResolvedValue(succeededWith({ tool_name: 'sandbox_write', tool_args: '{}' }))

    const events = await run(actor)
    const err = events.find(
      (e) => e.type === 'error' && (e.data as ErrorEventData).error.includes('Tool not allowed'),
    ) as ContextEvent & { data: ErrorEventData; llmCall?: LLMCallData }
    expect(err, 'no allowlist error event').toBeTruthy()
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })
})

// ============================================================================
// 4. router — the first LLM call of every turn
// ============================================================================

describe('router: error events carry the response', () => {
  const run = async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    return runPattern(router({ neo4j: 'Database queries' }) as never)
  }

  it('a failed Router call → rawOutput, end to end through routeMessageOp', async () => {
    const { BamlValidationError } = await import('@boundaryml/baml')
    mockRouter.mockRejectedValue(
      new BamlValidationError('prompt', RAW_TEXT, 'missing route', 'missing route'),
    )

    const err = errorEvent(await run())
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.functionName).toBe('Router')
  })

  it('an invented route name → the response that invented it', async () => {
    // `routeMessageOp` nulls `tool_name` when the model names a route that is
    // not in `routeDescriptions` (the live "Router mismatch" failure), and
    // hands the successful call's llmCall back alongside it.
    routeMessageOp.mockResolvedValue({
      intent: 'convert it',
      tool_call_needed: true,
      tool_name: null,
      response_text: '',
      llmCall: { functionName: 'Router', variables: {}, rawOutput: RAW_TEXT } as LLMCallData,
    })

    const err = errorEvent(await run())
    expect(err.data.error).toContain('no tool_name')
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.rawOutput).toBe(RAW_TEXT)
  })
})

// ============================================================================
// 5. withReferences — the selector's failure is reported by that event alone
// ============================================================================

describe('withReferences: a failed selector call carries rawOutput', () => {
  it('reports the raw response on the error event', async () => {
    const { withReferences } =
      await import('../../../lib/harness-patterns/patterns/with-references.server')
    const { BamlValidationError } = await import('@boundaryml/baml')
    mockReferenceSelector.mockRejectedValue(
      new BamlValidationError('prompt', RAW_TEXT, 'missing selected', 'missing selected'),
    )

    const inner = {
      name: 'inner',
      fn: async (s: unknown) => s,
      config: { patternId: 'inner' },
    }
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')
    const scope = createScope('vis-test', {})
    // Two candidate tool_results — one is the `skipped: 'single'` fast path.
    const view = createEventView({
      sessionId: 'test',
      createdAt: 1,
      events: [
        { id: 'ev-1', type: 'user_message', ts: 1, patternId: 'h', data: { content: 'q' } },
        {
          id: 'ev-2',
          type: 'tool_result',
          ts: 2,
          patternId: 'h',
          data: { tool: 'a', success: true, result: { x: 1 } },
        },
        {
          id: 'ev-3',
          type: 'tool_result',
          ts: 3,
          patternId: 'h',
          data: { tool: 'b', success: true, result: { y: 2 } },
        },
      ],
      status: 'running',
      data: {},
      input: 'q',
    })

    const pattern = withReferences(inner as never, { patternId: 'vis-test' })
    const result = await pattern.fn(scope as never, view as never)

    const err = errorEvent(result.events)
    expect(err.data.kind).toBe('llm_call')
    expect(err.llmCall?.functionName).toBe('ReferenceSelector')
  })
})

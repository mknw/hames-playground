/** Real committed BAML, synthetic loopback only; no live eval is invoked. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRegistry } from '@boundaryml/baml'
import { b } from '@hames-ai/harness-baml/guarded-client.server'
import { plannerScenario, isThinkingPlannerRun } from './scenarios/planner'
import { runScenario, scenarioPassed } from './harness'
import * as harness from './harness'
import { resolveEvalRouting, type EvalRouting } from './client'
import { renderReport } from './report'

const PLAN = { plan: '1. Call get_neo4j_schema.\n2. Call read_neo4j_cypher.', n_steps: 2 }
const TRACE = 'Synthetic parser trace, distinct from content reasoning.'
const routing: EvalRouting = { client: 'VerdaQwenThink', routed: ['planner'], note: 'synthetic' }
let server: Server
let endpoint: string
let requests: Array<{ body: Record<string, unknown>; url?: string; authorization?: string }>
let responses: Array<{ content?: string; reasoning?: string; tokens?: number | null }>

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    const body = JSON.parse(raw)
    requests.push({ body, url: req.url, authorization: req.headers.authorization })
    const reply = responses.shift()
    if (!reply) {
      res.writeHead(500)
      res.end('Unexpected synthetic request')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'synthetic',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: reply.content, reasoning: reply.reasoning },
          },
        ],
        usage:
          reply.tokens === null
            ? undefined
            : { prompt_tokens: 100, completion_tokens: reply.tokens ?? 30, total_tokens: 130 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  requests = []
  responses = []
  vi.stubEnv('VERDA_INFERENCE_ENDPOINT', endpoint)
  vi.stubEnv('VERDA_INFERENCE_API_KEY', 'synthetic-key')
  vi.stubEnv('EVAL_PLANNER_N', '1')
  // Stop a mutation that loses the explicit private client before native BAML
  // can dispatch to an original function's declared public chain.
  const original = b.Planner.bind(b)
  vi.spyOn(b, 'Planner').mockImplementation((...args) => {
    expect(args[4]?.client).toBe('VerdaQwen')
    return original(...args)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function pair(tokens = 1000) {
  responses.push({
    content: JSON.stringify({ ...PLAN, reasoning: 'CONTENT DECOY' }),
    reasoning: TRACE,
    tokens,
  })
  responses.push({
    content: JSON.stringify({ ...PLAN, reasoning: 'Written reasoning.' }),
    tokens: 50,
  })
}

describe('planner thinking eval wiring (manual hermetic)', () => {
  it('uses the twin at 8192/340s, preserves sampling, compares the same box and reports inclusive tokens', async () => {
    pair(5000) // Above the shipped cap, below the measurement cap.
    const registry = vi.spyOn(ClientRegistry.prototype, 'addLlmClient')
    const result = await runScenario(plannerScenario, routing)
    expect(result.error).toBeUndefined()
    expect(result.checks.filter((c) => !c.pass)).toEqual([])
    expect(scenarioPassed(result)).toBe(true)
    expect(registry).toHaveBeenCalledWith(
      'VerdaQwenThink',
      'openai-generic',
      expect.objectContaining({
        max_tokens: 8192,
        temperature: 1,
        top_p: 0.95,
        top_k: 20,
        http: { connect_timeout_ms: 30_000, request_timeout_ms: 340_000 },
      }),
    )
    expect(requests).toHaveLength(2)
    expect(requests[0].body).toMatchObject({
      max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: true },
    })
    expect(requests[1].body).toMatchObject({
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(requests[0].url).toBe(requests[1].url)
    expect(requests[0].authorization).toBe(requests[1].authorization)
    expect(requests[0].body.model).toBe(requests[1].body.model)
    const onPrompt = JSON.stringify(requests[0].body.messages)
    expect(onPrompt).not.toContain('"reasoning": string')
    expect(onPrompt).not.toContain('short paragraph of reasoning')
    expect(JSON.stringify(requests[1].body.messages)).toContain('short paragraph of reasoning')
    expect(result.servedBy).toEqual(['VerdaQwenThink', 'VerdaQwen'])
    expect(result.calls.map((c) => c.outputTokens)).toEqual([5000, 50])
    const report = renderReport([result], {
      routing,
      startedAt: '2026-01-01T00:00:00Z',
      totalMs: 1,
    })
    expect(report).toContain('completion tokens (trace + answer) | [5000]')
    expect(report).toContain('p50=5000; p95=5000; max=5000')
    expect(report).toContain(`reasoning: ${TRACE.length}`)
    const shipped = await b.request.PlannerThinking('synthetic', 'synthetic', [], undefined)
    expect(shipped.body.json()).toMatchObject({ max_tokens: 4096 })
  })

  it('retains every sample and computes the trace-plus-answer distribution', async () => {
    vi.stubEnv('EVAL_PLANNER_N', '3')
    responses.push(
      ...[100, 6000, 300].map((tokens) => ({
        content: JSON.stringify(PLAN),
        reasoning: TRACE,
        tokens,
      })),
    )
    responses.push(
      ...[30, 50, 40].map((tokens) => ({
        content: JSON.stringify({ ...PLAN, reasoning: 'written' }),
        tokens,
      })),
    )
    const result = await runScenario(plannerScenario, routing)
    expect(scenarioPassed(result)).toBe(true)
    expect(result.calls).toHaveLength(6)
    expect(result.observations).toContainEqual({
      name: 'VerdaQwenThink completion tokens (trace + answer)',
      value: '[100,6000,300]',
    })
    expect(result.observations).toContainEqual({
      name: 'VerdaQwenThink token distribution',
      value: 'reported=3/3; min=100; p50=300; p95=6000; max=6000',
    })
  })

  it.each([
    [
      'no parser trace',
      { content: JSON.stringify({ ...PLAN, reasoning: 'content is not a trace' }), tokens: 40 },
      'reasoning is a non-empty parser trace',
    ],
    [
      'parser delimiter',
      { content: `draft </think> ${JSON.stringify(PLAN)}`, reasoning: TRACE, tokens: 40 },
      'content contains no </think>',
    ],
    [
      'trace consumes the cap',
      { content: '', reasoning: TRACE, tokens: 8192 },
      'the plan fits under the output cap with headroom',
    ],
    [
      'missing usage',
      { content: JSON.stringify(PLAN), reasoning: TRACE, tokens: null },
      'the plan fits under the output cap with headroom',
    ],
    [
      'no plan',
      { content: JSON.stringify({ plan: '', n_steps: 0 }), reasoning: TRACE, tokens: 40 },
      'the plan is not empty',
    ],
    [
      'unparseable envelope',
      { content: '{broken', reasoning: TRACE, tokens: 40 },
      'the envelope parsed',
    ],
    [
      'no offered tool',
      {
        content: JSON.stringify({ plan: '1. Review records.', n_steps: 1 }),
        reasoning: TRACE,
        tokens: 40,
      },
      'the plan names at least one tool',
    ],
    [
      'wrong step count',
      { content: JSON.stringify({ ...PLAN, n_steps: 20 }), reasoning: TRACE, tokens: 40 },
      'n_steps is in the region',
    ],
    [
      'invented tool',
      {
        content: JSON.stringify({ plan: '1. Call export_to_powerpoint.', n_steps: 1 }),
        reasoning: TRACE,
        tokens: 40,
      },
      'the plan does not name the tool',
    ],
  ])(
    'fails loudly for %s without retrying or losing the sample',
    async (_label, reply, failedCheck) => {
      responses.push(reply, {
        content: JSON.stringify({ ...PLAN, reasoning: 'written' }),
        tokens: 20,
      })
      const result = await runScenario(plannerScenario, routing)
      expect(result.error).toBeUndefined()
      expect(scenarioPassed(result)).toBe(false)
      expect(result.checks.some((c) => c.name.includes(failedCheck) && !c.pass)).toBe(true)
      expect(requests).toHaveLength(2)
      expect(result.calls).toHaveLength(2)
      expect(
        result.observations.find(
          (o) => o.name === 'VerdaQwenThink completion tokens (trace + answer)',
        )?.value,
      ).toBe(reply.tokens === null ? '[]' : `[${reply.tokens}]`)
    },
  )

  it('requires thinking off to return nonempty content and no parser trace', async () => {
    pair()
    responses[1].reasoning = 'Unexpected synthetic trace'
    const result = await runScenario(plannerScenario, routing)
    expect(result.checks.some((c) => c.name.includes('thinking off has content') && !c.pass)).toBe(
      true,
    )
  })

  it('fails when the selected leaf does not match the requested one', async () => {
    pair()
    vi.spyOn(harness, 'servedBy').mockReturnValue('SyntheticOtherClient')
    const result = await runScenario(plannerScenario, routing)
    expect(result.checks.some((c) => c.name.includes('the selected leaf') && !c.pass)).toBe(true)
  })

  it('leaves an ordinary private planner run at the shipped pair with no extra calls', async () => {
    responses.push({ content: JSON.stringify({ ...PLAN, reasoning: 'written' }), tokens: 20 })
    const result = await runScenario(plannerScenario, {
      client: 'VerdaQwen',
      routed: ['planner'],
      note: 'synthetic',
    })
    expect(scenarioPassed(result)).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
    })
  })

  it('rejects broad twin runs before any preflight or scenario request', () => {
    expect(isThinkingPlannerRun(routing, [plannerScenario])).toBe(true)
    expect(() =>
      isThinkingPlannerRun({ ...routing, routed: ['planner', 'screen'] }, [plannerScenario]),
    ).toThrow(/EVAL_ROLES=planner/)
    expect(() =>
      isThinkingPlannerRun(routing, [plannerScenario, { ...plannerScenario, id: 'other' }]),
    ).toThrow(/EVAL_ONLY/)
    expect(() =>
      isThinkingPlannerRun({ ...routing, routed: ['screen'] }, [plannerScenario]),
    ).toThrow(/EVAL_ROLES=planner/)
    expect(() =>
      isThinkingPlannerRun(routing, [
        { ...plannerScenario, id: 'screen-on-the-tier', role: 'screen' },
      ]),
    ).toThrow(/EVAL_ONLY/)
    expect(isThinkingPlannerRun({ ...routing, client: undefined }, [plannerScenario])).toBe(false)
    expect(requests).toEqual([])
  })

  it('validates sample count before any call and resolves the documented opt-in', async () => {
    vi.stubEnv('EVAL_CLIENT', 'VerdaQwenThink')
    vi.stubEnv('EVAL_ROLES', 'planner')
    expect(resolveEvalRouting()).toMatchObject({ client: 'VerdaQwenThink', routed: ['planner'] })
    vi.stubEnv('EVAL_PLANNER_N', '0')
    const result = await runScenario(plannerScenario, routing)
    expect(result.error).toContain('positive integer')
    expect(requests).toEqual([])
  })

  it('refuses a comparison with a different transport before sending either call', async () => {
    const original = b.request.Planner.bind(b.request)
    vi.spyOn(b.request, 'Planner').mockImplementation(async (...args) => {
      const request = await original(...args)
      return {
        url: `${request.url}/different`,
        headers: request.headers,
        body: request.body,
      } as typeof request
    })
    const result = await runScenario(plannerScenario, routing)
    expect(result.error).toContain('same endpoint, credentials and model')
    expect(requests).toEqual([])
  })
})

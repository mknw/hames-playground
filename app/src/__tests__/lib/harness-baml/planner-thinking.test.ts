/** @vitest-environment node */
/** #625 S3: real committed BAML + adapter + planner, synthetic loopback only. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../lib/inference/config.server'
import { createPlannerAdapter } from '@hames-ai/harness-baml/baml-adapters.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { planner, formatPlanContext } from '@hames-ai/harness-patterns/patterns/planner.server'
import { createScope } from '@hames-ai/harness-patterns/context.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import type { PlanCreatedEventData, UnifiedContext } from '@hames-ai/harness-patterns/types'
import {
  observeLlmUsage,
  type LlmUsageSample,
} from '@hames-ai/harness-patterns/llm-usage-observer.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn(async () => []),
}))

const ANSWER = { plan: '1. Search synthetic records.', n_steps: 1 }
const OFF = { ...ANSWER, reasoning: 'Written reasoning.' }
const TRACE = 'Full synthetic trace.\n'.repeat(400)
let server: Server
let endpoint: string
let replies: Array<{
  content: string | null
  reasoning_content?: string
  reasoning?: string
  tokens?: number
  status?: number
}>
let requests: Array<Record<string, unknown>>
let samples: LlmUsageSample[]
let stopObserving: () => void

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    requests.push(JSON.parse(raw))
    const reply = replies.shift()
    if (!reply) {
      res.writeHead(500)
      res.end('Unexpected request')
      return
    }
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    if (reply.status && reply.status >= 400) {
      res.end(JSON.stringify({ error: { message: 'Synthetic endpoint unavailable' } }))
      return
    }
    res.end(
      JSON.stringify({
        id: 'synthetic-completion',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic',
        choices: [
          {
            index: 0,
            finish_reason: reply.tokens === 4096 ? 'length' : 'stop',
            message: {
              role: 'assistant',
              content: reply.content,
              reasoning_content: reply.reasoning_content,
              reasoning: reply.reasoning,
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: reply.tokens ?? 20,
          total_tokens: 10 + (reply.tokens ?? 20),
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  stopObserving = observeLlmUsage((sample) => samples.push(sample))
})
afterAll(async () => {
  stopObserving()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  replies = []
  requests = []
  samples = []
})

function run<T>(fn: () => Promise<T>, client = 'VerdaQwenThink', tier = 'verda') {
  return withRunFrame(
    {
      inference: {
        tier,
        clientOverride: (role) =>
          role === 'planner'
            ? {
                client,
                env: {
                  VERDA_INFERENCE_ENDPOINT: endpoint,
                  VERDA_INFERENCE_API_KEY: 'synthetic-key',
                },
              }
            : undefined,
      },
    },
    fn,
  )
}
const call = () => createPlannerAdapter([])('Synthetic request', 'Synthetic intent')
function scopeAndView() {
  const ctx: UnifiedContext<Record<string, unknown>> = {
    sessionId: 'synthetic-session',
    createdAt: 0,
    status: 'running',
    data: {},
    input: 'Synthetic request',
    events: [
      { type: 'user_message', ts: 0, patternId: 'user', data: { content: 'Synthetic request' } },
    ],
  }
  return { scope: createScope('planner-test', {}), view: createEventView(ctx) }
}

describe('Planner thinking mode', () => {
  it.each(['reasoning_content', 'reasoning'] as const)(
    'restores the full selected trace from %s, prices it and uses the no-reasoning schema',
    async (field) => {
      replies.push({ content: JSON.stringify(ANSWER), [field]: TRACE })
      const result = await run(call)
      expect(result.plan).toEqual({ ...ANSWER, reasoning: TRACE })
      expect(result.llmCall?.clientName).toBe('VerdaQwenThink')
      expect(result.llmCall?.functionName).toBe('PlannerThinking')
      expect(result.llmCall?.metrics?.basis).toBe('time')
      expect(requests).toHaveLength(1)
      expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(JSON.stringify(requests[0].messages)).not.toContain('reasoning: string')
      expect(samples).toHaveLength(1)
      expect(samples[0].clientName).toBe('VerdaQwenThink')
    },
  )

  it.each([undefined, 40])(
    'caps only executor reasoning while events and call records keep the full trace (cap %s)',
    async (maxReasoningChars) => {
      replies.push({ content: JSON.stringify(ANSWER), reasoning: TRACE })
      const { scope, view } = scopeAndView()
      const result = await run(() =>
        planner(createPlannerAdapter([]), [], { maxReasoningChars }).fn(scope, view),
      )
      const plan = result.data.plan as typeof OFF
      const cap = maxReasoningChars ?? 2000
      expect(plan.reasoning).toBe(TRACE.slice(0, cap) + '…[truncated]')
      const event = result.events.find((event) => event.type === 'plan_created')!
      const data = event.data as PlanCreatedEventData
      expect(data.plan?.reasoning).toBe(TRACE)
      expect(data.reasoningTruncated).toBe(true)
      expect(event.llmCall?.parsedOutput).toEqual({ ...ANSWER, reasoning: TRACE })
      expect(formatPlanContext(plan)).not.toContain(TRACE)
      expect(formatPlanContext(plan)).toContain(plan.reasoning)
    },
  )

  it.each([undefined, '', '   '])(
    'rejects a valid answer without a trace and never retries (trace %j)',
    async (reasoning) => {
      replies.push({ content: JSON.stringify(ANSWER), reasoning })
      await expect(run(call)).rejects.toThrow(/no thinking trace/)
      expect(requests).toHaveLength(1)
    },
  )

  it('leaves private thinking-off calls on the original and its written reasoning', async () => {
    replies.push({ content: JSON.stringify(OFF) })
    const result = await run(call, 'VerdaQwen')
    expect(result.plan).toEqual(OFF)
    expect(result.llmCall?.functionName).toBe('Planner')
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(JSON.stringify(requests[0].messages)).toContain('reasoning: string')
  })

  it('refuses a thinking twin on the Anthropic tier before any call', async () => {
    await expect(run(call, 'VerdaQwenThink', 'anthropic')).rejects.toThrow(/private tier/i)
    expect(requests).toHaveLength(0)
  })

  it.each([
    { content: '', reasoning_content: TRACE, tokens: 4096 },
    { content: null, reasoning: TRACE },
    { content: '{"plan":', reasoning: TRACE, tokens: 4096 },
    { content: JSON.stringify({ plan: '', n_steps: 0 }), reasoning_content: TRACE },
  ])(
    'retries a no-answer response once on the original on the same box and records the attempt',
    async (reply) => {
      replies.push(reply, { content: JSON.stringify(OFF) })
      const { scope, view } = scopeAndView()
      const pattern = planner(createPlannerAdapter([]), [], { patternId: 'planner-test' })
      const result = await run(() => pattern.fn(scope, view))
      expect(requests).toHaveLength(2)
      expect(requests.map((r) => r.chat_template_kwargs)).toEqual([
        { enable_thinking: true },
        { enable_thinking: false },
      ])
      expect(JSON.stringify(requests[1].messages)).toContain('reasoning: string')
      expect(JSON.stringify(requests[1].messages)).not.toContain('tool_args compact')
      expect(result.events.filter((e) => e.type === 'warning')).toHaveLength(1)
      expect(result.events.find((e) => e.type === 'warning')?.llmCall?.clientName).toBe(
        'VerdaQwenThink',
      )
      expect(result.events.find((e) => e.type === 'plan_created')?.llmCall?.clientName).toBe(
        'VerdaQwen',
      )
      expect(samples.map((s) => s.clientName)).toEqual(['VerdaQwenThink', 'VerdaQwen'])
      expect(result.data.plan).toEqual(OFF)
    },
  )

  it('never retries a failed same-box retry for a third call, keeping its warning and terminal error', async () => {
    replies.push({ content: '', reasoning_content: TRACE }, { content: 'not a plan' })
    const { scope, view } = scopeAndView()
    const result = await run(() => planner(createPlannerAdapter([]), []).fn(scope, view))
    expect(requests).toHaveLength(2)
    expect(result.events.map((e) => e.type)).toEqual(['warning', 'error'])
    expect(result.data.plan).toBeUndefined()
    expect(samples).toHaveLength(2)
  })

  it('fails loudly on content-side think tags even when BAML parsed a draft', async () => {
    const draft = JSON.stringify({ plan: 'DRAFT PLAN', n_steps: 1 })
    replies.push({
      content: `${draft}\nMention </think> inside trace.\n${draft}\n</think>\n${JSON.stringify(ANSWER)}`,
    })
    const failure = await run(call).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      message: expect.stringMatching(/reasoning parser.*<\/think>/i),
      llmCall: { parsedOutput: ANSWER },
    })
    expect(requests).toHaveLength(1)
  })

  it('does not retry a malformed nonempty answer or an HTTP error', async () => {
    replies.push({ content: 'not a plan', reasoning_content: TRACE })
    await expect(run(call)).rejects.toThrow()
    expect(requests).toHaveLength(1)
    replies.push({ content: '', status: 503 })
    await expect(run(call)).rejects.toThrow()
    expect(requests).toHaveLength(2)
    expect(samples.at(-1)?.metrics).toMatchObject({ attempts: 1, basis: 'time' })
  })
})

/** @vitest-environment node */
/** #625 S3: real committed BAML + adapter + planner, synthetic loopback only. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRegistry, Collector } from '@boundaryml/baml'
import {
  clientOverrideFor,
  resolveClientForRole,
  configureConsumerClients,
  SELF_DEPLOYED_CLIENT_BY_ROLE,
} from '@hames-ai/harness-baml/clients.server'
import * as clientPolicy from '@hames-ai/harness-baml/clients.server'
import type { BamlRole } from '@hames-ai/harness-baml/clients.server'
import '../../../lib/inference/config.server'
import {
  createPlannerAdapter,
  createLoopControllerAdapter,
  createActorControllerAdapter,
  createCriticAdapter,
  createInjectionScreen,
  describeToolResultOp,
  describeToolResultsBatchOp,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { routeMessageOp } from '@hames-ai/harness-baml/routing.server'
import {
  createCompactIntentAdapter,
  createRetrieveQueryAdapter,
  createMemoryExtractAdapter,
  createMemoryCompactAdapter,
} from '@hames-ai/harness-baml/baml-patterns.server'
import { createTitleAgent } from '@hames-ai/agents/agents/title-generator.server'
import { defaultSelector, defaultSynthesize } from '@hames-ai/harness-baml/defaults.server'
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
let transports: Array<{ url: string | undefined; authorization: string | undefined }>
let samples: LlmUsageSample[]
let stopObserving: () => void
let onRequest: (() => void) | undefined

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    requests.push(JSON.parse(raw))
    onRequest?.()
    transports.push({ url: req.url, authorization: req.headers.authorization })
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
          // The provider-reported call cost in USD, OpenRouter-shaped (the
          // probe verified `usage.cost` on every response). The 27B leaves
          // price from it since the eval switch moved them to the provider
          // basis; the input/output token names here are the legacy OpenAI
          // ones, so the buckets still come from the Collector's usage.
          cost: 0.01,
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
  onRequest = undefined
  replies = []
  requests = []
  transports = []
  samples = []
})

function run<T>(fn: () => Promise<T>, client = 'LargeQwenThink', tier = 'self_deployed') {
  return withRunFrame(
    {
      inference: {
        tier,
        clientOverride: (role) =>
          role === 'planner'
            ? {
                client,
                env: {
                  LARGE_LLM_BASE_URL: endpoint,
                  LARGE_LLM_API_KEY: 'synthetic-key',
                },
              }
            : undefined,
      },
    },
    fn,
  )
}
afterEach(() => {
  configureConsumerClients(undefined)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function registryRun<T>(registry: ClientRegistry, fn: () => Promise<T>, client = 'LargeQwenThink') {
  return withRunFrame(
    {
      inference: {
        tier: 'self_deployed',
        clientOverride: () => ({
          client,
          clientRegistry: registry,
          env: {
            LARGE_LLM_BASE_URL: endpoint,
            LARGE_LLM_API_KEY: 'default-synthetic-key',
          },
        }),
      },
    },
    fn,
  )
}
function registered(
  registry: ClientRegistry,
  name: string,
  url = endpoint,
  key = 'synthetic-key',
  model = 'Qwen/Qwen3.8-27B-FP8',
) {
  registry.addLlmClient(name, 'openai-generic', {
    base_url: url,
    api_key: key,
    model,
    chat_template_kwargs: { enable_thinking: name === 'LargeQwenThink' },
  })
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
  it.each(['per-run', 'consumer'] as const)(
    'refuses a %s override carrying its own collector at both routing lookups',
    async (layer) => {
      const registry = new ClientRegistry()
      registry.addLlmClient('Hidden', 'fallback', { strategy: ['LargeQwenThink'] })
      const override = () => ({
        client: 'Hidden',
        clientRegistry: registry,
        collector: new Collector('x'),
      })
      if (layer === 'consumer') configureConsumerClients(override)
      await withRunFrame(
        {
          inference: {
            tier: 'self_deployed',
            clientOverride: layer === 'per-run' ? override : undefined,
          },
        },
        async () => {
          for (const lookup of [clientOverrideFor, resolveClientForRole]) {
            expect(() => lookup('controller')).toThrow(/collector/)
          }
          await expect(createLoopControllerAdapter()('q', 'i', '[]', 0)).rejects.toThrow(
            /collector/,
          )
        },
      )
      expect(requests).toHaveLength(0)
      expect(samples).toHaveLength(0)
    },
  )

  it('preserves the loop collector when an unsafe bag bypasses routing validation', async () => {
    const registry = new ClientRegistry()
    registry.addLlmClient('Hidden', 'fallback', { strategy: ['LargeQwenThink'] })
    replies.push({
      content: JSON.stringify({
        reasoning: 'draft',
        tool_name: 'Return',
        tool_args: '{"response":"draft"}',
      }),
    })
    const failure = await registryRun<unknown>(
      registry,
      async () => {
        // Independently pin call-site ordering, even if trusted code replaces the routing seam.
        const unsafe = { ...clientOverrideFor('controller')!, collector: new Collector('x') }
        vi.spyOn(clientPolicy, 'clientOverrideFor').mockReturnValue(unsafe)
        return createLoopControllerAdapter()('q', 'i', '[]', 0)
      },
      'Hidden',
    ).catch((e: unknown) => e)
    expect(failure).toMatchObject({
      recoverable: false,
      message: expect.stringContaining('LoopController selected a thinking leaf'),
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(samples).toHaveLength(1)
  })

  it('preserves the title accounting collector against bare consumer deps', async () => {
    const registry = new ClientRegistry()
    registered(registry, 'LargeQwenThink')
    registry.addLlmClient('Hidden', 'fallback', { strategy: ['LargeQwenThink'] })
    replies.push({ content: 'draft', reasoning: TRACE })
    // This dependency deliberately bypasses clientOverrideFor, like a standalone consumer.
    const result = await createTitleAgent({
      toolNamespaces: () => undefined,
      clientOverride: () => ({
        client: 'Hidden',
        clientRegistry: registry,
        collector: new Collector('x'),
      }),
    })('q', 'bare-consumer-title')
    expect(result).toMatchObject({
      status: 'error',
      context: {
        error: expect.stringContaining('GenerateConversationTitle selected a thinking leaf'),
      },
    })
    expect(result.response).not.toBe('draft')
    expect(requests).toHaveLength(1)
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(samples).toHaveLength(1)
  })

  it.each(
    ['Sneaky', 'LargeQwen'].flatMap((name) =>
      ['valid', 'capped', 'http-failure'].map((response) => ({ name, response })),
    ),
  )(
    'refuses thinking enabled in the rendered request under registry name $name ($response)',
    async ({ name, response }) => {
      const registry = new ClientRegistry()
      registry.addLlmClient(name, 'openai-generic', {
        base_url: endpoint,
        api_key: 'synthetic-key',
        model: 'synthetic',
        chat_template_kwargs: { enable_thinking: true },
      })
      replies.push({
        content:
          response === 'capped'
            ? ''
            : JSON.stringify({
                reasoning: 'draft',
                tool_name: 'Return',
                tool_args: '{"response":"draft"}',
              }),
        tokens: response === 'capped' ? 4096 : 20,
        status: response === 'http-failure' ? 503 : 200,
      })
      const failure = await registryRun<unknown>(
        registry,
        () => createLoopControllerAdapter()('q', 'i', '[]', 0),
        name,
      ).catch((e: unknown) => e)
      expect(failure).toMatchObject({
        recoverable: false,
        message: expect.stringContaining('LoopController selected a thinking leaf'),
        llmCall: { clientName: name, parsedOutput: undefined },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(samples).toHaveLength(1)
    },
  )

  it.each(
    ['LoopController', 'ActorController', 'Planner'].flatMap((name) =>
      [200, 503].map((status) => ({ name, status })),
    ),
  )(
    'refuses thinking first selected on the $name corrective retry status $status',
    async ({ name, status }) => {
      const registry = new ClientRegistry()
      registered(registry, 'LargeQwen')
      registered(registry, 'LargeQwenThink')
      registry.addLlmClient('Alternating', 'fallback', { strategy: ['LargeQwen'] })
      onRequest = () => {
        registry.addLlmClient('Alternating', 'fallback', { strategy: ['LargeQwenThink'] })
        onRequest = undefined
      }
      replies.push(
        { content: '', tokens: 4096 },
        {
          content: JSON.stringify(
            name === 'Planner'
              ? OFF
              : { reasoning: 'draft', tool_name: 'Return', tool_args: '{"response":"draft"}' },
          ),
          reasoning: TRACE,
          status,
        },
      )
      const invoke =
        name === 'Planner'
          ? call
          : name === 'LoopController'
            ? () => createLoopControllerAdapter()('q', 'i', '[]', 0)
            : () => createActorControllerAdapter([])('q', 'i', [], [])
      const failure = await registryRun<unknown>(registry, invoke, 'Alternating').catch(
        (e: unknown) => e,
      )
      expect(failure).toMatchObject({
        recoverable: false,
        message: expect.stringContaining(`${name} selected a thinking leaf`),
        llmCall: {
          functionName: name,
          clientName: 'LargeQwenThink',
          parsedOutput: undefined,
        },
      })
      expect(requests).toHaveLength(2)
      expect(samples).toHaveLength(1)
      // Both attempts billed when the retry also returned a 200 (usage and
      // cost on both); on the 503 variant the retry reported no usage and no
      // cost, and on the provider basis an attempt the provider priced
      // nothing for is neither billed nor counted — which is why the 200
      // shape used to be the only number here.
      expect(samples[0].metrics?.attempts).toBe(status === 200 ? 2 : 1)
    },
  )

  it.each(['reasoning_content', 'reasoning'] as const)(
    'restores the full selected trace from %s, prices it and uses the no-reasoning schema',
    async (field) => {
      replies.push({ content: JSON.stringify(ANSWER), [field]: TRACE })
      const result = await run(call)
      expect(result.plan).toEqual({ ...ANSWER, reasoning: TRACE })
      expect(result.llmCall?.clientName).toBe('LargeQwenThink')
      expect(result.llmCall?.functionName).toBe('PlannerThinking')
      expect(result.llmCall?.metrics?.basis).toBe('provider')
      expect(requests).toHaveLength(1)
      expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(JSON.stringify(requests[0].messages)).not.toContain('reasoning: string')
      expect(samples).toHaveLength(1)
      expect(samples[0].clientName).toBe('LargeQwenThink')
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
    'accepts a valid answer without a trace and records a warning without retry (trace %j)',
    async (reasoning) => {
      replies.push({ content: JSON.stringify(ANSWER), reasoning })
      const { scope, view } = scopeAndView()
      const result = await run(() => planner(createPlannerAdapter([]), []).fn(scope, view))
      expect(result.data.plan).toEqual({ ...ANSWER, reasoning: '' })
      expect(result.events.map((e) => e.type)).toEqual(['warning', 'plan_created'])
      expect(result.events[0].data).toMatchObject({ task: 'planner', message: 'no thinking trace' })
      expect(result.events[1].llmCall?.parsedOutput).toEqual({ ...ANSWER, reasoning: '' })
      expect(samples).toHaveLength(1)
      expect(requests).toHaveLength(1)
    },
  )

  it.each(['per-run', 'consumer'] as const)(
    'refuses the twin at both seam readers from %s bags before any request',
    async (layer) => {
      for (const tier of ['anthropic', 'self_deployed']) {
        for (const role of [
          'controller',
          'critic',
          'describe',
          'screen',
          'router',
          'synthesizer',
          'decide',
          'planner',
        ] as BamlRole[]) {
          if (role === 'planner' && tier === 'self_deployed') continue
          const override = () => ({ client: 'LargeQwenThink' })
          if (layer === 'consumer') configureConsumerClients(override)
          await withRunFrame(
            { inference: { tier, ...(layer === 'per-run' ? { clientOverride: override } : {}) } },
            async () => {
              expect(() => clientOverrideFor(role)).toThrow(/thinking.*planner.*private tier/i)
              expect(() => resolveClientForRole(role)).toThrow(/thinking.*planner.*private tier/i)
            },
          )
        }
      }
      expect(requests).toHaveLength(0)
    },
  )

  it.each(['controller', 'planner'] as const)(
    'refuses a real %s adapter before any request on a disallowed tier/role',
    async (role) => {
      const { createLoopControllerAdapter } =
        await import('@hames-ai/harness-baml/baml-adapters.server')
      const action: () => Promise<unknown> = () =>
        role === 'planner' ? call() : createLoopControllerAdapter()('q', 'i', '[]', 0)
      for (const tier of role === 'planner' ? ['anthropic'] : ['anthropic', 'self_deployed']) {
        await expect(
          withRunFrame(
            { inference: { tier, clientOverride: () => ({ client: 'LargeQwenThink' }) } },
            action,
          ),
        ).rejects.toThrow(/private tier/i)
      }
      expect(requests).toHaveLength(0)
    },
  )

  it.each(['endpoint', 'credentials', 'model', 'registered counterpart'] as const)(
    'refuses a Q6 transport mismatch in %s before sending the retry',
    async (mismatch) => {
      const registry = new ClientRegistry()
      registered(
        registry,
        'LargeQwenThink',
        endpoint.replace('/v1', '/eval/v1'),
        'eval-synthetic-key',
      )
      if (mismatch !== 'registered counterpart') {
        registered(
          registry,
          'LargeQwen',
          mismatch === 'endpoint' ? endpoint : endpoint.replace('/v1', '/eval/v1'),
          mismatch === 'credentials' ? 'default-synthetic-key' : 'eval-synthetic-key',
          mismatch === 'model' ? 'other-synthetic-model' : undefined,
        )
      }
      replies.push({ content: '', reasoning: TRACE }, { content: JSON.stringify(OFF) })
      const failure = await registryRun(registry, call).catch((e: unknown) => e)
      expect(failure).toMatchObject({ message: expect.stringMatching(/same.*transport/i) })
      expect(requests).toHaveLength(1)
      expect(transports).toEqual([
        { url: '/eval/v1/chat/completions', authorization: 'Bearer eval-synthetic-key' },
      ])
    },
  )

  it('supports a matching registered pair for exactly one thinking-off retry, preserving the bag env over process env', async () => {
    vi.stubEnv('LARGE_LLM_BASE_URL', endpoint.replace('/v1', '/process/v1'))
    vi.stubEnv('LARGE_LLM_API_KEY', 'process-synthetic-key')
    const registry = new ClientRegistry()
    for (const name of ['LargeQwenThink', 'LargeQwen'])
      registered(registry, name, endpoint.replace('/v1', '/eval/v1'), 'eval-synthetic-key')
    replies.push({ content: '', reasoning: TRACE }, { content: JSON.stringify(OFF) })
    expect((await registryRun(registry, call)).plan).toEqual(OFF)
    expect(transports).toEqual(
      Array(2).fill({
        url: '/eval/v1/chat/completions',
        authorization: 'Bearer eval-synthetic-key',
      }),
    )
    expect(requests.map((r) => r.chat_template_kwargs)).toEqual([
      { enable_thinking: true },
      { enable_thinking: false },
    ])
  })

  it('keeps bag env when using the declared counterpart even if process env points elsewhere', async () => {
    vi.stubEnv('LARGE_LLM_BASE_URL', endpoint.replace('/v1', '/process/v1'))
    vi.stubEnv('LARGE_LLM_API_KEY', 'process-synthetic-key')
    replies.push({ content: '', reasoning: TRACE }, { content: JSON.stringify(OFF) })
    expect((await run(call)).plan).toEqual(OFF)
    expect(transports).toEqual(
      Array(2).fill({ url: '/v1/chat/completions', authorization: 'Bearer synthetic-key' }),
    )
  })

  it('refuses a retry whose collector selected another leaf despite a matching rendered transport', async () => {
    const registry = new ClientRegistry()
    registered(registry, 'LargeQwenThink')
    registered(registry, 'SyntheticOriginal')
    registry.addLlmClient('LargeQwen', 'fallback', { strategy: ['SyntheticOriginal'] })
    replies.push({ content: '', reasoning: TRACE }, { content: JSON.stringify(OFF) })
    const failure = await registryRun(registry, call).catch((e: unknown) => e)
    expect(failure).toMatchObject({
      message: expect.stringMatching(/retry.*select/i),
      llmCall: { clientName: 'SyntheticOriginal' },
    })
    expect(requests).toHaveLength(2)
  })

  it('derives the thinking-off retry client from the planner role map', async () => {
    // Deliberately change the fixture's map to distinguish a lookup from a literal.
    const roleMap = SELF_DEPLOYED_CLIENT_BY_ROLE as Partial<Record<BamlRole, string>>
    const original = roleMap.planner
    const registry = new ClientRegistry()
    registered(registry, 'LargeQwenThink')
    registered(registry, 'SyntheticOriginal')
    replies.push({ content: '', reasoning: TRACE }, { content: JSON.stringify(OFF) })
    try {
      roleMap.planner = 'SyntheticOriginal'
      const result = await registryRun(registry, call)
      expect(result.plan).toEqual(OFF)
      expect(result.llmCall?.clientName).toBe('SyntheticOriginal')
      expect(requests).toHaveLength(2)
    } finally {
      roleMap.planner = original
    }
  })

  it('refuses a thinking leaf selected through an original-schema registry chain', async () => {
    const registry = new ClientRegistry()
    registered(registry, 'LargeQwenThink')
    registry.addLlmClient('SyntheticOriginalChain', 'fallback', {
      strategy: ['LargeQwenThink'],
    })
    replies.push({ content: JSON.stringify(OFF), reasoning: TRACE })
    const failure = await registryRun(registry, call, 'SyntheticOriginalChain').catch(
      (e: unknown) => e,
    )
    expect(failure).toMatchObject({
      message: expect.stringMatching(/Planner selected a thinking leaf/),
      llmCall: { clientName: 'LargeQwenThink' },
    })
    expect(requests).toHaveLength(1)
  })

  it.each(
    [
      {
        name: 'LoopController',
        call: () => createLoopControllerAdapter()('q', 'i', '[]', 0),
        answer: { reasoning: 'Written', tool_name: 'Return', tool_args: '{"response":"draft"}' },
      },
      {
        name: 'ActorController',
        call: () => createActorControllerAdapter([])('q', 'i', [], []),
        answer: { reasoning: 'Written', tool_name: 'Return', tool_args: '{"response":"draft"}' },
      },
      {
        name: 'Critic',
        call: () => createCriticAdapter()('i', []),
        answer: { explanation: 'Synthetic verdict', is_sufficient: true },
      },
      {
        name: 'ResultDescribe',
        call: () => describeToolResultOp('synthetic', '{}', '', 'Synthetic result'),
        answer: 'Synthetic summary',
      },
      {
        name: 'ScreenUntrustedContent',
        call: () =>
          createInjectionScreen()({ tool: 'synthetic', namespace: 'web', content: 'Text' }),
        answer: { injection_detected: false, reason: 'Synthetic verdict', spans: [] },
      },
      {
        name: 'Router',
        call: () => routeMessageOp('q', []),
        answer: { intent: 'i', needs_tool: false, route: null, response: 'draft' },
      },
      {
        name: 'Synthesize',
        call: () =>
          defaultSynthesize({ mode: 'message', userMessage: 'q', intent: 'i', response: 'draft' }),
        answer: 'draft',
      },
      {
        name: 'CompactIntent',
        call: () => createCompactIntentAdapter()({ history: [], latest: 'q' }),
        answer: 'draft',
      },
      {
        name: 'RetrieveQuery',
        call: () => createRetrieveQueryAdapter()({ history: [], latest: 'q' }),
        answer: 'draft',
      },
      {
        name: 'ExtractMemory',
        call: () =>
          createMemoryExtractAdapter()({ kindHint: 'preference', window: 'q', latestUser: 'q' }),
        answer: [],
      },
      {
        name: 'CompactMemories',
        call: () => createMemoryCompactAdapter()({ kind: 'preference', members: [] }),
        answer: { content: 'draft', evidence: 'q' },
      },
      {
        name: 'ResultDescribeBatch',
        call: () =>
          describeToolResultsBatchOp([
            { id: 'a', tool: 'x', toolArgs: '{}', reasoning: '', result: 'x' },
          ]),
        answer: { summaries: [{ id: 'a', summary: 'draft' }] },
      },
      {
        name: 'GenerateConversationTitle',
        call: () =>
          createTitleAgent({
            toolNamespaces: () => undefined,
            clientOverride: () => clientOverrideFor('describe'),
          })('q', 'synthetic-title'),
        answer: 'draft',
      },
      {
        name: 'ReferenceSelector',
        call: () => defaultSelector({ intent: 'i', recentMessages: [], candidates: [] }),
        answer: { reasoning: 'Written', selected: [] },
      },
    ].flatMap((site) => [200, 503].map((status) => ({ ...site, status }))),
  )(
    'refuses a hidden thinking leaf in $name status $status before returning any result',
    async ({ name, call, answer, status }) => {
      const registry = new ClientRegistry()
      registry.addLlmClient('SyntheticHiddenThinking', 'fallback', {
        strategy: ['LargeQwenThink'],
      })
      const content = typeof answer === 'string' ? answer : JSON.stringify(answer)
      replies.push({ content, reasoning: TRACE, status })
      const failure = await registryRun<unknown>(registry, call, 'SyntheticHiddenThinking').catch(
        (e: unknown) => e,
      )
      if (name === 'GenerateConversationTitle') {
        // The real title harness catches the refusal and publishes its error state.
        expect(failure).toMatchObject({
          status: 'error',
          context: { error: expect.stringContaining(`${name} selected a thinking leaf`) },
        })
        expect((failure as { response?: string }).response).not.toBe(content)
      } else {
        expect(failure).toMatchObject({
          message: expect.stringMatching(new RegExp(`${name} selected a thinking leaf`)),
          recoverable: false,
          llmCall: { functionName: name, clientName: 'LargeQwenThink' },
        })
        if (status === 200)
          expect((failure as { llmCall: { rawOutput: string } }).llmCall.rawOutput).toBe(content)
        expect(
          (failure as { llmCall: { parsedOutput?: unknown } }).llmCall.parsedOutput,
        ).toBeUndefined()
      }
      expect(requests).toHaveLength(1)
      expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
      expect(samples).toHaveLength(1)
      expect(samples[0].clientName).toBe('LargeQwenThink')
    },
  )

  it.each(['LoopController', 'ActorController'] as const)(
    'does not retry a hidden thinking leaf with an empty capped %s completion',
    async (name) => {
      const registry = new ClientRegistry()
      registry.addLlmClient('SyntheticHiddenThinking', 'fallback', {
        strategy: ['LargeQwenThink'],
      })
      replies.push({ content: '', reasoning: TRACE, tokens: 4096 })
      const call = () =>
        name === 'LoopController'
          ? createLoopControllerAdapter()('q', 'i', '[]', 0)
          : createActorControllerAdapter([])('q', 'i', [], [])
      const failure = await registryRun(registry, call, 'SyntheticHiddenThinking').catch(
        (e: unknown) => e,
      )
      expect(failure).toMatchObject({
        message: expect.stringMatching(/selected a thinking leaf/),
        recoverable: false,
        llmCall: {
          clientName: 'LargeQwenThink',
          hitOutputCap: true,
          usage: { outputTokens: 4096 },
        },
      })
      expect(requests).toHaveLength(1)
      expect(samples).toHaveLength(1)
    },
  )

  it('retains a terminal malformed-answer trace in the durable error call without a downstream plan', async () => {
    replies.push({ content: 'not a plan', reasoning: TRACE, tokens: 20 })
    const { scope, view } = scopeAndView()
    const result = await run(() => planner(createPlannerAdapter([]), []).fn(scope, view))
    expect(result.data.plan).toBeUndefined()
    expect(result.events.map((e) => e.type)).toEqual(['error'])
    expect(result.events[0].llmCall).toMatchObject({
      rawOutput: 'not a plan',
      parsedOutput: { reasoning: TRACE },
    })
    expect(requests).toHaveLength(1)
  })

  it('excludes the full event trace from LLM serialization while preserving plan text, n_steps and skipped', () => {
    const ctx: UnifiedContext = {
      sessionId: 's',
      createdAt: 0,
      status: 'running',
      input: 'q',
      data: {},
      events: [
        {
          type: 'plan_created',
          ts: 0,
          patternId: 'p',
          data: { plan: { ...ANSWER, reasoning: TRACE }, toolCount: 0 },
        },
        {
          type: 'plan_created',
          ts: 1,
          patternId: 'p',
          data: { skipped: 'no-message', toolCount: 0 },
        },
      ],
    }
    const xml = createEventView(ctx).serialize()
    expect(xml).not.toContain(TRACE)
    expect(xml).not.toContain('reasoning')
    expect(xml).toContain(ANSWER.plan)
    expect(xml).toContain('"n_steps":1')
    expect(xml).toContain('"skipped":"no-message"')
    expect((ctx.events[0].data as PlanCreatedEventData).plan?.reasoning).toBe(TRACE)
  })

  it('leaves private thinking-off calls on the original and its written reasoning', async () => {
    replies.push({ content: JSON.stringify(OFF) })
    const result = await run(call, 'LargeQwen')
    expect(result.plan).toEqual(OFF)
    expect(result.llmCall?.functionName).toBe('Planner')
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(JSON.stringify(requests[0].messages)).toContain('reasoning: string')
  })

  it('refuses a thinking twin on the Anthropic tier before any call', async () => {
    await expect(run(call, 'LargeQwenThink', 'anthropic')).rejects.toThrow(/private tier/i)
    expect(requests).toHaveLength(0)
  })

  it.each([
    { content: '', reasoning_content: TRACE, tokens: 4096 },
    { content: null, reasoning: TRACE },
    { content: '' },
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
        'LargeQwenThink',
      )
      expect(result.events.find((e) => e.type === 'plan_created')?.llmCall?.clientName).toBe(
        'LargeQwen',
      )
      expect(samples.map((s) => s.clientName)).toEqual(['LargeQwenThink', 'LargeQwen'])
      expect(samples.map((s) => s.metrics?.attempts)).toEqual([1, 1])
      expect(result.events.map((e) => e.llmCall?.metrics?.attempts)).toEqual([1, 1])
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

  it.each([JSON.stringify(ANSWER), 'not a plan'])(
    'retains the parser trace alongside rejected tail diagnostics (%s)',
    async (tail) => {
      replies.push({ content: `Draft </think> ${tail}`, reasoning: TRACE })
      const failure = await run(call).catch((e: unknown) => e)
      expect(failure).toMatchObject({
        message: expect.stringMatching(/reasoning parser.*<\/think>/i),
        recoverable: false,
        llmCall: { parsedOutput: { reasoning: TRACE, ...(tail === 'not a plan' ? {} : ANSWER) } },
      })
      expect(samples).toHaveLength(1)
      expect(requests).toHaveLength(1)
    },
  )

  it('does not retry a malformed nonempty answer or an HTTP error', async () => {
    replies.push({ content: 'not a plan', reasoning_content: TRACE })
    await expect(run(call)).rejects.toThrow()
    expect(requests).toHaveLength(1)
    replies.push({ content: '', status: 503 })
    await expect(run(call)).rejects.toThrow()
    expect(requests).toHaveLength(2)
    // The 503 reported no usage and no cost: on the provider basis the call
    // spent nothing the provider measured, so its sample carries no metrics
    // at all — the same honest absence a pre-flight failure has always had.
    expect(samples.at(-1)?.metrics).toBeUndefined()
  })
})

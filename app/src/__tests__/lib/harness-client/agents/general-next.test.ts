/** #507 S3 layer-1 composition pins. Production patterns/guards and the
 * systemone adapter run; only inference and the gateway are scripted. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../mocks/namespace-catalog'
import '../../../../lib/inference/config.server'
import {
  collectToolNames,
  createContext,
  createEventView,
  createScope,
  harness,
  harnessHasRedisRetriever,
  harnessPseudonymisesInputs,
  harnessUsesMemory,
  harnessUsesSyncWorkspace,
  inferServer,
  withRunFrame,
  type ConfiguredPattern,
  type ControllerFn,
  type CompactExecutionInput,
  type MemoryConfig,
} from '@hames-ai/harness-patterns'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox'
import { MCP_TOOL_CATALOG, mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentData, AgentDeps } from '@hames-ai/agents'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const GRAPH = [
  'graph_me',
  'graph_calendar_today',
  'graph_mail_recent',
  'graph_mail_attachments',
  'graph_files_search',
  'graph_files_list',
  'graph_files_recent',
  'graph_files_shared',
  'graph_file_ingest',
]
const INFO = ['get_neo4j_schema', 'read_neo4j_cypher', 'search', 'fetch', 'fetch_content']
const SANDBOX = V0_IN_VM_SERVERS.flatMap((s) => Object.values(s.tools))
const gateway = vi.hoisted(() => ({ names: [] as string[], result: 'synthetic result' as unknown }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: gateway.names.map((name) => ({ name, inputSchema: {} })),
    }))
    callTool = vi.fn(async ({ name }: { name: string }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(name === 'get_neo4j_schema' ? { Node: ['name'] } : gateway.result),
        },
      ],
    }))
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const mocks = vi.hoisted(() => ({
  controller: vi.fn<ControllerFn>(),
  actor: vi.fn<ControllerFn>(),
  screen: vi.fn(async (_input: { tool: string }) => ({
    injection_detected: false,
    reason: 'clean',
    spans: [],
  })),
  synthesize: vi.fn(async (_input: CompactExecutionInput) => ({ value: 'synthetic answer' })),
  planner: vi.fn(async () => ({
    plan: { reasoning: 'plan', plan: 'Use the earlier result.', n_steps: 1 },
  })),
  selector: vi.fn(async () => ({ selected: [], reasoning: 'none' })),
}))
vi.mock('@hames-ai/harness-baml', async (original) => ({
  ...(await original<object>()),
  createLoopControllerAdapter: () => mocks.controller,
  createActorControllerAdapter: () => mocks.actor,
  createCriticAdapter: () => async () => ({ result: { is_sufficient: true, explanation: 'done' } }),
  createInjectionScreen: () => mocks.screen,
  bamlPatterns: () => ({
    planner: () => mocks.planner,
    synthesize: mocks.synthesize,
    selector: mocks.selector,
    retrieveQuery: async ({ latest }: { latest: string }) => ({ value: latest }),
  }),
}))

let agent: typeof import('@hames-ai/agents/agents/general-next.server').generalNextAgent
beforeAll(async () => {
  agent = (await import('@hames-ai/agents/agents/general-next.server')).generalNextAgent
})

const attach = vi.fn<NonNullable<AgentDeps['withSandbox']>>((config) => (pattern) => ({
  ...pattern,
  name: `withSandbox(${pattern.name})`,
  children: [pattern],
  capabilities: {
    ...pattern.capabilities,
    tools: [...(pattern.capabilities?.tools ?? []), ...SANDBOX],
    workspaceSync: config.syncWorkspace,
  },
}))
const deps: AgentDeps = {
  toolNamespaces: mcpNamespace,
  withSandbox: attach,
  createRedisBackend: () => ({ name: 'redis', type: 'vector', search: async () => [] }),
  pseudonymiseForWeb: async () => ({ apply: (value) => value, check: () => {} }),
}
let choices: string[]
let states: string[]
let requests: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  gateway.names = [
    ...GRAPH,
    ...INFO,
    'query_database',
    'write_neo4j_cypher',
    'search_redis_documents',
  ]
  gateway.result = 'synthetic result'
  choices = ['info-retrieval', 'answer']
  states = []
  mocks.screen.mockImplementation(async () => ({
    injection_detected: false,
    reason: 'clean',
    spans: [],
  }))
  mocks.controller.mockImplementation(async () => ({
    action: {
      reasoning: 'clean reasoning',
      tool_name: 'Return',
      tool_args: 'SYNTHETIC-ROUTE-CONTENT',
      is_final: true,
    },
  }))
  for (const [key, value] of Object.entries({
    JEV_DECISIONS_URL: 'http://127.0.0.1:59998/v1/systemone',
    JEV_DECISIONS_API_KEY: 'synthetic',
    SMALL_LLM_DECISIONS_URL: 'http://127.0.0.1:59997/v1/systemone',
    SMALL_LLM_API_KEY: 'synthetic',
    SMALL_LLM_BASE_URL: 'http://127.0.0.1:59997/v1',
    VERDA_INFERENCE_ENDPOINT: 'http://127.0.0.1:59996/v1',
    USE_VERDA_INFERENCE: '0',
  }))
    vi.stubEnv(key, value)
  requests = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    states.push(body.state)
    const choice = choices.shift() ?? 'answer'
    const keys = Object.keys(body.questions.next_step.criteria)
    return Response.json({
      answers: {
        next_step: {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
        },
      },
      usage: { input_tokens: 1, output_tokens: 0 },
    })
  })
  vi.stubGlobal('fetch', requests)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function walk(patterns: ConfiguredPattern<AgentData>[]): ConfiguredPattern<AgentData>[] {
  return patterns.flatMap((p) => [p, ...walk(p.children ?? [])])
}
async function run(tier = 'anthropic', supplied = deps) {
  const patterns = await agent.createPatterns('synthetic-session', supplied)
  return withRunFrame({ inference: { tier } }, () => harness(...patterns)('synthetic task'))
}

describe('general-next composition', () => {
  it('keeps the office workspace owner-scoped and the nested Redis retriever discoverable', async () => {
    const patterns = await agent.createPatterns('synthetic-session', deps)
    expect(agent.id).toBe('general-next')
    expect(agent.usesSandbox).toBe(true)
    expect(harnessUsesSyncWorkspace(patterns)).toBe(true)
    expect(harnessHasRedisRetriever(patterns)).toBe(true)
    expect(walk(patterns).find((p) => p.name === 'retriever')?.config.patternId).toBe('retriever')
    expect(attach).toHaveBeenCalledWith({
      id: 'synthetic-session:office',
      sessionId: 'synthetic-session',
      rootfs: 'office',
      egress: 'mcp-only',
      syncWorkspace: true,
    })
  })

  it('P1/S-f: pins effective allowlist NAMES, with no gated ingest or turn-results capability', async () => {
    const patterns = await agent.createPatterns('synthetic-session', deps)
    const all = walk(patterns)
    const actor = all.find((p) => p.name === 'actorCritic')!
    expect([...actor.capabilities!.tools!].sort()).toEqual(
      GRAPH.filter((n) => n !== 'graph_file_ingest').sort(),
    )
    const loop = all.find((p) => p.name === 'simpleLoop')!
    expect([...loop.capabilities!.tools!].sort()).toEqual([...INFO].sort())
    expect(
      Object.entries(MCP_TOOL_CATALOG)
        .filter(
          ([name, namespace]) =>
            ['web', 'neo4j'].includes(namespace) && name !== 'write_neo4j_cypher',
        )
        .map(([name]) => name)
        .sort(),
    ).toEqual([...INFO].sort())
    expect(loop.config).toMatchObject({ rememberPriorTurns: false, returnStyle: 'answer' })
    const references = all.find((p) => p.name.startsWith('withReferences('))!
    expect(references.config).toMatchObject({
      source: ['retriever', 'info'],
      viewConfig: { fromLastNTurns: 1 },
    })
    const graphSource = readFileSync('../packages/connectors/graph/graph-tools.server.ts', 'utf8')
    expect([...graphSource.matchAll(/name: '(graph_[a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...GRAPH].sort(),
    )
    expect(collectToolNames(patterns[0]).sort()).toEqual(
      [...GRAPH.filter((n) => n !== 'graph_file_ingest'), ...INFO, ...SANDBOX].sort(),
    )
    // Pin every capability key, so a future materialisation declaration cannot
    // hide behind an unknown field or a renamed option.
    expect([...new Set(all.flatMap((p) => Object.keys(p.capabilities ?? {})))].sort()).toEqual([
      'decisionKeys',
      'pseudonymisedInputs',
      'retrievalBackends',
      'tools',
      'workspaceSync',
    ])
    expect(all.every((p) => !/humanGate|confirm/.test(p.name))).toBe(true)
  })

  it('keeps all route tools under declared guards, including exact sandbox and retriever keys', async () => {
    const patterns = await agent.createPatterns('synthetic-session', deps)
    const all = walk(patterns)
    const guarded = all.filter((p) => p.injectionGuard)
    expect(guarded.find((p) => p.config.patternId === 'doc')?.injectionGuard).toEqual({
      namespaces: ['graph'],
      tools: SANDBOX,
    })
    expect(guarded.find((p) => p.config.patternId === 'info')?.injectionGuard).toEqual({
      namespaces: ['web', 'neo4j'],
      tools: [],
    })
    expect(guarded.find((p) => p.config.patternId === 'retriever')?.injectionGuard).toEqual({
      namespaces: [],
      tools: ['retriever'],
    })
    const visit = (p: ConfiguredPattern<AgentData>, namespaces: string[], names: string[]) => {
      namespaces = [...namespaces, ...(p.injectionGuard?.namespaces ?? [])]
      names = [...names, ...(p.injectionGuard?.tools ?? [])]
      for (const tool of p.capabilities?.tools ?? []) {
        expect(names.includes(tool) || namespaces.includes(inferServer(tool)), tool).toBe(true)
      }
      for (const child of p.children ?? []) visit(child, namespaces, names)
    }
    visit(patterns[0], [], [])
  })

  it('S-c: fences regex-clean output under the declared orchestrator key and screens it', async () => {
    await run()
    expect(states[1]).toContain('⟦UNTRUSTED CONTENT')
    expect(states[1]).toContain('SYNTHETIC-ROUTE-CONTENT')
    expect(mocks.screen).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'decision_loop_output' }),
    )
    expect(mocks.synthesize.mock.calls[0][0].mode).toBe('thread')
    expect(
      mocks.synthesize.mock.calls[0][0].loopHistory?.iterations.map((i) => i.action.tool_name),
    ).toEqual(['info-retrieval'])
    expect(mocks.controller.mock.calls[0][0].userMessage).toBe('synthetic task')
  })

  it('S-d: a screen outage withholds content from state, handoff and synthesis', async () => {
    choices = ['info-retrieval', 'think', 'answer']
    mocks.screen.mockRejectedValue(new Error('synthetic screen outage'))
    const result = await run()
    expect(states[1]).toContain('withheld: screen unavailable')
    expect(states[1]).not.toContain('SYNTHETIC-ROUTE-CONTENT')
    expect(JSON.stringify(mocks.planner.mock.calls)).not.toContain('SYNTHETIC-ROUTE-CONTENT')
    expect(JSON.stringify(mocks.synthesize.mock.calls)).not.toContain('SYNTHETIC-ROUTE-CONTENT')
    expect(
      result.context.events.find((e) => e.patternId === 'orchestrator' && e.type === 'tool_result')
        ?.data,
    ).toMatchObject({ success: false, error: 'withheld: screen unavailable' })
  })

  it('G14: only info declares the filter; a private run calls the supplied host', async () => {
    const pseudonymiseForWeb = vi.fn(deps.pseudonymiseForWeb!)
    const patterns = await agent.createPatterns('synthetic-session', {
      ...deps,
      pseudonymiseForWeb,
    })
    const routes = patterns[0].children![0].children!
    expect(routes.map((p) => harnessPseudonymisesInputs([p]))).toEqual([false, true, false, false])
    await withRunFrame({ inference: { tier: 'verda' } }, () =>
      harness(...patterns)('synthetic task'),
    )
    expect(pseudonymiseForWeb).toHaveBeenCalledTimes(1)
  })

  it('G14: the real host rewrites an external sender after the composed Graph guards', async () => {
    const { createWebPseudonymiser } =
      await import('../../../../lib/harness-client/web-pseudonymiser.server')
    choices = ['office-data', 'info-retrieval', 'answer']
    gateway.result = { from: 'Otto Willow', body: 'A synthetic message from Otto Willow.' }
    mocks.actor.mockResolvedValue({
      action: {
        reasoning: 'read mail',
        tool_name: 'graph_mail_recent',
        tool_args: '{}',
        is_final: true,
      },
    })
    await run('verda', {
      ...deps,
      pseudonymiseForWeb: createWebPseudonymiser({ directory: 'none' }),
    })
    const handoff = mocks.controller.mock.calls[0][0].planContext
    expect(handoff).toContain('PERSON_')
    expect(handoff).not.toContain('Otto Willow')
  })

  it('info reuses retriever references while excluding office results from previews', async () => {
    choices = ['office-data', 'read-documents', 'info-retrieval', 'answer']
    mocks.actor.mockResolvedValue({
      action: {
        reasoning: 'read mail',
        tool_name: 'graph_mail_recent',
        tool_args: '{}',
        is_final: true,
      },
    })
    const result = await run('anthropic', {
      ...deps,
      createRedisBackend: () => ({
        name: 'redis',
        type: 'vector',
        search: async () => [
          {
            id: 'synthetic-hit',
            backend: 'redis',
            docId: 'synthetic-doc',
            chunkIndex: 0,
            source: 'synthetic.md',
            content: 'DOCUMENT-SENTINEL',
            score: 0.1,
          },
        ],
      }),
    })
    expect(
      result.context.events
        .filter((e) => e.type === 'tool_result')
        .map((e) => (e.data as { tool: string }).tool),
    ).toEqual(expect.arrayContaining(['graph_mail_recent', 'retriever']))
    const refs = mocks.controller.mock.calls[0][0].priorResults!
    expect(refs).toHaveLength(1)
    expect(refs[0].tool).toBe('retriever')
    const attached = result.context.events.find((e) => e.id === refs[0].ref_id)
    expect(JSON.stringify(attached?.data)).toContain('DOCUMENT-SENTINEL')
    expect(refs.some((r) => r.tool === 'graph_mail_recent')).toBe(false)
  })

  it('P5: an unconfigured private decisions shim ends visibly before any route or synthesis', async () => {
    vi.stubEnv('SMALL_LLM_DECISIONS_URL', '')
    const result = await run('verda')
    expect(result.status).toBe('error')
    expect(result.context.error).toContain('SMALL_LLM_DECISIONS_URL')
    expect(requests).not.toHaveBeenCalled()
    expect(mocks.controller).not.toHaveBeenCalled()
    expect(mocks.actor).not.toHaveBeenCalled()
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })

  it('M7: moves the opt-in from general and gives recalled data only to synthesis', async () => {
    const memory = { owner: () => null, enabled: () => false } as unknown as MemoryConfig
    const patterns = await agent.createPatterns('synthetic-session', { ...deps, memory })
    expect(harnessUsesMemory(patterns)).toBe(true)
    expect(patterns.map((p) => p.name)).toEqual([
      'memoryRecall',
      'withInjectionGuard(decisionLoop)',
      'compactExecution',
    ])
    const { generalAgent } = await import('@hames-ai/agents/agents/general.server')
    expect(
      harnessUsesMemory(await generalAgent.createPatterns('old-general', { ...deps, memory })),
    ).toBe(false)
    const ctx = createContext<AgentData>('synthetic task', {
      memories: [{ content: 'MEMORY-SENTINEL' }],
      memoryContext: 'MEMORY-SENTINEL',
    })
    const orchestrator = patterns[1]
    const scope = createScope<AgentData>('orchestrator', ctx.data)
    const finished = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
      orchestrator.fn(scope, createEventView(ctx)),
    )
    expect(states.join('')).not.toContain('MEMORY-SENTINEL')
    expect(JSON.stringify(mocks.controller.mock.calls)).not.toContain('MEMORY-SENTINEL')
    ctx.events.push(...finished.events)
    await patterns[2].fn(
      createScope('response-synth', finished.data),
      createEventView(ctx, patterns[2].config.viewConfig),
    )
    expect(mocks.synthesize.mock.calls[0][0].memoryContext).toBe('MEMORY-SENTINEL')
  })

  it.each(['withSandbox', 'createRedisBackend'] as const)(
    'refuses missing host %s',
    async (key) => {
      await expect(
        agent.createPatterns('synthetic-session', { ...deps, [key]: undefined }),
      ).rejects.toThrow(key)
    },
  )

  it('registers the candidate with its app-side glyph while the default stays search', () => {
    const registry = readFileSync('src/lib/harness-client/registry.server.ts', 'utf8')
    expect(registry).toContain("overlay(generalNextAgent, 'i-material-symbols-route', 'indigo')")
    expect(readFileSync('src/lib/harness-client/agent-ids.ts', 'utf8')).not.toMatch(/general-next/)
  })
})

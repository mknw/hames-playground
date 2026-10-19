/** #507 W4: the office actor's RENDERED prompt lists exactly the Graph read
 * tools. general-next.test.ts mocks the actor adapter, so it can pin the option
 * but not the prompt; this file runs the real adapter and renders the real
 * ActorController request offline (`b.request`, no socket). */
import { beforeAll, expect, it, vi } from 'vitest'
import '../../../mocks/namespace-catalog'
import '../../../../lib/inference/config.server'
import { harness, withRunFrame, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentData, AgentDeps } from '@hames-ai/agents'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const OFFICE = [
  'graph_me',
  'graph_calendar_today',
  'graph_mail_recent',
  'graph_mail_attachments',
  'graph_files_search',
  'graph_files_list',
  'graph_files_recent',
  'graph_files_shared',
]
// Every other name the gateway offers: the withheld ingest, the info route's
// tools, and the writes no route may hold.
const ELSEWHERE = [
  'graph_file_ingest',
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'write_neo4j_cypher',
  'search',
  'fetch',
  'fetch_content',
  'resolve-library-id',
  'get-library-docs',
  'search_nodes',
  'open_nodes',
  'read_graph',
  'create_entities',
  'delete_entities',
  'query_database',
  'search_redis_documents',
]
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: [...OFFICE, ...ELSEWHERE].map((name) => ({
        name,
        description: `desc of ${name}`,
        inputSchema: {},
      })),
    }))
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"Node":["name"]}' }] }))
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const deps: AgentDeps = {
  toolNamespaces: mcpNamespace,
  withSandbox: () => (pattern) => pattern,
  createRedisBackend: () => ({ name: 'redis', type: 'vector', search: async () => [] }),
  pseudonymiseForWeb: async () => ({
    apply: (v) => v,
    redact: <T>(v: T): T => v,
    checkLiterals: () => {},
    observe: () => {},
    check: () => {},
  }),
}
const walk = (ps: ConfiguredPattern<AgentData>[]): ConfiguredPattern<AgentData>[] =>
  ps.flatMap((p) => [p, ...walk(p.children ?? [])])

const rendered: string[] = []
beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-render-test')
  vi.stubEnv('USE_VERDA_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  // Render what the adapter would send (its first nine arguments; the tenth is
  // the options bag), then answer with a final action so the loop ends.
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    const request = await b.request.ActorController(
      ...(args.slice(0, 9) as Parameters<typeof b.request.ActorController>),
    )
    rendered.push(JSON.stringify(request.body.json()))
    return {
      reasoning: 'r',
      tool_name: 'Return',
      tool_args: 'done',
      status: 'success',
      is_final: true,
    }
  }) as never)
  vi.spyOn(b, 'Critic').mockImplementation((async () => ({
    is_sufficient: true,
    explanation: 'ok',
  })) as never)
})

it('W4: the rendered office actor catalogue is exactly the eight Graph read tools', async () => {
  const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
  const patterns = await generalNextAgent.createPatterns('synthetic-session', deps)
  const actor = walk(patterns).find((p) => p.name === 'actorCritic')!
  await withRunFrame({ inference: { tier: 'anthropic' } }, () => harness(actor)('synthetic task'))
  expect(rendered.length).toBeGreaterThan(0)
  for (const body of rendered) {
    const catalogue = [...body.matchAll(/\\n- ([A-Za-z0-9_-]+): desc of /g)].map((m) => m[1])
    expect(catalogue.sort()).toEqual([...OFFICE].sort())
    for (const name of ELSEWHERE) expect(body, name).not.toContain(`desc of ${name}`)
  }
})

// MUTATION: remove the info controller's source-URL contextPrefix instruction.
it.each(['anthropic', 'verda'])('E1: info Return contract is rendered on %s', async (tier) => {
  vi.stubEnv('VERDA_INFERENCE_ENDPOINT', 'https://example.invalid/v1')
  vi.stubEnv('VERDA_INFERENCE_API_KEY', 'synthetic')
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://example.invalid/small/v1')
  vi.stubEnv('SMALL_LLM_DECISIONS_URL', 'https://example.invalid/v1/systemone')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  const prompts: string[] = []
  const spy = vi.spyOn(b, 'LoopController').mockImplementation((async (...args: unknown[]) => {
    const requestArgs = args.slice(0, 10) as Parameters<typeof b.request.LoopController>
    requestArgs[10] = { client: (args[10] as { client?: string }).client }
    const request = await b.request.LoopController(...requestArgs)
    prompts.push(JSON.stringify(request.body.json()))
    return { reasoning: 'done', tool_name: 'Return', tool_args: 'synthetic', is_final: true }
  }) as never)
  try {
    const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
    const patterns = await generalNextAgent.createPatterns('synthetic-session', deps)
    const info = walk(patterns).find((p) => p.name === 'simpleLoop')!
    await withRunFrame({ inference: { tier } }, () => harness(info)('synthetic task'))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(
      'When you Return, include the URLs of the sources you used as Markdown links',
    )
    expect(prompts[0]).toContain('Copy each source URL verbatim')
    expect(prompts[0]).toContain('never invent or construct a URL')
    expect(prompts[0]).toContain('include no link')
    expect(JSON.parse(prompts[0]).model).toMatch(tier === 'verda' ? /Qwen/ : /^claude-/)
  } finally {
    spy.mockRestore()
  }
})

/** #507 W4: the office actor's RENDERED prompt lists exactly the Graph read
 * tools. general-next.test.ts mocks the actor adapter, so it can pin the option
 * but not the prompt; this file runs the real adapter and renders the real
 * ActorController request offline (`b.request`, no socket). */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '../../../mocks/namespace-catalog'
import '../../../../lib/inference/config.server'
import { harness, withRunFrame, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentData, AgentDeps } from '@hames-ai/agents'
import { registerGraphConnectorTools } from '@hames-ai/connectors/graph/graph-tools.server'
import type { AppToolDefinition } from '@hames-ai/connectors/app-tools/registry'

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
const examples: string[] = []
const graphTools = new Map<string, AppToolDefinition>()
const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  VERDA_INFERENCE_ENDPOINT: 'https://example.invalid/v1',
  VERDA_INFERENCE_API_KEY: 'offline-render-test',
}
beforeAll(async () => {
  // Register the real schemas without executing a tool or contacting Graph.
  const unexpectedCall = () => {
    throw new Error('schema-only test must not execute Graph or stash operations')
  }
  registerGraphConnectorTools({
    registerAppTool: (tool) => graphTools.set(tool.name, tool),
    graphFetch: unexpectedCall,
    content: {
      conversionEnabled: unexpectedCall,
      isConvertible: unexpectedCall,
      guessMimeType: unexpectedCall,
      isTextMime: unexpectedCall,
    },
    stash: { loadStore: unexpectedCall, ingest: unexpectedCall },
  })
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-render-test')
  vi.stubEnv('USE_VERDA_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  // Render what the adapter would send (its first nine arguments; the tenth is
  // the options bag), then answer with a final action so the loop ends.
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    for (const client of ['AnthropicSonnet5', 'VerdaQwen']) {
      const renderArgs = args.slice(0, 9) as Parameters<typeof b.request.ActorController>
      renderArgs[9] = { client, env: ENV }
      const request = await b.request.ActorController(...renderArgs)
      const body = request.body.json() as {
        system?: { text: string }[]
        messages: { content: string | { text: string }[] }[]
      }
      rendered.push(JSON.stringify(body))
      const head = body.system ?? body.messages[0].content
      examples.push(typeof head === 'string' ? head : head.map((p) => p.text).join('\n'))
    }
    return {
      reasoning: 'r',
      tool_name: 'graph_me',
      tool_args: '{}',
      status: 'success',
      is_final: true,
    }
  }) as never)
  vi.spyOn(b, 'Critic').mockImplementation((async () => ({
    is_sufficient: true,
    explanation: 'ok',
  })) as never)
  const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
  const patterns = await generalNextAgent.createPatterns('synthetic-session', deps)
  const actor = walk(patterns).find((p) => p.name === 'actorCritic')!
  await withRunFrame({ inference: { tier: 'anthropic' } }, () => harness(actor)('synthetic task'))
})

it('W4: the rendered office actor catalogue is exactly the eight Graph read tools', async () => {
  expect(rendered.length).toBeGreaterThan(0)
  for (const body of rendered) {
    const catalogue = [...body.matchAll(/\\n- ([A-Za-z0-9_-]+): desc of /g)].map((m) => m[1])
    expect(catalogue.sort()).toEqual([...OFFICE].sort())
    for (const name of ELSEWHERE) expect(body, name).not.toContain(`desc of ${name}`)
  }
})

// MUTATIONS: remove fewShots: OFFICE_FEW_SHOTS; change the office mode to
// parallel. Each must fail this real-adapter render, on both wire formats.
describe.each([0, 1])('#507 office envelope (wire %i)', (wire) => {
  it('demonstrates Graph and office sandbox actions as parseable JSON envelopes', async () => {
    const { b } = await import('@hames-ai/harness-baml/baml_client')
    const prompt = examples[wire]
    expect(prompt).toContain('EXAMPLES (illustrative')
    const actions = prompt
      .split('\n')
      .filter((line) => line.trim().startsWith('{"reasoning":'))
      .map((line) => JSON.parse(line))
    // Three domain shots and the existing mode-gated sequential batch.
    expect(actions.map((a) => a.tool_name)).toEqual([
      'sandbox_write',
      'graph_mail_recent',
      'graph_files_search',
      'sandbox_bash',
    ])
    for (const action of actions) {
      expect(b.parse.ActorController(JSON.stringify(action))).toMatchObject(action)
      expect(typeof action.tool_args).toBe('string')
      expect(JSON.parse(action.tool_args)).toBeTypeOf('object')
      expect(action.is_final).toBe(false)
      expect(action.tool_name).not.toBe('Return')
    }
    expect(JSON.parse(actions[1].tool_args)).toEqual({ unread_only: true, limit: 3 })
    expect(JSON.parse(actions[2].tool_args)).toEqual({ query: 'sample budget', file_type: 'xlsx' })
    expect(JSON.parse(actions[3].tool_args).command).toContain("doc.save('/work/out/sample.docx')")
    expect(JSON.parse(actions[3].tool_args).command).toContain("python3 - <<'PY'\n")
  })

  // MUTATIONS: rename unread_only / file_type in the registered Graph
  // schemas, or add a required property. The examples must fail this contract.
  it.each(['graph_mail_recent', 'graph_files_search'])(
    'keeps the %s example arguments within the registered schema',
    (name) => {
      const action = examples[wire]
        .split('\n')
        .filter((line) => line.trim().startsWith('{"reasoning":'))
        .map((line) => JSON.parse(line))
        .find((a) => a.tool_name === name)
      expect(action).toBeDefined()
      const args = JSON.parse(action.tool_args)
      const schema = graphTools.get(name)!.inputSchema as {
        properties: Record<string, unknown>
        required?: string[]
      }
      for (const key of Object.keys(args)) expect(schema.properties).toHaveProperty(key)
      for (const key of schema.required ?? []) expect(args).toHaveProperty(key)
    },
  )

  it('demonstrates writing and then running the same script in a sequential batch', () => {
    const prompt = examples[wire]
    expect(prompt.replace(/\s+/g, ' ')).toContain('Calls in an attempt run strictly IN ORDER')
    const batch = JSON.parse(
      prompt
        .split('\n')
        .find(
          (line) => line.trim().startsWith('{"reasoning":') && line.includes('"additional_calls":'),
        )!,
    )
    expect(batch.tool_name).toBe('sandbox_write')
    const script = JSON.parse(batch.tool_args)
    expect(batch.additional_calls).toHaveLength(1)
    expect(batch.additional_calls[0].tool_name).toBe('sandbox_bash')
    expect(JSON.parse(batch.additional_calls[0].tool_args)).toEqual({
      command: `python3 ${script.path}`,
    })
    expect(script.content).toContain('import openpyxl')
  })
})

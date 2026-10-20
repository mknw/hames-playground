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
  'graph_file_ingest',
]
// Every other name the gateway offers: the info route's
// tools, and the writes no route may hold.
const ELSEWHERE = [
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
  graphFileIngest: true,
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
const unavailableRendered: string[] = []
let ingestAvailable = true
const examples: string[] = []
const graphTools = new Map<string, AppToolDefinition>()
const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}
beforeAll(async () => {
  // Register the real schemas without executing a tool or contacting Graph.
  const unexpectedCall = () => {
    throw new Error('schema-only test must not execute Graph or stash operations')
  }
  registerGraphConnectorTools({
    fileIngestAllowed: () => false,
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
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '0')
  const { b } = await import('@hames-ai/harness-baml/baml_client')
  // Render what the adapter would send (its first nine arguments; the tenth is
  // the options bag), then answer with a final action so the loop ends.
  vi.spyOn(b, 'ActorController').mockImplementation((async (...args: unknown[]) => {
    for (const client of ['AnthropicSonnet5', 'SelfDeployedQwen']) {
      const renderArgs = args.slice(0, 9) as Parameters<typeof b.request.ActorController>
      renderArgs[9] = { client, env: ENV }
      const request = await b.request.ActorController(...renderArgs)
      const body = request.body.json() as {
        system?: { text: string }[]
        messages: { content: string | { text: string }[] }[]
      }
      ;(ingestAvailable ? rendered : unavailableRendered).push(JSON.stringify(body))
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
  ingestAvailable = false
  const unavailablePatterns = await generalNextAgent.createPatterns('no-ingest', {
    ...deps,
    graphFileIngest: false,
  })
  const unavailableActor = walk(unavailablePatterns).find((p) => p.name === 'actorCritic')!
  await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
    harness(unavailableActor)('synthetic task'),
  )
})

it('W4: the rendered office actor catalogue is exactly the Graph readers and guarded file-ingest tool', async () => {
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
    // Four domain shots and the existing mode-gated sequential batch.
    expect(actions.map((a) => a.tool_name)).toEqual([
      'sandbox_write',
      'graph_mail_recent',
      'graph_files_search',
      'sandbox_bash',
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

  // #507 run 2: every Markdown deliverable (11, 14, 17) failed while .docx and .csv passed,
  // and no example saved a text file. MUTATIONS: delete the Markdown shot; make it print
  // the content instead of writing it; drop the `/work/out` write or the printed path.
  it('demonstrates reading an input and saving a Markdown file in one command', () => {
    const shot = examples[wire]
      .split('\n')
      .filter((line) => line.trim().startsWith('{"reasoning":'))
      .map((line) => JSON.parse(line))
      .filter((a) => a.tool_name === 'sandbox_bash')[1]
    const { command } = JSON.parse(shot.tool_args)
    expect(command).toContain("open('/work/in/sample-sales.csv')")
    expect(command).toContain("Path('/work/out/sample-summary.md').write_text(")
    expect(command).toContain("print('/work/out/sample-summary.md')")
    expect(shot.is_final).toBe(false)
  })

  // MUTATION: remove the deliverable sentence from the office contextPrefix.
  it('tells the office actor to save a requested file with a command or sandbox_write', () => {
    const body = rendered[wire].replace(/\\n/g, ' ')
    expect(body).toContain(
      'A requested file exists only once it has been saved under /work/out (by a command or with sandbox_write)',
    )
    expect(body).toContain('never paste or print its content in place of saving it')
    expect(body).toContain('set is_final only after a tool result confirmed the saved path')
  })

  // MUTATION: remove the ingestion instructions from the office contextPrefix.
  it('P4: tells the actor how a found Graph file reaches /work/in and cited retrieval', () => {
    expect(rendered[wire]).toContain(
      'call graph_file_ingest with the item_id and drive_id copied exactly from that result',
    )
    expect(rendered[wire]).toContain('The original file is copied into /work/in')
    expect(rendered[wire]).toContain(
      'Report a refusal rather than trying another download path; do not retry it this turn.',
    )
    expect(rendered[wire]).toContain(
      'Never guess an id, and never batch the find and the ingest in one action.',
    )
    expect(rendered[wire]).toContain('never build the path yourself')
    expect(rendered[wire]).toContain(
      'finish once indexStatus is indexed and say the copy is searchable',
    )
    expect(rendered[wire]).toContain('Treat pending as not yet searchable')
    expect(rendered[wire]).not.toMatch(/read-documents/i)
    expect(rendered[wire]).toContain(
      'first find it with graph_files_search, graph_files_recent, graph_files_shared or graph_files_list',
    )
    expect(rendered[wire]).not.toContain('Graph file ingestion is unavailable')
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

// MUTATION: remove the info controller's source-URL contextPrefix instruction.
it.each(['anthropic', 'self_deployed'])(
  'E1: info Return contract is rendered on %s',
  async (tier) => {
    vi.stubEnv('LARGE_LLM_BASE_URL', 'https://example.invalid/v1')
    vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic')
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
      expect(JSON.parse(prompts[0]).model).toMatch(tier === 'self_deployed' ? /Qwen/ : /^claude-/)
    } finally {
      spy.mockRestore()
    }
  },
)

it.each([0, 1])('P4: disabled ingest is absent from the rendered actor (wire %i)', (wire) => {
  expect(unavailableRendered[wire]).toContain('Graph file ingestion is unavailable.')
  expect(unavailableRendered[wire]).not.toContain('call graph_file_ingest')
  expect(unavailableRendered[wire]).not.toContain('desc of graph_file_ingest')
})

// MUTATIONS: omit the computation rule from either ingest variant → red on both wires.
it.each([0, 1])(
  'preserves code computation guidance with ingest enabled and disabled (wire %i)',
  (wire) => {
    expect(rendered[wire]).toContain('Run code for computations.')
    expect(unavailableRendered[wire]).toContain('Run code for computations.')
  },
)

/**
 * Retriever agent composition.
 *
 * The behavioural claims worth pinning: the harness exposes three routes
 * (retriever / neo4j / web_search) behind a router, and — because the retriever
 * is wired to the **redis** backend — `harnessHasRedisRetriever` reports true,
 * which is what makes uploads to this agent's sessions auto-ingest
 * (routes/api/stash/upload.ts). A retriever wired elsewhere must not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const TOOLS = ['read_neo4j_cypher', 'get_neo4j_schema', 'search', 'fetch_content', 'Return']

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: mockCallTool({ responses: { get_neo4j_schema: { nodes: ['Concept'] } } }),
  listTools: mockListTools(TOOLS),
}))

vi.mock('../../../../../baml_client', () => ({
  b: {
    Router: vi.fn(),
    LoopController: vi.fn(),
    Synthesize: vi.fn(),
    RetrieveQuery: vi.fn(),
  },
}))

const { retrieverAgent } =
  await import('../../../../lib/harness-client/examples/retriever-agent.server')
const { harnessHasRedisRetriever, retriever, synthesizer } =
  await import('../../../../lib/harness-patterns')

interface Pattern {
  name: string
  config: { patternId?: string; routes?: Record<string, unknown> }
  children?: Pattern[]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('retrieverAgent config', () => {
  it('declares the metadata the picker and the registry need', () => {
    expect(retrieverAgent.id).toBe('retriever')
    expect(retrieverAgent.icon).toMatch(/^i-material-symbols-/)
    expect(retrieverAgent.servers).toEqual(expect.arrayContaining(['neo4j-cypher', 'web_search']))
  })
})

describe('retrieverAgent pattern chain', () => {
  it('is router → routes → synthesizer, with unique pattern ids', async () => {
    const patterns = (await retrieverAgent.createPatterns('sess-r')) as Pattern[]

    expect(patterns.map((p) => p.name.replace(/\(.*/, ''))).toEqual([
      'router',
      'routes',
      'synthesizer',
    ])
    const ids = patterns.map((p) => p.config.patternId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('response-synth')
  })

  it('offers the retriever alongside the neo4j and web routes', async () => {
    const patterns = (await retrieverAgent.createPatterns('sess-r')) as Pattern[]
    const routes = patterns.find((p) => p.name.startsWith('routes'))!

    expect(routes.name).toBe('routes(retriever|neo4j|web_search)')
    // The retriever route is the fast path — it must reach the retriever
    // pattern itself, not a loop wrapped around one.
    expect(harnessHasRedisRetriever([routes as never])).toBe(true)
  })

  it('advertises a redis-backed retriever, which is what gates upload auto-ingest', async () => {
    const patterns = await retrieverAgent.createPatterns('sess-r')
    expect(harnessHasRedisRetriever(patterns)).toBe(true)
  })

  it('does not report a redis retriever for a harness without one', () => {
    const otherBackend = { name: 'supabase', type: 'vector' as const, search: async () => [] }
    const patterns = [
      retriever({ patternId: 'retriever', backends: [otherBackend] }),
      synthesizer({ mode: 'thread', patternId: 'response-synth' }),
    ]
    expect(harnessHasRedisRetriever(patterns)).toBe(false)
  })

  it('reads the live Neo4j schema once when building the chain', async () => {
    const { callTool } = await import('../../../../lib/harness-patterns/mcp-client.server')
    await retrieverAgent.createPatterns('sess-r')
    expect(callTool).toHaveBeenCalledWith('get_neo4j_schema', {})
  })
})

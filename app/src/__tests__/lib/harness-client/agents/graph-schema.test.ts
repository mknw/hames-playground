/**
 * The shared graph-schema fetch (sf-M6).
 *
 * Three agents primed their Cypher controllers with `get_neo4j_schema` and only
 * ONE of them handled a failure. The other two returned `''` and let
 * `getOrBuildPatterns` cache that build, so a Neo4j or gateway blip during the
 * first message froze a schema-blind controller into the conversation for its
 * whole life. This file pins the helper's contract, so the next agent that needs
 * a schema cannot quietly reintroduce a private copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testAgentDeps } from './test-deps'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

const TOOLS = ['read_neo4j_cypher', 'get_neo4j_schema', 'search', 'fetch_content', 'Return']

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockDoNotCachePatterns = vi.fn()
vi.mock('../../../../lib/harness-client/session.server', () => ({
  doNotCachePatterns: (...args: unknown[]) => mockDoNotCachePatterns(...args),
}))

// The refusal hook rides `AgentDeps` now — the pattern cache is app-side state
// the package receives, not imports. The degradation tests pass a bag whose
// hook is the mock above; the healthy-path tests pass the plain fixture.
const degradedDeps = { ...testAgentDeps, doNotCachePatterns: mockDoNotCachePatterns }

const schemaOk = mockCallTool({ responses: { get_neo4j_schema: { Concept: ['name'] } } })
const schemaFails = mockCallTool({ errors: { get_neo4j_schema: 'connection refused' } })
const currentCallTool = { fn: schemaOk }

vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: (...args: [string, Record<string, unknown>?]) => currentCallTool.fn(...args),
  listTools: mockListTools(TOOLS),
}))

beforeEach(() => {
  vi.clearAllMocks()
  currentCallTool.fn = schemaOk
})

describe('getGraphSchema', () => {
  async function load() {
    return import('@hames-ai/agents/agents/graph-schema.server')
  }

  it('returns the schema as JSON when the tool succeeds', async () => {
    const { getGraphSchema } = await load()
    expect(await getGraphSchema('t', 's1', testAgentDeps)).toBe(
      JSON.stringify({ Concept: ['name'] }),
    )
    expect(mockDoNotCachePatterns).not.toHaveBeenCalled()
  })

  it('warns, names the agent, and refuses the pattern cache on failure', async () => {
    const { getGraphSchema } = await load()
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Empty string, not a throw: the agent runs blind rather than not at all.
    expect(await getGraphSchema('my-agent', 'sess-9', degradedDeps)).toBe('')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[my-agent]'))
    expect(warn.mock.calls[0][0]).toContain('connection refused')
    // …and the next message rebuilds instead of reusing the blind patterns.
    expect(mockDoNotCachePatterns).toHaveBeenCalledWith('sess-9')
    warn.mockRestore()
  })
})

// The remaining agent uses the shared helper and must not cache a schema-blind build.
describe('general-next agent — schema failure', () => {
  async function build(sessionId: string): Promise<{ name: string }[]> {
    const { generalNextAgent } = await import('@hames-ai/agents/agents/general-next.server')
    return (await generalNextAgent.createPatterns(sessionId, degradedDeps)) as { name: string }[]
  }

  it('builds a usable chain and refuses the pattern cache on schema failure', async () => {
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const patterns = await build('degraded-general-next')
    expect(patterns.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('graph schema unavailable'))
    expect(mockDoNotCachePatterns).toHaveBeenCalledWith('degraded-general-next')
    warn.mockRestore()
  })

  it('caches normally when the schema resolves', async () => {
    await build('healthy-general-next')
    expect(mockDoNotCachePatterns).not.toHaveBeenCalled()
  })
})

/**
 * The shared graph-schema fetch (sf-M6).
 *
 * Three agents primed their Cypher controllers with `get_neo4j_schema` and only
 * ONE of them — `general` — handled a failure. `default` and `retriever-agent`
 * returned `''` and let `getOrBuildPatterns` cache that build, so a Neo4j or
 * gateway blip during the first message froze a schema-blind controller into the
 * conversation for its whole life. This file pins the behaviour for all three,
 * so the next agent that needs a schema cannot quietly reintroduce the third
 * copy.
 *
 * `general-agent.test.ts` keeps its own coverage of the same property (it is
 * about that agent's degraded build); this is about the helper's contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

const TOOLS = ['read_neo4j_cypher', 'get_neo4j_schema', 'search', 'fetch_content', 'Return']

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockDoNotCachePatterns = vi.fn()
vi.mock('../../../../lib/harness-client/session.server', () => ({
  doNotCachePatterns: (...args: unknown[]) => mockDoNotCachePatterns(...args),
}))

const schemaOk = mockCallTool({ responses: { get_neo4j_schema: { Concept: ['name'] } } })
const schemaFails = mockCallTool({ errors: { get_neo4j_schema: 'connection refused' } })
const currentCallTool = { fn: schemaOk }

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: (...args: [string, Record<string, unknown>?]) => currentCallTool.fn(...args),
  listTools: mockListTools(TOOLS),
}))

beforeEach(() => {
  vi.clearAllMocks()
  currentCallTool.fn = schemaOk
})

describe('getGraphSchema', () => {
  async function load() {
    return import('../../../../lib/harness-client/agents/graph-schema.server')
  }

  it('returns the schema as JSON when the tool succeeds', async () => {
    const { getGraphSchema } = await load()
    expect(await getGraphSchema('t', 's1')).toBe(JSON.stringify({ Concept: ['name'] }))
    expect(mockDoNotCachePatterns).not.toHaveBeenCalled()
  })

  it('warns, names the agent, and refuses the pattern cache on failure', async () => {
    const { getGraphSchema } = await load()
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Empty string, not a throw: the agent runs blind rather than not at all.
    expect(await getGraphSchema('my-agent', 'sess-9')).toBe('')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[my-agent]'))
    expect(warn.mock.calls[0][0]).toContain('connection refused')
    // …and the next message rebuilds instead of reusing the blind patterns.
    expect(mockDoNotCachePatterns).toHaveBeenCalledWith('sess-9')
    warn.mockRestore()
  })
})

// The two agents that used to swallow it. Both are asserted through their real
// `createPatterns`, because the bug was not in a helper — it was in what the
// agent did with the result.
describe.each([
  ['default', () => import('../../../../lib/harness-client/agents/default.server')],
  ['retriever-agent', () => import('../../../../lib/harness-client/agents/retriever-agent.server')],
])('%s agent — schema failure', (label, importAgent) => {
  async function build(sessionId: string): Promise<{ name: string }[]> {
    const mod = (await importAgent()) as Record<
      string,
      { createPatterns: (s: string) => Promise<unknown> }
    >
    const agent = Object.values(mod).find((v) => typeof v?.createPatterns === 'function')!
    return (await agent.createPatterns(sessionId)) as { name: string }[]
  }

  it('still builds a usable chain', async () => {
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const patterns = await build(`degraded-${label}`)
    expect(patterns.length).toBeGreaterThan(0)
    warn.mockRestore()
  })

  it('warns and refuses the pattern cache instead of freezing a blind build in', async () => {
    currentCallTool.fn = schemaFails
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await build(`degraded-${label}`)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('graph schema unavailable'))
    expect(mockDoNotCachePatterns).toHaveBeenCalledWith(`degraded-${label}`)
    warn.mockRestore()
  })

  it('caches normally when the schema resolves', async () => {
    await build(`healthy-${label}`)
    expect(mockDoNotCachePatterns).not.toHaveBeenCalled()
  })
})

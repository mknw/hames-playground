/** MCP envelope-to-canvas controls through the real transport normalizer. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { extractGraphElements } from '@hames-ai/agents'

const mock = vi.hoisted(() => ({ result: undefined as unknown }))
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport() {} }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    async callTool() {
      return mock.result
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const rows = [{ n: { name: 'First' }, r: [{ name: 'First' }, 'CONNECTS', { name: 'Second' }] }]
const expected = [
  {
    group: 'nodes',
    source: 'neo4j',
    data: { name: 'First', id: 'First', label: 'First', type: 'Node', kind: 'node' },
  },
  {
    group: 'nodes',
    source: 'neo4j',
    data: { name: 'Second', id: 'Second', label: 'Second', type: 'Node', kind: 'node' },
  },
  {
    group: 'edges',
    source: 'neo4j',
    data: {
      id: 'First-CONNECTS-Second',
      source: 'First',
      target: 'Second',
      label: 'CONNECTS',
      kind: 'edge',
    },
  },
]

describe('graph-extractor — MCP wire envelopes', () => {
  it.each([
    ['single JSON content block', { content: [{ type: 'text', text: JSON.stringify(rows) }] }],
    [
      'multiple JSON content blocks',
      { content: [...rows, ...rows].map((row) => ({ type: 'text', text: JSON.stringify(row) })) },
    ],
    ['structuredContent', { content: [], structuredContent: rows }],
  ])(
    '%s reaches the same nodes and edge through the real transport normalizer',
    async (_name, response) => {
      mock.result = response
      const { callTool } = await import('@hames-ai/harness-patterns/mcp-client.server')
      const result = await callTool('read_neo4j_cypher', {})
      expect(result.success).toBe(true)
      const event = {
        type: 'tool_result',
        ts: 1,
        patternId: 'info',
        data: { tool: 'read_neo4j_cypher', result: result.data, success: result.success },
      }
      expect(extractGraphElements([event])).toEqual(expected)
      expect(extractGraphElements([{ ...event, data: { ...event.data, tool: 'search' } }])).toEqual(
        [],
      )
    },
  )
})

afterAll(async () => {
  const { closeMcpClient } = await import('@hames-ai/harness-patterns/mcp-client.server')
  await closeMcpClient()
})

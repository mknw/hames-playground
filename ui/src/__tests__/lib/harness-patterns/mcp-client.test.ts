/**
 * MCP Client Tests
 *
 * Tests for the MCP client module.
 * Note: These tests mock the MCP SDK to avoid actual network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock the MCP SDK
const mockConnect = vi.fn()
const mockClose = vi.fn()
const mockCallTool = vi.fn()
const mockListTools = vi.fn()

class MockClient {
  connect = mockConnect
  close = mockClose
  callTool = mockCallTool
  listTools = mockListTools
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient
}))

class MockTransport {}

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockTransport
}))

describe('mcp-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"result": "success"}' }]
    })
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }
      ]
    })
  })

  afterEach(async () => {
    // Reset module state between tests
    vi.resetModules()
  })

  describe('getMcpClient', () => {
    it('should export getMcpClient function', async () => {
      const { getMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(getMcpClient).toBeDefined()
      expect(typeof getMcpClient).toBe('function')
    })

    it('should create and connect a client', async () => {
      const { getMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')

      const client = await getMcpClient()

      expect(client).toBeDefined()
      expect(mockConnect).toHaveBeenCalled()
    })

    it('should return the same client on subsequent calls', async () => {
      const { getMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')

      const client1 = await getMcpClient()
      const client2 = await getMcpClient()

      expect(client1).toBe(client2)
      // Connect should only be called once
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })
  })

  describe('callTool', () => {
    it('should export callTool function', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(callTool).toBeDefined()
      expect(typeof callTool).toBe('function')
    })

    it('should call the tool and return success result', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', { arg1: 'value1' })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ result: 'success' })
    })

    it('should handle non-JSON text content', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'plain text result' }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(true)
      expect(result.data).toBe('plain text result')
    })

    it('should handle structured content', async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        structuredContent: { key: 'value' }
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ key: 'value' })
    })

    it('should handle errors gracefully', async () => {
      mockCallTool.mockRejectedValue(new Error('Connection failed'))

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(false)
      expect(result.data).toBeNull()
      expect(result.error).toBe('Connection failed')
    })

    // Issue #50: mcp-neo4j-cypher's `write_neo4j_cypher` returns Neo4j errors
    // as a plain text result instead of failing the call, so callTool's text
    // path used to return `{ success: true, data: "Neo4j Error: ..." }` and
    // downstream gating (view.hasErrors, enricher's success check, the
    // synthesizer) couldn't tell a real failure from a real success.
    it('demotes "Neo4j Error:" text results to success:false (issue #50)', async () => {
      const neo4jErrorText =
        'Neo4j Error: {neo4j_code: Neo.ClientError.Statement.ParameterMissing} ' +
        '{message: Expected parameter(s): pulsarName, pulsarDesc, platformName, platformDesc} ' +
        '{gql_status: 50N42}'
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: neo4jErrorText }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('write_neo4j_cypher', { query: 'MERGE ...' })

      expect(result.success).toBe(false)
      expect(result.data).toBeNull()
      expect(result.error).toBe(neo4jErrorText)
    })

    it('demotes any "<ToolName> Error:" prefixed text result', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Redis Error: WRONGTYPE Operation against a key…' }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('some_redis_tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/^Redis Error:/)
    })

    it('preserves success:true for normal Neo4j write results (regression)', async () => {
      // Real shape returned by a successful write_neo4j_cypher call.
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            _contains_updates: true,
            nodes_created: 2,
            relationships_created: 1,
            properties_set: 4,
            labels_added: 2
          })
        }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('write_neo4j_cypher', { query: 'MERGE ...' })

      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({ nodes_created: 2, relationships_created: 1 })
    })

    it('does not demote unrelated text starting with a capital word', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello world — nothing wrong here.' }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(true)
      expect(result.data).toBe('Hello world — nothing wrong here.')
    })

    // The kg-agent gateway's meta-tools (mcp-add, code-mode) emit failures as a
    // bare "Error: ..." text result with no preceding tool-name token. The old
    // regex required "<Word> Error:" and missed these, so a failed mcp-add was
    // stamped success:true (see .harness-logs/context-neo4j-nosecrets.json).
    it('demotes a bare "Error:" prefixed text result (gateway meta-tools)', async () => {
      const text =
        "Error: Cannot add server 'neo4j-cypher'. Missing required secrets (neo4j-cypher.password)."
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text }] })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('mcp-add', { name: 'neo4j-cypher' })

      expect(result.success).toBe(false)
      expect(result.data).toBeNull()
      expect(result.error).toMatch(/^Error: Cannot add server/)
    })

    it('does not demote text that merely contains "Error:" mid-string', async () => {
      // Anchored at start — a mid-string "Error:" must not trip demotion.
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'The result has no Error: here' }]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(true)
      expect(result.data).toBe('The result has no Error: here')
    })

    // Multi-value Redis tools (smembers, lrange, search-style) return ONE text
    // block PER element. callTool used to `.find` only the first block and
    // silently drop the rest (so e.g. a 3-member set listed as 1); it now
    // aggregates them into an array. Single-block behavior is unchanged.
    it('aggregates multiple text blocks into an array (e.g. smembers)', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'id-a' },
          { type: 'text', text: 'id-b' },
          { type: 'text', text: 'id-c' },
        ]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('smembers', { name: 'some:set' })

      expect(result.success).toBe(true)
      expect(result.data).toEqual(['id-a', 'id-b', 'id-c'])
    })

    it('JSON-parses each block when aggregating', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: '{"k":1}' },
          { type: 'text', text: '{"k":2}' },
        ]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('search', {})

      expect(result.success).toBe(true)
      expect(result.data).toEqual([{ k: 1 }, { k: 2 }])
    })

    it('demotes a multi-block result whose leading block is an error', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'Error: something went wrong' },
          { type: 'text', text: 'trailing detail' },
        ]
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('some_tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/^Error: something went wrong/)
    })
  })

  describe('listTools', () => {
    it('should export listTools function', async () => {
      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(listTools).toBeDefined()
      expect(typeof listTools).toBe('function')
    })

    it('should return list of tool descriptions', async () => {
      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

      const tools = await listTools()

      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('test_tool')
      expect(tools[0].description).toBe('A test tool')
    })

    it('should return empty array on error', async () => {
      mockListTools.mockRejectedValue(new Error('Failed'))

      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

      const tools = await listTools()

      expect(tools).toEqual([])
    })
  })

  describe('closeMcpClient', () => {
    it('should export closeMcpClient function', async () => {
      const { closeMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(closeMcpClient).toBeDefined()
      expect(typeof closeMcpClient).toBe('function')
    })

    it('should close the client', async () => {
      const { getMcpClient, closeMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')

      // First create a client
      await getMcpClient()

      // Then close it
      await closeMcpClient()

      expect(mockClose).toHaveBeenCalled()
    })

    it('should handle close when no client exists', async () => {
      const { closeMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')

      // Should not throw when no client
      await closeMcpClient()

      // Close shouldn't be called since there's no client
      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  describe('isConnected', () => {
    it('should export isConnected function', async () => {
      const { isConnected } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(isConnected).toBeDefined()
      expect(typeof isConnected).toBe('function')
    })

    it('should return false when no client', async () => {
      const { isConnected } = await import('../../../lib/harness-patterns/mcp-client.server')

      expect(isConnected()).toBe(false)
    })

    it('should return true after getMcpClient', async () => {
      const { getMcpClient, isConnected } = await import('../../../lib/harness-patterns/mcp-client.server')

      await getMcpClient()

      expect(isConnected()).toBe(true)
    })
  })

  // Build-order step 3: callTool dispatches sandbox-owned tool names to the
  // active `withSandbox` scope's in-VM transport, not the host gateway. See
  // docs/plan/sandbox.md → "How tools reach the controller".
  describe('callTool sandbox dispatch', () => {
    it('routes sandbox-owned tool names to the in-VM transport, not the gateway', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')
      const { runWithSandbox } = await import('../../../lib/sandbox/scope.server')

      const sandboxCallTool = vi.fn().mockResolvedValue({ success: true, data: 'from-sandbox' })
      const transport = {
        vmId: 'sbx-1',
        toolNames: async () => ['sandbox_bash'],
        listTools: async () => [],
        ownsTool: (n: string) => n === 'sandbox_bash',
        callTool: sandboxCallTool,
        close: async () => {},
      }

      const result = await runWithSandbox(transport, () =>
        callTool('sandbox_bash', { cmd: 'echo hi' }),
      )

      expect(result).toEqual({ success: true, data: 'from-sandbox' })
      expect(sandboxCallTool).toHaveBeenCalledWith('sandbox_bash', { cmd: 'echo hi' })
      // Gateway path must not have been touched for a sandbox-owned tool.
      expect(mockCallTool).not.toHaveBeenCalled()
    })

    it('falls through to the gateway for tools the sandbox does not own', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')
      const { runWithSandbox } = await import('../../../lib/sandbox/scope.server')

      const sandboxCallTool = vi.fn()
      const transport = {
        vmId: 'sbx-2',
        toolNames: async () => ['sandbox_bash'],
        listTools: async () => [],
        ownsTool: (n: string) => n === 'sandbox_bash',
        callTool: sandboxCallTool,
        close: async () => {},
      }

      const result = await runWithSandbox(transport, () =>
        callTool('neo4j_query', { cypher: 'MATCH (n) RETURN n' }),
      )

      // The gateway mock returned `{ result: 'success' }` per beforeEach.
      expect(result.success).toBe(true)
      expect(mockCallTool).toHaveBeenCalledOnce()
      expect(sandboxCallTool).not.toHaveBeenCalled()
    })

    it('routes everything to the gateway outside any sandbox scope', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('whatever', {})

      expect(result.success).toBe(true)
      expect(mockCallTool).toHaveBeenCalledOnce()
    })
  })
})

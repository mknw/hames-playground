/**
 * MCP Client Tests
 *
 * Tests for the MCP client module.
 * Note: These tests mock the MCP SDK to avoid actual network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock the MCP SDK
const mockConnect = vi.fn()
const mockClose = vi.fn()
const mockCallTool = vi.fn()
const mockListTools = vi.fn()

// Every client the module builds is recorded, so the pool tests (#120) can
// assert WHICH connection was closed by a reconnect.
const clientInstances: MockClient[] = []

class MockClient {
  closed = false
  connect = mockConnect
  close = async () => {
    this.closed = true
    return mockClose()
  }
  callTool = mockCallTool
  listTools = mockListTools

  constructor() {
    clientInstances.push(this)
  }
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

class MockTransport {}

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockTransport,
}))

describe('mcp-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientInstances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: '{"result": "success"}' }],
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }],
    })
  })

  afterEach(async () => {
    // Reset module state between tests
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  // There is no unleased accessor (#120): `callTool`/`listTools` are the only
  // doors to the gateway, so connection lifecycle is asserted through them.
  describe('connection lifecycle', () => {
    it('should create and connect a client on first use', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      await callTool('test_tool', {})

      expect(mockConnect).toHaveBeenCalled()
      expect(clientInstances).toHaveLength(1)
    })

    it('should reuse the same warm connection on subsequent calls', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      await callTool('test_tool', {})
      await callTool('test_tool', {})

      // The lease came back to the pool, so no second client was built.
      expect(clientInstances).toHaveLength(1)
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
        content: [{ type: 'text', text: 'plain text result' }],
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(true)
      expect(result.data).toBe('plain text result')
    })

    it('should handle structured content', async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        structuredContent: { key: 'value' },
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
    // compactExecution) couldn't tell a real failure from a real success.
    it('demotes "Neo4j Error:" text results to success:false (issue #50)', async () => {
      const neo4jErrorText =
        'Neo4j Error: {neo4j_code: Neo.ClientError.Statement.ParameterMissing} ' +
        '{message: Expected parameter(s): pulsarName, pulsarDesc, platformName, platformDesc} ' +
        '{gql_status: 50N42}'
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: neo4jErrorText }],
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('write_neo4j_cypher', { query: 'MERGE ...' })

      expect(result.success).toBe(false)
      expect(result.data).toBeNull()
      expect(result.error).toBe(neo4jErrorText)
    })

    it('demotes any "<ToolName> Error:" prefixed text result', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Redis Error: WRONGTYPE Operation against a key…' }],
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('some_redis_tool', {})

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/^Redis Error:/)
    })

    it('preserves success:true for normal Neo4j write results (regression)', async () => {
      // Real shape returned by a successful write_neo4j_cypher call.
      mockCallTool.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              _contains_updates: true,
              nodes_created: 2,
              relationships_created: 1,
              properties_set: 4,
              labels_added: 2,
            }),
          },
        ],
      })

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('write_neo4j_cypher', { query: 'MERGE ...' })

      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({ nodes_created: 2, relationships_created: 1 })
    })

    it('does not demote unrelated text starting with a capital word', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello world — nothing wrong here.' }],
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
        content: [{ type: 'text', text: 'The result has no Error: here' }],
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
        ],
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
        ],
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
        ],
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

    it('should return gateway tool descriptions', async () => {
      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

      const tools = await listTools()

      const gateway = tools.find((t) => t.name === 'test_tool')
      expect(gateway).toBeDefined()
      expect(gateway!.description).toBe('A test tool')
    })

    it('should append in-process app tools to the gateway list (#110)', async () => {
      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

      const tools = await listTools()

      // App-side tools (per-user Graph) are advertised alongside gateway tools.
      expect(tools.map((t) => t.name)).toContain('graph_me')
    })

    it('should still offer app tools when the gateway fails', async () => {
      mockListTools.mockRejectedValue(new Error('Failed'))

      const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

      const tools = await listTools()

      // No gateway tools, but app tools run in-process so they survive.
      expect(tools.every((t) => t.name !== 'test_tool')).toBe(true)
      expect(tools.map((t) => t.name)).toContain('graph_me')
    })
  })

  describe('closeMcpClient', () => {
    it('should export closeMcpClient function', async () => {
      const { closeMcpClient } = await import('../../../lib/harness-patterns/mcp-client.server')
      expect(closeMcpClient).toBeDefined()
      expect(typeof closeMcpClient).toBe('function')
    })

    it('should close the client', async () => {
      const { callTool, closeMcpClient } =
        await import('../../../lib/harness-patterns/mcp-client.server')

      // First create a client
      await callTool('test_tool', {})

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

    it('should return true after a call has warmed a connection', async () => {
      const { callTool, isConnected } =
        await import('../../../lib/harness-patterns/mcp-client.server')

      await callTool('test_tool', {})

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

  // Issue #120: the gateway client used to be a module-level singleton, so a
  // transport blip on ANY call dropped the shared client and tore down every
  // other in-flight request. Calls now lease one of N pooled connections and a
  // reconnect rebuilds only the leased one.
  describe('connection pool (#120)', () => {
    function deferred<T = void>() {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((res) => {
        resolve = res
      })
      return { promise, resolve }
    }

    it('scopes a mid-flight reconnect to the failing lease; the other call is untouched', async () => {
      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const steadyStarted = deferred()
      const releaseSteady = deferred()
      let flakyAttempts = 0

      mockCallTool.mockImplementation(async ({ name }: { name: string }) => {
        if (name === 'steady') {
          steadyStarted.resolve()
          await releaseSteady.promise
          return { content: [{ type: 'text', text: 'steady-ok' }] }
        }
        flakyAttempts++
        if (flakyAttempts === 1) {
          // Only fail once the other call is provably mid-flight.
          await steadyStarted.promise
          throw new Error('socket hang up')
        }
        return { content: [{ type: 'text', text: 'flaky-ok' }] }
      })

      // A READ tool: only those are re-executed after a transport error (SA-H6).
      const flaky = callTool('get_flaky', {})
      const steady = callTool('steady', {})

      expect(await flaky).toEqual({ success: true, data: 'flaky-ok' })

      // Three clients: the flaky call's original, the steady call's, and the
      // flaky call's rebuilt one. Only the failing connection was closed.
      expect(clientInstances).toHaveLength(3)
      expect(clientInstances[0].closed).toBe(true)
      expect(clientInstances[1].closed).toBe(false)
      expect(mockClose).toHaveBeenCalledTimes(1)

      // …and the untouched connection's call still completes normally.
      releaseSteady.resolve()
      expect(await steady).toEqual({ success: true, data: 'steady-ok' })
      expect(clientInstances[1].closed).toBe(false)
    })

    it('retries a transport error exactly once on a rebuilt connection (read-only tool)', async () => {
      mockCallTool.mockRejectedValue(new Error('fetch failed'))

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('read_neo4j_cypher', {})

      expect(result.success).toBe(false)
      expect(result.error).toBe('fetch failed')
      expect(mockCallTool).toHaveBeenCalledTimes(2)
      // Exactly one reconnect: original closed, one replacement built.
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[0].closed).toBe(true)
    })

    // SA-H6. A transport error is not evidence that the call did not run: the
    // request can reach the gateway, execute, and lose only the socket carrying
    // the response. Re-running a WRITE in that state duplicates it.
    describe('re-execution safety (SA-H6)', () => {
      it('does NOT retry a mutating tool after a transport error', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        mockCallTool.mockRejectedValue(new Error('socket hang up'))

        const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

        const result = await callTool('write_neo4j_cypher', {
          query: 'CREATE (:Node {n: 1})',
        })

        // Surfaced as a failure the controller can see and decide about…
        expect(result.success).toBe(false)
        expect(result.error).toBe('socket hang up')
        // …and executed exactly ONCE. This is the assertion that matters: a
        // second call here is a second CREATE in the graph.
        expect(mockCallTool).toHaveBeenCalledTimes(1)
        // The broken connection is still reset, so the pool heals.
        expect(clientInstances[0].closed).toBe(true)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('write_neo4j_cypher'))
        warn.mockRestore()
      })

      it('classifies reads and writes conservatively', async () => {
        const { isReadOnlyTool } = await import(
          '../../../lib/harness-patterns/mcp-client.server'
        )

        for (const name of [
          'read_neo4j_cypher',
          'get_neo4j_schema',
          'list_issues',
          'search_code',
          'get-library-docs',
          'resolve-library-id',
          'head_file',
          'tail_file',
          'find_duplicate_files',
          'fetch_content',
          'json_get',
          'smembers',
          'hgetall',
          'lrange',
          'scan_keys',
          'read_graph',
          'open_nodes',
          'mcp__gateway__read_file',
        ]) {
          expect(isReadOnlyTool(name), name).toBe(true)
        }

        // Everything else — including anything unrecognised — is treated as
        // potentially mutating, which is what makes the default safe.
        for (const name of [
          'write_neo4j_cypher',
          'create_issue',
          'create_or_update_file',
          'add_observations',
          'delete_entities',
          'push_files',
          'merge_pull_request',
          'set_vector_in_hash',
          'hset',
          'json_set',
          'lpop',
          'rpop',
          'expire',
          'rename',
          'publish',
          'subscribe',
          'zip_directory',
          'unzip_file',
          'code-mode',
          'mcp-exec',
          'mcp-add',
          'sandbox_bash',
          'something_nobody_has_classified',
        ]) {
          expect(isReadOnlyTool(name), name).toBe(false)
        }
      })

      it('still retries listTools, which is idempotent by construction', async () => {
        mockListTools
          .mockRejectedValueOnce(new Error('connection closed'))
          .mockResolvedValueOnce({ tools: [{ name: 'later_tool', inputSchema: {} }] })

        const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')

        const tools = await listTools()

        expect(mockListTools).toHaveBeenCalledTimes(2)
        expect(tools.map((t) => t.name)).toContain('later_tool')
      })
    })

    it('never retries a tool-level error', async () => {
      mockCallTool.mockRejectedValue(new Error('Tool execution failed: unknown argument'))

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const result = await callTool('test_tool', {})

      expect(result.success).toBe(false)
      expect(mockCallTool).toHaveBeenCalledTimes(1)
      expect(mockClose).not.toHaveBeenCalled()
      expect(clientInstances).toHaveLength(1)
    })

    it('releases the lease when the call throws, so the connection is reused', async () => {
      mockCallTool.mockRejectedValueOnce(new Error('Tool execution failed: bad args'))

      const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')

      const failed = await callTool('test_tool', {})
      const ok = await callTool('test_tool', {})

      expect(failed.success).toBe(false)
      expect(ok.success).toBe(true)
      // The finally-release put the warm connection back — no second client.
      expect(clientInstances).toHaveLength(1)
    })

    // Exhaustion contract: the pool GROWS (an overflow connection is opened
    // for the extra call and closed on release) rather than queueing, so a
    // slow tool can't stall unrelated calls behind a busy slot.
    it('grows past the pool size instead of queueing, and closes the overflow', async () => {
      vi.stubEnv('MCP_GATEWAY_POOL_SIZE', '1')

      const { callTool, isConnected } =
        await import('../../../lib/harness-patterns/mcp-client.server')

      const release = deferred()
      mockCallTool.mockImplementation(async () => {
        await release.promise
        return { content: [{ type: 'text', text: 'ok' }] }
      })

      const first = callTool('a', {})
      const second = callTool('b', {})

      // The second call got its own connection immediately — it did not wait
      // for the single warm slot to free up.
      expect(clientInstances).toHaveLength(2)

      release.resolve()
      const results = await Promise.all([first, second])

      expect(results.every((r) => r.success)).toBe(true)
      expect(mockCallTool).toHaveBeenCalledTimes(2)
      expect(clientInstances[0].closed).toBe(false) // warm slot stays open
      expect(clientInstances[1].closed).toBe(true) // overflow closed on release
      expect(isConnected()).toBe(true)
    })

    // Shutdown races an in-flight lease: closeMcpClient() drops the leased
    // connection from the pool and closes its client, which the in-flight op
    // sees as a transport error and reconnects on. That rebuild must not
    // survive shutdown — closeMcpClient() demotes the connection to non-warm
    // so its release closes it.
    it('does not leak a connection rebuilt by a lease that outlived closeMcpClient', async () => {
      const { callTool, closeMcpClient, isConnected } =
        await import('../../../lib/harness-patterns/mcp-client.server')

      const held = deferred()
      let attempts = 0
      mockCallTool.mockImplementation(async () => {
        attempts++
        if (attempts === 1) {
          await held.promise
          throw new Error('connection closed')
        }
        return { content: [{ type: 'text', text: 'late-ok' }] }
      })

      const inflight = callTool('get_slow', {})
      await Promise.resolve() // let the call take its lease and connect

      await closeMcpClient()
      expect(isConnected()).toBe(false)

      // The in-flight call now fails, reconnects on its orphaned connection
      // and completes — on a client nothing else is tracking.
      held.resolve()
      expect(await inflight).toEqual({ success: true, data: 'late-ok' })

      // Both the closed original AND the post-shutdown rebuild are shut down.
      expect(clientInstances).toHaveLength(2)
      expect(clientInstances.every((c) => c.closed)).toBe(true)
      expect(isConnected()).toBe(false)
    })
  })
})

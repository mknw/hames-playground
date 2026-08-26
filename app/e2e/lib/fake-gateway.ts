/**
 * A fake MCP gateway — the tool half of the hermetic run.
 *
 * `mcp-client.server.ts` reads `MCP_GATEWAY_URL` ONCE, at module load, and
 * connects a `StreamableHTTPClientTransport` to it. Pointing that at this
 * server instead of `localhost:8811` removes Docker from the suite's
 * dependencies and — more importantly — makes tool results deterministic, so a
 * scenario asserting "the second turn saw the first turn's result" is not
 * quietly asserting something about the state of a developer's Neo4j.
 *
 * ## Why it is hand-rolled rather than `McpServer`
 *
 * The SDK's server-side `registerTool` takes Zod schemas, and Zod is not a
 * dependency of this app — only a transitive one of the SDK. Streamable HTTP is
 * JSON-RPC over `POST`, and the four methods a client actually exercises
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) are
 * ninety lines of plain request handling. Fewer moving parts in a fake is worth
 * more than reusing a framework, and the transport contract is pinned by the
 * fact that the REAL client is what talks to it.
 *
 * ## The tools it advertises
 *
 * Named to land in the same namespaces `tools.server.ts` groups the real ones
 * into (`KNOWN_TOOL_SERVERS`), because the agents under test index by namespace:
 * the search agent hands `tools.neo4j` to its graph route and `tools.web` to
 * its guarded web route. A fake tool with an invented name would group under a
 * namespace no agent reads and the route would run with an empty tool list.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** What a fake tool returns, and how often it was called. */
export interface FakeToolCall {
  name: string
  args: Record<string, unknown>
}

export interface FakeGateway {
  readonly url: string
  readonly port: number
  readonly toolCalls: readonly FakeToolCall[]
  /** Override one tool's reply for the next scenario. `text` is returned as a
   *  single MCP text block, which `callTool` JSON-parses when it can. */
  setResult(tool: string, text: string): void
  /** Make one tool fail, so a scenario can drive the loop's error branch. */
  setError(tool: string, message: string): void
  reset(): void
  close(): Promise<void>
}

/** Tool name → the JSON text block it answers with, by default. */
const DEFAULT_RESULTS: Record<string, string> = {
  get_neo4j_schema: JSON.stringify([{ label: 'Node', properties: { name: 'STRING' } }]),
  read_neo4j_cypher: JSON.stringify([{ n: 42 }]),
  write_neo4j_cypher: JSON.stringify({ nodes_created: 0 }),
  search: JSON.stringify([{ title: 'E2E result', url: 'https://example.invalid/e2e' }]),
  fetch: 'E2E fetched page body.',
}

const TOOLS = [
  {
    name: 'get_neo4j_schema',
    description: 'Return the graph schema.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_neo4j_cypher',
    description: 'Run a read-only Cypher query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'search',
    description: 'Search the web.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Fetch a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
]

export async function startFakeGateway(port = 0): Promise<FakeGateway> {
  const toolCalls: FakeToolCall[] = []
  const results = new Map<string, string>()
  const errors = new Map<string, string>()

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      // The client may open a GET for the server→client SSE channel. This fake
      // never pushes, so refusing it is correct and the SDK tolerates it.
      res.writeHead(405).end()
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(raw || '{}') as typeof msg
      } catch {
        res.writeHead(400).end()
        return
      }

      // A notification (no `id`) gets 202 with no body, per the transport spec.
      if (msg.id === undefined) {
        res.writeHead(202).end()
        return
      }

      const reply = (result: unknown): void => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      }

      switch (msg.method) {
        case 'initialize':
          reply({
            protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'e2e-fake-gateway', version: '1.0.0' },
          })
          return
        case 'tools/list':
          reply({ tools: TOOLS })
          return
        case 'tools/call': {
          const name = String(msg.params?.name ?? '')
          const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
          toolCalls.push({ name, args })
          const failure = errors.get(name)
          if (failure) {
            reply({ content: [{ type: 'text', text: failure }], isError: true })
            return
          }
          const text = results.get(name) ?? DEFAULT_RESULTS[name] ?? JSON.stringify({ ok: true })
          reply({ content: [{ type: 'text', text }] })
          return
        }
        default:
          // Unknown methods (`ping`, `resources/list`) answer with an empty
          // result rather than an error — a JSON-RPC error here would make the
          // SDK client tear the connection down mid-scenario.
          reply({})
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const bound = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${bound}/mcp`,
    port: bound,
    get toolCalls() {
      return toolCalls
    },
    setResult(tool, text) {
      results.set(tool, text)
    },
    setError(tool, message) {
      errors.set(tool, message)
    },
    reset() {
      toolCalls.length = 0
      results.clear()
      errors.clear()
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

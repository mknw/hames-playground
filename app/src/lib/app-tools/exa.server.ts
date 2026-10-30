/** Exa's hosted MCP search/fetch, registered as a process transport.
 * The shared callTool chokepoint applies egress checks and result screening
 * before and after this transport. Never expose the credential in descriptors. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
import type { MCPToolDescription, ToolCallResult } from '@hames-ai/harness-patterns/types'

assertServerOnImport()

const EXA_TOOLS = ['web_search_exa', 'web_fetch_exa'] as const
type ExaTool = (typeof EXA_TOOLS)[number]

/** Fixed failure names, one per classified cause. See classifyExaFailure. */
const EXA_FAILURES = {
  timeout: 'Exa hosted request timed out',
  rateLimit: 'Exa hosted rate limit reached (HTTP 429)',
  unavailable: 'Exa hosted request unavailable',
} as const

/** Classify a failed hosted call into a fixed, safe name.
 *
 * FRONT: every failure must be NAMED and non-retried, and never expose SDK
 * error detail. The SDK's thrown messages carry the provider's response
 * text and request metadata from the authenticated connection, so this
 * classifies by SHAPE only — the numeric `code` the two error classes use:
 * `McpError.code` (the protocol layer) and the HTTP status the streamable
 * transport reports as `StreamableHTTPError.code`. `ErrorCode.RequestTimeout`
 * (-32001) is how the MCP SDK reports its bounded request timeout — every
 * request is capped at 60s by the SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC,
 * and the transport's `finally { client.close() }` aborts what is in flight —
 * so no extra timer is needed here. HTTP 429 is Exa's documented rate-limit
 * refusal (the expected failure mode of the keyless tier). Failures are
 * final: process transports are dispatched exactly once by the shared
 * chokepoint (the gateway-only reconnect retry does not reach them) and this
 * transport never re-sends. */
function classifyExaFailure(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code: unknown }).code
      : undefined
  if (code === ErrorCode.RequestTimeout) return EXA_FAILURES.timeout
  if (code === 429) return EXA_FAILURES.rateLimit
  return EXA_FAILURES.unavailable
}

/** Developer switch; invalid values fail at boot instead of silently widening access. */
export function selectedExaTools(value = process.env.EXA_TOOLS): readonly ExaTool[] {
  switch (value ?? 'both') {
    case 'both':
      return EXA_TOOLS
    case 'search':
      return ['web_search_exa']
    case 'fetch':
      return ['web_fetch_exa']
    case 'off':
      return []
    default:
      throw new Error('EXA_TOOLS must be both, search, fetch, or off')
  }
}

/** An absent key uses Exa's documented keyless free-rate-limit tier. */
export function createExaTransport(
  selected = selectedExaTools(),
  key = process.env.EXA_API_KEY,
): ToolTransport {
  const allowed = new Set(selected)
  if (allowed.size && !key) {
    console.warn('[exa] EXA_API_KEY absent; hosted search/fetch use Exa keyless free rate limit')
  }

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const url = new URL('https://mcp.exa.ai/mcp')
    url.searchParams.set('tools', selected.join(','))
    const client = new Client({ name: 'hames-exa', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          ...(key ? { requestInit: { headers: { 'x-api-key': key } } } : {}),
        }),
      )
      return await run(client)
    } finally {
      try {
        await client.close()
      } catch {
        // Best effort after a failed request; never expose SDK error details.
      }
    }
  }

  return {
    id: 'exa-hosted',
    ownsTool: (name) => allowed.has(name as ExaTool),
    namespaceFor: (name) => (allowed.has(name as ExaTool) ? 'web' : undefined),
    listTools: async (): Promise<MCPToolDescription[]> => {
      if (!allowed.size) return []
      try {
        const { tools } = await withClient((client) => client.listTools())
        const listed = tools.filter((tool) => allowed.has(tool.name as ExaTool))
        for (const name of selected) {
          if (!listed.some((tool) => tool.name === name)) {
            console.warn(`[exa] selected tool ${name} absent from hosted discovery`)
          }
        }
        return listed.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        }))
      } catch {
        // The shared catalog logs the transport id. Never log SDK errors:
        // they can contain request metadata from the authenticated connection.
        throw new Error('Exa hosted tool discovery unavailable')
      }
    },
    callTool: async (name, args): Promise<ToolCallResult> => {
      if (!allowed.has(name as ExaTool)) {
        return { success: false, data: null, error: 'Exa tool disabled' }
      }
      try {
        const result = await withClient((client) => client.callTool({ name, arguments: args }))
        const content = (Array.isArray(result.content) ? result.content : [])
          .filter(
            (item: unknown): item is { type: 'text'; text: string } =>
              typeof item === 'object' &&
              item !== null &&
              'type' in item &&
              item.type === 'text' &&
              'text' in item &&
              typeof item.text === 'string',
          )
          .map((item) => item.text)
        const data = content.length === 1 ? content[0] : content
        return result.isError
          ? { success: false, data: null, error: String(data) }
          : { success: true, data }
      } catch (err) {
        return { success: false, data: null, error: classifyExaFailure(err) }
      }
    },
  }
}

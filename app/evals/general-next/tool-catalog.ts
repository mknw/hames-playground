/** Live mode reads production gateway metadata only; no gateway tool is executed. */
import type { MCPToolDescription } from '@hames-ai/harness-patterns'
import { registerGraphConnectorTools } from '@hames-ai/connectors/graph/graph-tools.server'
import { SANDBOX_FILE_TOOLS } from '../../src/lib/eval-support/synthetic-sandbox'

export async function productionCatalog(gatewayUrl: string): Promise<MCPToolDescription[]> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'general-eval-metadata', version: '1' })
  const tools: MCPToolDescription[] = []
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl)))
    let cursor: string | undefined
    do {
      const page = await client.listTools({ cursor })
      tools.push(...page.tools.map((t) => ({ ...t, name: t.name.split('__').at(-1)! })))
      cursor = page.nextCursor
    } while (cursor)
  } finally {
    await client.close()
  }
  const refuse = (): never => {
    throw new Error('Metadata-only Graph supplier cannot execute')
  }
  registerGraphConnectorTools({
    registerAppTool: (def) =>
      tools.push({ name: def.name, description: def.description, inputSchema: def.inputSchema }),
    graphFetch: refuse,
    content: {
      conversionEnabled: refuse,
      isConvertible: refuse,
      guessMimeType: refuse,
      isTextMime: refuse,
    },
    stash: { loadStore: refuse, ingest: refuse },
  })
  tools.push({
    name: 'sandbox_bash',
    // rootfs/mcp-shell/server.mjs: production bash tool, exposed with its sandbox prefix.
    description:
      'Run a shell command inside the sandbox via `bash -lc`. Use for Python ' +
      '(`python3 -c "..."` or run a script written to /work), package installs, ' +
      'file inspection, and any other shell work. Returns stdout, stderr, the ' +
      'exit code, and whether it timed out. Working directory defaults to /work.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (passed to bash -lc).',
        },
        cwd: { type: 'string', description: 'Working directory. Defaults to /work.' },
        timeout_ms: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Wall-clock timeout in milliseconds. Defaults to 60000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  })
  // The production sandbox also exposes its file tools, which a model's script-writing habit uses.
  tools.push(...SANDBOX_FILE_TOOLS)
  return tools
}

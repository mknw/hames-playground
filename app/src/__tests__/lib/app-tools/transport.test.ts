/**
 * The app-side tools are reachable from a tool call — and the BOOT path is what
 * makes them so.
 *
 * `harness-patterns/mcp-client.server.ts` used to import `app-tools` directly,
 * which meant app tools were registered by the side effect of core loading.
 * That import was the core→app cycle this seam exists to cut, so it is gone:
 * core owns the dispatch ORDER, the app owns what is on it. The consequence is
 * that nothing registers the app tools unless the app says so, and a regression
 * here is silent — `graph_me` would simply fall through to the MCP gateway,
 * which has no such tool and answers with an error the model would read as the
 * tool not existing.
 *
 * Two halves, because either alone is vacuous:
 *   1. importing the barrel registers a transport that dispatches `graph_me`;
 *   2. the server-boot hook imports the barrel.
 *
 * The second is a source scan for the same reason `browser-e2e-not-in-ci.test.ts`
 * scans: importing `src/middleware.ts` for real would arm the routine scheduler
 * and the usage recorder in a unit run. That file's closure walk covers the
 * transitive half (nothing the new subtree drags in may reach BAML at module
 * scope); this one covers the edge itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockCallTool = vi.fn()
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    callTool = mockCallTool
    listTools = vi.fn().mockResolvedValue({ tools: [] })
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('the app-tool transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '"from-gateway"' }] })
  })

  it('is registered by importing the barrel, and takes graph_me off the gateway', async () => {
    await import('../../../lib/app-tools/index.server')
    const { callTool } = await import('@hames/harness-patterns/mcp-client.server')

    // No user is in scope, so the tool refuses — which is `runAppTool`'s own
    // answer (#107: identity is resolved server-side, never from args) and is
    // proof the call was dispatched IN-PROCESS rather than to the gateway.
    const result = await callTool('graph_me', {})

    expect(mockCallTool).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toContain('requires an authenticated user')
  })

  it('advertises its tools through listTools', async () => {
    await import('../../../lib/app-tools/index.server')
    const { listTools } = await import('@hames/harness-patterns/mcp-client.server')

    expect((await listTools()).map((t) => t.name)).toContain('graph_me')
  })

  it('is registered as a PROCESS transport, so a scoped one of the same name wins', async () => {
    await import('../../../lib/app-tools/index.server')
    const { callTool } = await import('@hames/harness-patterns/mcp-client.server')
    const { withTransport } = await import('@hames/harness-patterns/tool-transport.server')

    const inVm = vi.fn().mockResolvedValue({ success: true, data: 'in-vm' })
    const result = await withTransport(
      {
        id: 'sandbox:collide',
        ownsTool: (n) => n === 'graph_me',
        callTool: inVm,
        listTools: async () => [],
      },
      () => callTool('graph_me', {}),
    )

    expect(result).toEqual({ success: true, data: 'in-vm' })
    expect(inVm).toHaveBeenCalledOnce()
  })
})

describe('the server-boot hook is what performs that registration', () => {
  const middleware = readFileSync(path.join(APP, 'src/middleware.ts'), 'utf8')
  const code = middleware.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('imports the app-tools barrel', () => {
    // The barrel, never `registry.server` — registration is the barrel's import
    // side effect, and a boot hook that named the registry directly would arm
    // nothing.
    expect(code).toMatch(/^import ['"]\.\/lib\/app-tools\/index\.server['"]/m)
  })

  it('and core does not, so the boot hook is the only thing that can', () => {
    // The cycle this seam cut. If core imported `app-tools` again the boot edge
    // above would still be correct but would stop being load-bearing, and its
    // loss would go unnoticed until the library was published without the app.
    const core = readFileSync(
      // The library moved to packages/ (#225 Step 1a); the scan root follows it.
      path.join(APP, '../packages/harness-patterns/mcp-client.server.ts'),
      'utf8',
    )
    expect(core).not.toMatch(/app-tools/)
  })
})

/** Live mode's sandbox file tools are the gateway's own rust-mcp-filesystem entries under
 * the production names: the description the model reads is the server's text, not ours. */
import { describe, expect, it, vi } from 'vitest'
import '../../mocks/namespace-catalog'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { productionCatalog } from '../../../../evals/general-next/tool-catalog'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const native = V0_IN_VM_SERVERS.find((s) => s.key === 'filesystem')!.tools
let listed = Object.keys(native)
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => ({
      tools: listed.map((name) => ({
        name: `rust-mcp-filesystem__${name}`,
        description: `server text of ${name}`,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      })),
    }))
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

describe('productionCatalog sandbox file tools', () => {
  it('derives each one from the gateway entry, renamed through V0_IN_VM_SERVERS', async () => {
    listed = Object.keys(native)
    const tools = await productionCatalog('http://gateway.invalid/mcp')
    for (const [nativeName, exposed] of Object.entries(native)) {
      const tool = tools.find((t) => t.name === exposed)
      expect(tool?.description, exposed).toBe(`server text of ${nativeName}`)
    }
    expect(tools.find((t) => t.name === 'sandbox_bash')?.description).toContain('bash -lc')
  })

  it('refuses to invent one the gateway does not list', async () => {
    listed = Object.keys(native).filter((n) => n !== 'write_file')
    await expect(productionCatalog('http://gateway.invalid/mcp')).rejects.toThrow(
      'Production tool metadata missing: write_file (sandbox_write)',
    )
  })
})

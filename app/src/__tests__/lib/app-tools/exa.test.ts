// @vitest-environment node
/** Hosted Exa transport: no network, account or key is used by these tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  url: '' as string,
  headers: undefined as HeadersInit | undefined,
  called: [] as string[],
  list: [] as { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  failure: '' as string,
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options?: { requestInit?: { headers?: HeadersInit } }) {
      mcp.url = url.toString()
      mcp.headers = options?.requestInit?.headers
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => {
      if (mcp.failure) throw new Error(mcp.failure)
      return { tools: mcp.list }
    })
    callTool = vi.fn(async ({ name }: { name: string }) => {
      if (mcp.failure) throw new Error(mcp.failure)
      mcp.called.push(name)
      return { content: [{ type: 'text', text: 'provider result' }] }
    })
  },
}))

import { createExaTransport, selectedExaTools } from '../../../lib/app-tools/exa.server'

beforeEach(() => {
  mcp.url = ''
  mcp.headers = undefined
  mcp.called = []
  mcp.failure = ''
  mcp.list = [
    { name: 'web_search_exa', inputSchema: { type: 'object' } },
    { name: 'web_fetch_exa', inputSchema: { type: 'object' } },
    { name: 'agent_run' },
    { name: 'web_search_advanced_exa' },
  ]
})
afterEach(() => vi.unstubAllEnvs())

describe('hosted Exa selection and discovery', () => {
  it('defaults to precisely the two reviewed tools and keeps advanced tools hidden', async () => {
    vi.stubEnv('EXA_TOOLS', undefined)
    expect(selectedExaTools()).toEqual(['web_search_exa', 'web_fetch_exa'])
    const transport = createExaTransport(selectedExaTools(), 'server-only-test-key')
    expect((await transport.listTools()).map((tool) => tool.name)).toEqual([
      'web_search_exa',
      'web_fetch_exa',
    ])
    expect(mcp.url).toBe('https://mcp.exa.ai/mcp?tools=web_search_exa%2Cweb_fetch_exa')
    expect(mcp.headers).toEqual({ 'x-api-key': 'server-only-test-key' })
    expect(JSON.stringify(await transport.listTools())).not.toContain('server-only-test-key')
    expect(transport.namespaceFor?.('web_fetch_exa')).toBe('web')
    expect(transport.ownsTool('agent_run')).toBe(false)
    expect(transport.ownsTool('web_search_advanced_exa')).toBe(false)
  })

  it('selects search, fetch or off without changing existing providers', async () => {
    expect(selectedExaTools('search')).toEqual(['web_search_exa'])
    expect(selectedExaTools('fetch')).toEqual(['web_fetch_exa'])
    expect(selectedExaTools('off')).toEqual([])
    expect(() => selectedExaTools('all')).toThrow(/EXA_TOOLS/)
    const off = createExaTransport(selectedExaTools('off'))
    expect(await off.listTools()).toEqual([])
    expect(off.ownsTool('web_search_exa')).toBe(false)
    expect(mcp.url).toBe('')
  })

  it('makes absent-key behavior observable without sending an auth header', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const transport = createExaTransport(selectedExaTools('fetch'), undefined)
    await transport.listTools()
    expect(mcp.headers).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('keyless free rate limit'))
    expect(warning.mock.calls.flat().join(' ')).not.toContain('server-only-test-key')
    warning.mockRestore()
  })

  it('dispatches only selected names', async () => {
    const transport = createExaTransport(selectedExaTools('search'), 'test-key')
    expect(await transport.callTool('web_search_exa', { query: 'public news' })).toMatchObject({
      success: true,
      data: 'provider result',
    })
    expect(
      await transport.callTool('web_fetch_exa', { url: 'https://example.test' }),
    ).toMatchObject({
      success: false,
    })
    expect(mcp.called).toEqual(['web_search_exa'])
  })

  it('never forwards SDK errors that could carry authenticated request details', async () => {
    const key = 'synthetic-secret-sentinel'
    mcp.failure = `transport failure near ${key}`
    const transport = createExaTransport(selectedExaTools('both'), key)
    await expect(transport.listTools()).rejects.toThrow('Exa hosted tool discovery unavailable')
    const result = await transport.callTool('web_search_exa', { query: 'public' })
    expect(result).toMatchObject({ success: false, error: 'Exa hosted request unavailable' })
    expect(JSON.stringify(result)).not.toContain(key)
  })
})

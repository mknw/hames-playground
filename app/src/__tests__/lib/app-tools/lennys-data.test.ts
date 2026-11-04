// @vitest-environment node
/** Lenny's Data hosted transport: no network, account or credential is used. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { inferServer } from '@hames-ai/harness-patterns'
import {
  LENNYS_NAMESPACE,
  LENNYS_TOOL_PREFIX,
  mcpNamespace,
} from '@hames-ai/connectors/mcp-catalog'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

// The default per-user resolver's two inputs: the request scope's user id and
// that user's stored row. Synthetic example.com identities only.
const identity = vi.hoisted(() => ({
  userId: null as string | null,
  user: null as { email: string; displayName: string | null } | null,
  lookupFails: false,
}))
vi.mock('../../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: () => identity.userId,
}))
vi.mock('../../../lib/auth/users.server', () => ({
  getUser: vi.fn(async () => {
    if (identity.lookupFails) throw new Error('db down')
    return identity.user
  }),
}))

const SENTINEL = 'SDK-DETAIL-SENTINEL'
const mcp = vi.hoisted(() => ({
  clients: 0,
  url: '' as string,
  options: undefined as Record<string, unknown> | undefined,
  called: [] as { name: string; arguments: unknown }[],
  list: [] as { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  failure: undefined as unknown,
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options?: Record<string, unknown>) {
      mcp.url = url.toString()
      mcp.options = options
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor() {
      mcp.clients++
    }
    connect = vi.fn()
    close = vi.fn()
    listTools = vi.fn(async () => {
      if (mcp.failure) throw mcp.failure
      return { tools: mcp.list }
    })
    callTool = vi.fn(async (params: { name: string; arguments: unknown }) => {
      if (mcp.failure) throw mcp.failure
      mcp.called.push(params)
      return { content: [{ type: 'text', text: 'synthetic archive result' }] }
    })
  },
}))

import {
  createLennysDataTransport,
  envAuthProvider,
  LENNYS_FAILURES,
  LENNYS_MCP_URL,
  lennysDataConfig,
} from '../../../lib/app-tools/lennys-data.server'

const OWNER = 'subscriber@example.com'
const CONFIG = {
  clientId: 'synthetic-client',
  refreshToken: 'synthetic-refresh',
  users: new Set([OWNER]),
}
const asOwner = async (): Promise<string | null> => OWNER
const ON = {
  LENNYS_DATA_MCP: 'on',
  LENNYS_DATA_MCP_CLIENT_ID: 'c',
  LENNYS_DATA_MCP_REFRESH_TOKEN: 'r',
}

beforeEach(() => {
  identity.userId = null
  identity.user = null
  identity.lookupFails = false
  mcp.clients = 0
  mcp.url = ''
  mcp.options = undefined
  mcp.called = []
  mcp.failure = undefined
  mcp.list = [
    { name: 'search', description: 'Search the archive', inputSchema: { type: 'object' } },
    { name: 'get_post' },
  ]
})

describe('the LENNYS_DATA_MCP switch (default OFF)', () => {
  // MUTATION: default `env.LENNYS_DATA_MCP ?? 'on'`: the unset case returns a
  // config (and, unconfigured, throws), so this goes red.
  it('unset and off are off; nothing is discovered and no client is ever built', async () => {
    expect(lennysDataConfig({})).toBeNull()
    expect(lennysDataConfig({ LENNYS_DATA_MCP: 'off' })).toBeNull()
    const transport = createLennysDataTransport(lennysDataConfig({}))
    expect(await transport.listTools()).toEqual([])
    expect(transport.ownsTool(`${LENNYS_TOOL_PREFIX}search`)).toBe(false)
    expect(await transport.callTool(`${LENNYS_TOOL_PREFIX}search`, { query: 'x' })).toMatchObject({
      success: false,
    })
    expect(mcp.clients).toBe(0)
  })

  // MUTATION: drop the credential check: `on` alone returns a config.
  it('refuses boot on an unknown value or on `on` without both credentials', () => {
    expect(() => lennysDataConfig({ LENNYS_DATA_MCP: 'yes' })).toThrow(/on or off/)
    expect(() => lennysDataConfig({ LENNYS_DATA_MCP: 'on' })).toThrow(/CLIENT_ID/)
    expect(() =>
      lennysDataConfig({ LENNYS_DATA_MCP: 'on', LENNYS_DATA_MCP_CLIENT_ID: 'c' }),
    ).toThrow(/REFRESH_TOKEN/)
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_USERS: ' Subscriber@Example.com ,' })).toEqual(
      {
        clientId: 'c',
        refreshToken: 'r',
        users: new Set([OWNER]),
      },
    )
  })
})

describe('namespace and names', () => {
  // MUTATION: drop the prefix in listTools (expose `search` as-is): the remote
  // tool would own the gateway's `search`, and this goes red.
  it('exposes every remote tool prefixed, so it can never own a gateway name', async () => {
    const transport = createLennysDataTransport(CONFIG, asOwner)
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual(['lennys_search', 'lennys_get_post'])
    expect(tools[0].description).toMatch(/^Lenny's Data \(third-party/)
    expect(transport.ownsTool('search')).toBe(false)
    expect(transport.ownsTool('lennys_search')).toBe(true)
    expect(transport.namespaceFor?.('lennys_search')).toBe('lennys')
    expect(transport.namespaceFor?.('search')).toBeUndefined()
    expect(mcp.url).toBe(LENNYS_MCP_URL)
  })

  // MUTATION: change LENNYS_NAMESPACE to 'lennys-data' (inferServer reads it
  // back as 'lennys', so it is no fixed point), or remove the prefix rule from
  // mcpNamespace.
  it('the catalog groups the prefix as lennys, and lennys is a fixed point of inferServer', () => {
    expect(LENNYS_TOOL_PREFIX).toBe(`${LENNYS_NAMESPACE}_`)
    expect(mcpNamespace('lennys_anything')).toBe('lennys')
    expect(mcpNamespace('lennys')).toBeUndefined()
    expect(mcpNamespace('search')).toBe('web')
    // A guard declaration of a non-fixed-point namespace is refused (SD-5).
    expect(inferServer(LENNYS_NAMESPACE)).toBe(LENNYS_NAMESPACE)
  })
})

describe('calls', () => {
  // MUTATION: forward `name` unstripped, or drop the discovered-name check.
  it('strips the prefix on the way out and refuses names discovery did not offer', async () => {
    const transport = createLennysDataTransport(CONFIG, asOwner)
    await transport.listTools()
    expect(await transport.callTool('lennys_search', { query: 'synthetic' })).toEqual({
      success: true,
      data: 'synthetic archive result',
    })
    expect(mcp.called).toEqual([{ name: 'search', arguments: { query: 'synthetic' } }])
    expect(await transport.callTool('lennys_delete_everything', {})).toMatchObject({
      success: false,
    })
    expect(mcp.called).toHaveLength(1)
  })

  // MUTATION: put the credential in a header instead of the auth provider, or
  // return `String(err)` from classifyFailure.
  it.each([
    [new UnauthorizedError(SENTINEL), LENNYS_FAILURES.signIn],
    [new InvalidGrantError(SENTINEL), LENNYS_FAILURES.signIn],
    [Object.assign(new Error(SENTINEL), { code: 401 }), LENNYS_FAILURES.signIn],
    [Object.assign(new Error(SENTINEL), { code: 429 }), LENNYS_FAILURES.rateLimit],
    [Object.assign(new Error(SENTINEL), { code: -32001 }), LENNYS_FAILURES.timeout],
    [new Error(SENTINEL), LENNYS_FAILURES.unavailable],
  ])('a failed call returns a fixed message and never SDK detail (%#)', async (err, message) => {
    const transport = createLennysDataTransport(CONFIG, asOwner)
    await transport.listTools()
    mcp.failure = err
    const result = await transport.callTool('lennys_search', { query: 'synthetic' })
    expect(result).toEqual({ success: false, data: null, error: message })
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(mcp.options).toHaveProperty('authProvider')
    expect(mcp.options).not.toHaveProperty('requestInit')
    await expect(transport.listTools()).rejects.toThrow(message)
    await transport.listTools().catch((e: Error) => expect(e.message).not.toContain(SENTINEL))
  })
})

describe('the env auth provider', () => {
  // MUTATION: drop `redirectUrl` (the SDK then runs a client-credentials grant
  // instead of the refresh), or let saveTokens lose the refresh token.
  it('refreshes from the env refresh token, keeps it across a rotation-less refresh, never redirects', async () => {
    const provider = envAuthProvider(CONFIG)
    expect(provider.redirectUrl).toBeTruthy()
    expect(await provider.clientInformation()).toEqual({ client_id: 'synthetic-client' })
    expect(await provider.tokens()).toMatchObject({ refresh_token: 'synthetic-refresh' })
    await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' })
    expect(await provider.tokens()).toMatchObject({
      access_token: 'a1',
      refresh_token: 'synthetic-refresh',
    })
    await provider.saveTokens({ access_token: 'a2', token_type: 'Bearer', refresh_token: 'r2' })
    expect(await provider.tokens()).toMatchObject({ access_token: 'a2', refresh_token: 'r2' })
    expect(() => provider.redirectToAuthorization(new URL('https://example.test'))).toThrow()
  })
})

describe('source scan: the credentials stay server-side', () => {
  // MUTATION: read LENNYS_DATA_MCP_REFRESH_TOKEN from a non-.server module.
  it('the credential env names appear only in server modules and scripts', async () => {
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const SRC = resolve(process.cwd(), 'src')
    async function filesUnder(dir: string): Promise<string[]> {
      const out: string[] = []
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...(await filesUnder(full)))
        else out.push(full)
      }
      return out
    }
    const files = await filesUnder(SRC)
    expect(files.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const path of files) {
      if (path.endsWith('.server.ts') || path.endsWith('.test.ts')) continue
      const source = await readFile(path, 'utf8')
      if (/LENNYS_DATA_MCP_(CLIENT_ID|REFRESH_TOKEN)/.test(source)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})

describe('the per-user allowlist (owner ruling: personal use by the subscriber only)', () => {
  // MUTATION: return the config when LENNYS_DATA_MCP_USERS is empty.
  it('an unset or empty list is off for everyone, even with the switch on and credentials', () => {
    expect(lennysDataConfig(ON)).toBeNull()
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_USERS: ' , ' })).toBeNull()
  })

  // MUTATION: drop the `userAllowed()` check from listTools (the other user is
  // then offered the tools), or stop lower-casing the request email.
  it('a listed user is offered the tools; any other user is offered nothing', async () => {
    const owner = createLennysDataTransport(CONFIG, async () => ' SUBSCRIBER@example.COM')
    expect((await owner.listTools()).map((t) => t.name)).toEqual([
      'lennys_search',
      'lennys_get_post',
    ])

    for (const other of [
      async () => 'colleague@example.com',
      async () => null,
      async () => {
        throw new Error('lookup failed')
      },
    ]) {
      mcp.clients = 0
      expect(await createLennysDataTransport(CONFIG, other).listTools()).toEqual([])
      expect(mcp.clients).toBe(0)
    }
  })

  // MUTATION: drop the `userAllowed()` check from callTool.
  it('a call is refused at call time for a user who is not listed, before any request', async () => {
    let email: string | null = OWNER
    const transport = createLennysDataTransport(CONFIG, async () => email)
    await transport.listTools()
    email = 'colleague@example.com'
    mcp.clients = 0
    expect(await transport.callTool('lennys_search', { query: 'synthetic' })).toMatchObject({
      success: false,
    })
    expect(mcp.clients).toBe(0)
    expect(mcp.called).toEqual([])
  })

  // MUTATION: resolve the request user by `displayName` instead of `email`, or
  // admit a domain entry (`@example.com`) as a suffix match.
  it('the default resolver reads the request user’s verified email; a display name or a domain never counts', async () => {
    identity.userId = 'synthetic-oid'
    identity.user = { email: 'colleague@example.com', displayName: OWNER }
    expect(await createLennysDataTransport(CONFIG).listTools()).toEqual([])

    const domain = { ...CONFIG, users: new Set(['@example.com']) }
    expect(await createLennysDataTransport(domain).listTools()).toEqual([])

    identity.user = { email: OWNER, displayName: 'Synthetic Person' }
    expect(await createLennysDataTransport(CONFIG).listTools()).toHaveLength(2)

    identity.userId = null
    expect(await createLennysDataTransport(CONFIG).listTools()).toEqual([])
    identity.userId = 'synthetic-oid'
    identity.lookupFails = true
    expect(await createLennysDataTransport(CONFIG).listTools()).toEqual([])
  })
})

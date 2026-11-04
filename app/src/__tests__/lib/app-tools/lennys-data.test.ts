// @vitest-environment node
/** Lenny's Data hosted transport. The REAL MCP SDK runs — client, streamable
 * HTTP transport and OAuth `auth()` — against a fake `fetch`; the global fetch
 * is stubbed to throw, so no request can leave. Every identity is synthetic. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { inferServer } from '@hames-ai/harness-patterns'
import {
  LENNYS_NAMESPACE,
  LENNYS_TOOL_PREFIX,
  mcpNamespace,
} from '@hames-ai/connectors/mcp-catalog'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

// The default per-user resolver's two inputs: the request scope's user id and
// that user's stored row.
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

import {
  classifyFailure,
  createLennysDataTransport,
  createTokenManager,
  LENNYS_FAILURES,
  lennysDataConfig,
  parsePinnedTools,
  pinnedArguments,
  pinnedSchema,
} from '../../../lib/app-tools/lennys-data.server'

const SENTINEL = 'SERVER-TEXT-SENTINEL'
const OWNER = 'subscriber@example.com'
const CONFIG = {
  clientId: 'synthetic-client',
  refreshToken: 'r0',
  users: new Set([OWNER]),
  tools: parsePinnedTools('search(query,kind=newsletter|podcast|interview),get_post(id)'),
}
const asOwner = async (): Promise<string | null> => OWNER
const ON = {
  LENNYS_DATA_MCP: 'on',
  LENNYS_DATA_MCP_CLIENT_ID: 'c',
  LENNYS_DATA_MCP_REFRESH_TOKEN: 'r',
  LENNYS_DATA_MCP_USERS: OWNER,
  LENNYS_DATA_MCP_TOOLS: 'search(query)',
}

/** A fake of the provider's two hosts: the OAuth metadata + token endpoint,
 *  and a JSON-answering streamable-HTTP MCP endpoint that checks the bearer. */
function fakeServer() {
  const state = {
    requests: 0,
    tokenBodies: [] as URLSearchParams[],
    bearers: [] as string[],
    calls: [] as { name: string; arguments: unknown }[],
    issued: 0,
    rotate: false,
    expiresIn: 3600 as number | undefined,
    tokenGate: null as Promise<void> | null,
    tokenStatus: 200,
    revoked: new Set<string>(),
    mcpStatus: 200,
    tools: [
      {
        name: 'search',
        description: `Search the archive. ${SENTINEL}`,
        inputSchema: {
          type: 'object',
          description: SENTINEL,
          properties: {
            query: { type: 'string', description: SENTINEL },
            kind: {
              type: 'string',
              enum: ['newsletter', 'podcast', 'server_chosen', `${SENTINEL} with spaces`],
            },
            server_extra: { type: 'string', description: SENTINEL },
            'bad key!': { type: 'string' },
          },
          required: ['query', 'server_extra', 'bad key!'],
        },
      },
      { name: 'get_post', inputSchema: { type: 'object' } },
      { name: 'surprise_tool', description: SENTINEL, inputSchema: { type: 'object' } },
    ],
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  const valid = new Set<string>()
  const fetchFn: FetchLike = async (input, init) => {
    state.requests++
    const url = new URL(String(input))
    if (url.pathname.includes('oauth-protected-resource')) {
      return json({
        resource: 'https://mcp.lennysdata.com/mcp',
        authorization_servers: ['https://auth.example.test/'],
        scopes_supported: ['mcp:read'],
        bearer_methods_supported: ['header'],
      })
    }
    if (url.pathname.includes('oauth-authorization-server')) {
      return json({
        issuer: 'https://auth.example.test/',
        authorization_endpoint: 'https://auth.example.test/oauth/authorize',
        token_endpoint: 'https://auth.example.test/api/oauth/token',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url.pathname === '/api/oauth/token') {
      const body = new URLSearchParams(String(init?.body ?? ''))
      state.tokenBodies.push(body)
      if (state.tokenGate) await state.tokenGate
      if (state.tokenStatus !== 200) {
        return json({ error: 'invalid_grant', error_description: SENTINEL }, state.tokenStatus)
      }
      state.issued++
      const access = `a${state.issued}`
      valid.add(access)
      return json({
        access_token: access,
        token_type: 'Bearer',
        ...(state.expiresIn !== undefined ? { expires_in: state.expiresIn } : {}),
        ...(state.rotate ? { refresh_token: `r${state.issued}` } : {}),
      })
    }
    if (url.hostname === 'mcp.lennysdata.com' && url.pathname === '/mcp') {
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      if (init?.method === 'DELETE') return new Response(null, { status: 200 })
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '')
      state.bearers.push(token)
      if (!valid.has(token) || state.revoked.has(token)) {
        return json({ error: 'invalid_token' }, 401, {
          'www-authenticate': 'Bearer error="invalid_token"',
        })
      }
      if (state.mcpStatus !== 200) return new Response(SENTINEL, { status: state.mcpStatus })
      const msg = JSON.parse(String(init?.body)) as {
        id?: number
        method: string
        params?: { protocolVersion?: string; name?: string; arguments?: unknown }
      }
      if (msg.id === undefined) return new Response(null, { status: 202 })
      let result: unknown = {}
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '0' },
        }
      } else if (msg.method === 'tools/list') {
        result = { tools: state.tools }
      } else if (msg.method === 'tools/call') {
        state.calls.push({ name: msg.params!.name!, arguments: msg.params!.arguments })
        result = { content: [{ type: 'text', text: 'synthetic archive result' }] }
      }
      return json({ jsonrpc: '2.0', id: msg.id, result })
    }
    return new Response('not found', { status: 404 })
  }
  return { state, fetchFn }
}

let server: ReturnType<typeof fakeServer>
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  identity.userId = null
  identity.user = null
  identity.lookupFails = false
  server = fakeServer()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', () => {
    throw new Error('no network in this test')
  })
})
afterEach(() => {
  warn.mockRestore()
  vi.unstubAllGlobals()
})

const transportAsOwner = (config = CONFIG) =>
  createLennysDataTransport(config, asOwner, server.fetchFn)

describe('the LENNYS_DATA_MCP switch (default OFF)', () => {
  // MUTATION: default `env.LENNYS_DATA_MCP ?? 'on'`: the unset case returns a
  // config (and, unconfigured, throws), so this goes red.
  it('unset and off are off; nothing is discovered and no request is ever made', async () => {
    expect(lennysDataConfig({})).toBeNull()
    expect(lennysDataConfig({ LENNYS_DATA_MCP: 'off' })).toBeNull()
    const transport = createLennysDataTransport(lennysDataConfig({}), asOwner, server.fetchFn)
    expect(await transport.listTools()).toEqual([])
    expect(transport.ownsTool(`${LENNYS_TOOL_PREFIX}search`)).toBe(false)
    expect(await transport.callTool(`${LENNYS_TOOL_PREFIX}search`, { query: 'x' })).toMatchObject({
      success: false,
    })
    expect(server.state.requests).toBe(0)
  })

  // MUTATION: drop the credential check: `on` alone returns a config.
  it('refuses boot on an unknown value or on `on` without both credentials', () => {
    expect(() => lennysDataConfig({ LENNYS_DATA_MCP: 'yes' })).toThrow(/on or off/)
    expect(() => lennysDataConfig({ LENNYS_DATA_MCP: 'on' })).toThrow(/CLIENT_ID/)
    expect(() =>
      lennysDataConfig({ LENNYS_DATA_MCP: 'on', LENNYS_DATA_MCP_CLIENT_ID: 'c' }),
    ).toThrow(/REFRESH_TOKEN/)
    expect(
      lennysDataConfig({
        ...ON,
        LENNYS_DATA_MCP_USERS: ' Subscriber@Example.com ,',
        LENNYS_DATA_MCP_TOOLS: ' search( query , kind = a|b ) , get_post(id),',
      }),
    ).toEqual({
      clientId: 'c',
      refreshToken: 'r',
      users: new Set([OWNER]),
      tools: new Map([
        [
          'search',
          new Map<string, Set<string> | null>([
            ['query', null],
            ['kind', new Set(['a', 'b'])],
          ]),
        ],
        ['get_post', new Map([['id', null]])],
      ]),
    })
  })

  // MUTATION: return the config when LENNYS_DATA_MCP_TOOLS is empty.
  it('no pinned tool is off for everyone, even with the switch on and credentials', () => {
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_TOOLS: undefined })).toBeNull()
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_TOOLS: ' , ' })).toBeNull()
  })
})

describe('names, namespace and what the server may say', () => {
  // MUTATION: drop the prefix in discovery (expose `search` as-is): the remote
  // tool would own the gateway's `search`, and this goes red.
  it('exposes pinned remote tools prefixed, so none can own a gateway name', async () => {
    const transport = transportAsOwner()
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).toEqual(['lennys_search', 'lennys_get_post'])
    expect(transport.ownsTool('search')).toBe(false)
    expect(transport.ownsTool('lennys_search')).toBe(true)
    expect(transport.namespaceFor?.('lennys_search')).toBe('lennys')
    expect(transport.namespaceFor?.('search')).toBeUndefined()
  })

  // SHOULD 5. MUTATION: drop the pinned-name filter in discovery, or make
  // `ownsTool` prefix-only, or forward the server's description or schema.
  it('only pinned names are offered or callable; server text never reaches the listing', async () => {
    const transport = transportAsOwner()
    const tools = await transport.listTools()
    expect(tools.map((t) => t.name)).not.toContain('lennys_surprise_tool')
    expect(transport.ownsTool('lennys_surprise_tool')).toBe(false)
    expect(await transport.callTool('lennys_surprise_tool', {})).toMatchObject({ success: false })
    expect(server.state.calls).toEqual([])
    expect(JSON.stringify(tools)).not.toContain(SENTINEL)
    // Only pinned argument names, only pinned enum values: `server_extra` and
    // `server_chosen` are the server's and never appear; `interview` is the
    // operator's and does.
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['newsletter', 'podcast', 'interview'] },
      },
      required: ['query'],
    })
    expect(tools[0].description).toMatch(/^Lenny's Data archive tool "search"/)
  })

  // D3. MUTATION: copy the server's enum values or nested property names into
  // the schema, or emit server-declared arguments that are not pinned.
  it('pinnedSchema copies only types from the server; names and values come from the pin', () => {
    const args = parsePinnedTools('t(tags=a|b,count=1|2,filter,labels,rows,missing)').get('t')!
    expect(
      pinnedSchema(
        {
          properties: {
            tags: { type: 'array', items: { type: 'string', enum: ['server'] } },
            count: { type: 'integer', enum: [99] },
            filter: { type: 'object', properties: { server_named: { type: 'string' } } },
            labels: { type: 'array', items: { type: 'string', enum: ['server'] } },
            rows: { type: 'array', items: { type: 'object', properties: { server_named: {} } } },
            unpinned: { type: 'string' },
          },
          required: ['filter', 'unpinned'],
        },
        args,
      ),
    ).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        count: { type: 'integer', enum: [1, 2] },
        filter: { type: 'object' },
        labels: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array' },
      },
      required: ['filter'],
    })
    expect(pinnedSchema('not a schema', args)).toEqual({ type: 'object', properties: {} })
  })

  // MUTATION: accept a bare name, a duplicate, or a value outside ENUM_VALUE.
  it.each([
    'search',
    'search(',
    'search(query))',
    'search(query=)',
    'search(a=b=c)',
    'bad name(x)',
    'search(q),search(q)',
    'search(q,q)',
    'search(q=has space)',
  ])('a malformed pin refuses boot: %s', (spec) => {
    expect(() => parsePinnedTools(spec)).toThrow(/malformed/)
  })

  it('pinnedArguments keeps pinned names and refuses an unpinned value', () => {
    const args = parsePinnedTools('t(q,kind=a|b,tags=x|y)').get('t')!
    expect(pinnedArguments({ q: 'free', kind: 'a', other: 'dropped' }, args)).toEqual({
      q: 'free',
      kind: 'a',
    })
    expect(pinnedArguments({ kind: 'c' }, args)).toBeNull()
    expect(pinnedArguments({ tags: ['x', 'y'] }, args)).toEqual({ tags: ['x', 'y'] })
    expect(pinnedArguments({ tags: ['x', 'z'] }, args)).toBeNull()
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
  // MUTATION: forward `name` unstripped.
  it('strips the prefix on the way out and sends exactly the arguments', async () => {
    const transport = transportAsOwner()
    expect(await transport.callTool('lennys_search', { query: 'synthetic' })).toEqual({
      success: true,
      data: 'synthetic archive result',
    })
    expect(server.state.calls).toEqual([{ name: 'search', arguments: { query: 'synthetic' } }])
  })

  // D3. MUTATION: forward `args` instead of the pinned arguments, or skip the
  // enum check.
  it('sends only pinned arguments, and refuses a value outside a pinned enum before any request', async () => {
    const transport = transportAsOwner()
    await transport.callTool('lennys_search', { query: 'q', kind: 'podcast', server_extra: 'x' })
    expect(server.state.calls).toEqual([
      { name: 'search', arguments: { query: 'q', kind: 'podcast' } },
    ])
    const before = server.state.requests
    expect(
      await transport.callTool('lennys_search', { query: 'q', kind: 'server_chosen' }),
    ).toEqual({ success: false, data: null, error: "Lenny's Data argument value not allowed" })
    expect(server.state.requests).toBe(before)
  })

  // MUTATION: return `String(err)` from classifyFailure.
  it.each([
    [new UnauthorizedError(SENTINEL), LENNYS_FAILURES.signIn],
    [new InvalidGrantError(SENTINEL), LENNYS_FAILURES.signIn],
    [Object.assign(new Error(SENTINEL), { code: 401 }), LENNYS_FAILURES.signIn],
    [Object.assign(new Error(SENTINEL), { code: 429 }), LENNYS_FAILURES.rateLimit],
    [Object.assign(new Error(SENTINEL), { code: -32001 }), LENNYS_FAILURES.timeout],
    [new Error(SENTINEL), LENNYS_FAILURES.unavailable],
  ])('classifies a failure into a fixed message (%#)', (err, message) => {
    expect(classifyFailure(err)).toBe(message)
  })

  it.each([
    [
      'a 429 from the server',
      (): void => void (server.state.mcpStatus = 429),
      LENNYS_FAILURES.rateLimit,
    ],
    [
      'a 500 from the server',
      (): void => void (server.state.mcpStatus = 500),
      LENNYS_FAILURES.unavailable,
    ],
    [
      'a refused refresh',
      (): void => void (server.state.tokenStatus = 400),
      LENNYS_FAILURES.signIn,
    ],
  ])('%s fails with a fixed message and no server text', async (_label, arrange, message) => {
    arrange()
    const result = await transportAsOwner().callTool('lennys_search', { query: 'synthetic' })
    expect(result).toEqual({ success: false, data: null, error: message })
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  })
})

// SHOULD 6: the real SDK refresh path, against a fake token endpoint.
describe('the refresh path (real SDK auth)', () => {
  // MUTATION: drop `redirectUrl` from the env provider: the SDK then runs a
  // client-credentials grant instead of the refresh.
  it('the first call refreshes with the env refresh token, never client credentials or a redirect', async () => {
    await transportAsOwner().callTool('lennys_search', { query: 'synthetic' })
    expect(server.state.tokenBodies).toHaveLength(1)
    const body = server.state.tokenBodies[0]
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('r0')
    expect(body.get('client_id')).toBe('synthetic-client')
    expect(server.state.bearers.every((b) => b === 'a1')).toBe(true)
  })

  // MUTATION: drop the `inFlight ??=` sharing (refresh per caller): two token
  // requests are made with the same refresh token.
  it('concurrent calls share ONE refresh (MUST 2)', async () => {
    let open!: () => void
    server.state.tokenGate = new Promise<void>((r) => (open = r))
    const transport = transportAsOwner()
    const calls = Promise.all([
      transport.callTool('lennys_search', { query: 'one' }),
      transport.callTool('lennys_get_post', { id: 'two' }),
      transport.listTools(),
    ])
    await vi.waitFor(() => expect(server.state.tokenBodies.length).toBeGreaterThan(0))
    // Give a second, unshared refresh every chance to reach the endpoint.
    await new Promise((r) => setTimeout(r, 50))
    open()
    const [one, two] = await calls
    expect(one).toMatchObject({ success: true })
    expect(two).toMatchObject({ success: true })
    expect(server.state.tokenBodies).toHaveLength(1)
  })

  // MUTATION: let saveTokens drop a rotated refresh token (keep the env one):
  // the second refresh then sends r0 again.
  it('a rotated refresh token is used next, and the rotation is logged once without a value', async () => {
    server.state.rotate = true
    server.state.expiresIn = 0 // every call refreshes
    const transport = transportAsOwner()
    await transport.callTool('lennys_search', { query: 'one' })
    await transport.callTool('lennys_search', { query: 'two' })
    await transport.callTool('lennys_search', { query: 'three' })
    expect(server.state.tokenBodies.map((b) => b.get('refresh_token'))).toEqual(['r0', 'r1', 'r2'])
    const logged = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('rotated'))
    expect(logged).toHaveLength(1)
    expect(String(logged[0][0])).not.toMatch(/\b[ar][0-9]\b/)
  })

  // MUTATION: drop the one-retry branch on a 401 in withClient.
  it('a revoked access token is refreshed and the call retried once', async () => {
    const transport = transportAsOwner()
    await transport.callTool('lennys_search', { query: 'one' })
    server.state.revoked.add('a1')
    expect(await transport.callTool('lennys_search', { query: 'two' })).toMatchObject({
      success: true,
    })
    expect(server.state.tokenBodies).toHaveLength(2)
  })

  it('the token manager reuses a live token without a request', async () => {
    const tokens = createTokenManager(CONFIG, server.fetchFn)
    expect(await tokens.accessToken()).toBe('a1')
    const before = server.state.requests
    expect(await tokens.accessToken()).toBe('a1')
    expect(server.state.requests).toBe(before)
  })
})

describe('the per-user allowlist (owner ruling: personal use by the subscriber only)', () => {
  // MUTATION: return the config when LENNYS_DATA_MCP_USERS is empty.
  it('an unset or empty list is off for everyone, even with the switch on and credentials', () => {
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_USERS: undefined })).toBeNull()
    expect(lennysDataConfig({ ...ON, LENNYS_DATA_MCP_USERS: ' , ' })).toBeNull()
  })

  // MUTATION: drop the `userAllowed()` check from listTools (the other user is
  // then offered the tools), or stop lower-casing the request email.
  it('a listed user is offered the tools; any other user is offered nothing', async () => {
    const owner = createLennysDataTransport(
      CONFIG,
      async () => ' SUBSCRIBER@example.COM',
      server.fetchFn,
    )
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
      server = fakeServer()
      expect(await createLennysDataTransport(CONFIG, other, server.fetchFn).listTools()).toEqual([])
      expect(server.state.requests).toBe(0)
    }
  })

  // MUTATION: drop the `userAllowed()` check from callTool.
  it('a call is refused at call time for a user who is not listed, before any request', async () => {
    let email: string | null = OWNER
    const transport = createLennysDataTransport(CONFIG, async () => email, server.fetchFn)
    await transport.listTools()
    email = 'colleague@example.com'
    const before = server.state.requests
    expect(await transport.callTool('lennys_search', { query: 'synthetic' })).toMatchObject({
      success: false,
    })
    expect(server.state.requests).toBe(before)
    expect(server.state.calls).toEqual([])
  })

  // MUTATION: resolve the request user by `displayName` instead of `email`, or
  // admit a domain entry (`@example.com`) as a suffix match.
  it('the default resolver reads the request user’s verified email; a display name or a domain never counts', async () => {
    const make = (config = CONFIG) => createLennysDataTransport(config, undefined, server.fetchFn)
    identity.userId = 'synthetic-oid'
    identity.user = { email: 'colleague@example.com', displayName: OWNER }
    expect(await make().listTools()).toEqual([])

    expect(await make({ ...CONFIG, users: new Set(['@example.com']) }).listTools()).toEqual([])

    identity.user = { email: OWNER, displayName: 'Synthetic Person' }
    expect(await make().listTools()).toHaveLength(2)

    identity.userId = null
    expect(await make().listTools()).toEqual([])
    identity.userId = 'synthetic-oid'
    identity.lookupFails = true
    expect(await make().listTools()).toEqual([])
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
  }, 20_000)
})

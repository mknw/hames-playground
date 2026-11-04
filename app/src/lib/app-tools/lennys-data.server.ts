/** Lenny's Data hosted MCP (product-management newsletter and podcast archive),
 * registered as a process transport beside Exa's. Off unless the operator sets
 * `LENNYS_DATA_MCP=on`.
 *
 * What leaves the box: every call sends its tool arguments — the model-written
 * query text — to the third party at `LENNYS_MCP_URL`, under the operator's own
 * subscriber sign-in. The shared callTool chokepoint applies the egress gate
 * before and the injection guard after this transport, like every other one;
 * nothing here is a substitute for either.
 *
 * Auth is OAuth 2.1 with a public client (dynamic registration, PKCE). The app
 * cannot sign in by itself — sign-in is an email link — so the operator signs in
 * once with `scripts/lennys-data-sign-in.ts` and puts the client id and refresh
 * token it prints into the server environment. The access token lives in memory
 * only. ONE refresh is in flight at a time, shared by every concurrent call
 * (`createTokenManager`): two calls that each refreshed with the same refresh
 * token would, on a server that rotates refresh tokens, revoke the family or
 * keep a superseded token. The SDK transport is therefore given a bearer header,
 * never an auth provider of its own. When the refresh is refused, the call fails
 * with a fixed message naming the sign-in script; nothing starts an interactive
 * flow or logs SDK detail. A rotated refresh token is kept in memory and logged
 * once, without its value, because the env copy is then stale.
 *
 * Remote tool names are exposed with `LENNYS_TOOL_PREFIX`, and the prefix is
 * stripped again on the way out: an unprefixed remote name such as `search`
 * would otherwise take over the gateway's tool of the same name, because a
 * process transport is consulted before the gateway (`tool-transport.server.ts`).
 * Only the names the operator pinned in `LENNYS_DATA_MCP_TOOLS` (as the sign-in
 * script printed them) are ever offered, so the server cannot add or rename a
 * tool into the prompt. What the server says about a tool is not used verbatim:
 * the description is a fixed line, and the input schema keeps only its structure.
 *
 * Per-user gate (owner ruling, 2026-11-04: personal use by the subscriber only).
 * Besides the switch, the signed-in user's verified email (the Entra claim the
 * sign-in allow-list checks, stored on `users.email`) must be on
 * `LENNYS_DATA_MCP_USERS`, matched exactly and case-insensitively; display names
 * never count. Checked per request, at discovery and at call time: a user who is
 * not listed is offered no tool, so the agent never mentions the namespace, and a
 * call is refused. A routine or triggered run is checked as its owning user,
 * because that is whose id its request scope carries. An empty or unset list is
 * off for everyone, even with the switch on.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { LENNYS_NAMESPACE, LENNYS_TOOL_PREFIX } from '@hames-ai/connectors/mcp-catalog'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ToolTransport } from '@hames-ai/harness-patterns/tool-transport.server'
import type { MCPToolDescription, ToolCallResult } from '@hames-ai/harness-patterns/types'
import { getUser } from '../auth/users.server'
import { getRequestUserId } from '../harness-client/request-user.server'

assertServerOnImport()

export const LENNYS_MCP_URL = 'https://mcp.lennysdata.com/mcp'

/** Fixed failure names. SDK errors can carry provider response text and
 *  request metadata from the authenticated connection, so none is echoed. */
export const LENNYS_FAILURES = {
  signIn:
    "Lenny's Data sign-in expired or was refused; re-run scripts/lennys-data-sign-in.ts and update the server environment",
  timeout: "Lenny's Data request timed out",
  rateLimit: "Lenny's Data rate limit reached (HTTP 429)",
  unavailable: "Lenny's Data request unavailable",
} as const

export function classifyFailure(err: unknown): string {
  // A refused refresh surfaces as an OAuthError subclass (invalid_grant…).
  if (
    err instanceof UnauthorizedError ||
    err instanceof SignInRequired ||
    err instanceof OAuthError
  ) {
    return LENNYS_FAILURES.signIn
  }
  const code = errorCode(err)
  if (code === 401 || code === 403) return LENNYS_FAILURES.signIn
  if (code === ErrorCode.RequestTimeout) return LENNYS_FAILURES.timeout
  if (code === 429) return LENNYS_FAILURES.rateLimit
  return LENNYS_FAILURES.unavailable
}

class SignInRequired extends Error {}

/** The numeric `code` the SDK's errors carry (McpError, StreamableHTTPError). */
function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err
    ? (err as { code: unknown }).code
    : undefined
}

export interface LennysDataConfig {
  readonly clientId: string
  readonly refreshToken: string
  /** Normalised (trimmed, lower-cased) emails; never empty. */
  readonly users: ReadonlySet<string>
  /** Remote tool names (unprefixed) the operator pinned; never empty. */
  readonly tools: ReadonlySet<string>
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase()
const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/** The developer switch. Default OFF: nothing is discovered or sent unless the
 *  operator turns it on. `on` without both credentials, or any other value,
 *  refuses boot rather than offering a tool that fails every call. `on` with no
 *  listed user or no pinned tool is off for everyone, with a boot warning. */
export function lennysDataConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LennysDataConfig | null {
  const value = env.LENNYS_DATA_MCP ?? 'off'
  if (value === 'off') return null
  if (value !== 'on') throw new Error('LENNYS_DATA_MCP must be on or off')
  const clientId = env.LENNYS_DATA_MCP_CLIENT_ID
  const refreshToken = env.LENNYS_DATA_MCP_REFRESH_TOKEN
  if (!clientId || !refreshToken) {
    throw new Error(
      'LENNYS_DATA_MCP=on needs LENNYS_DATA_MCP_CLIENT_ID and LENNYS_DATA_MCP_REFRESH_TOKEN ' +
        '(run scripts/lennys-data-sign-in.ts)',
    )
  }
  const users = new Set(list(env.LENNYS_DATA_MCP_USERS).map(normaliseEmail))
  if (!users.size) {
    console.warn("[lennys-data] LENNYS_DATA_MCP_USERS is empty; Lenny's Data is off for every user")
    return null
  }
  const tools = new Set(list(env.LENNYS_DATA_MCP_TOOLS))
  if (!tools.size) {
    console.warn("[lennys-data] LENNYS_DATA_MCP_TOOLS is empty; Lenny's Data offers no tool")
    return null
  }
  return { clientId, refreshToken, users, tools }
}

/** The request user's verified email, or null outside a request or for a user
 *  with no row. Never a display name. */
async function requestUserEmail(): Promise<string | null> {
  const id = getRequestUserId()
  if (!id) return null
  return (await getUser(id))?.email ?? null
}

/** A non-interactive OAuth provider over the operator's env credentials, for
 *  the SDK's `auth()` refresh. The access token starts empty; a rotated refresh
 *  token is kept for the life of the process and reported once via `onRotate`. */
export function envAuthProvider(
  config: Pick<LennysDataConfig, 'clientId' | 'refreshToken'>,
  onRotate: () => void = () => {},
): OAuthClientProvider {
  let tokens: OAuthTokens = {
    access_token: '',
    token_type: 'Bearer',
    refresh_token: config.refreshToken,
  }
  // Never visited at runtime: a redirect means the refresh failed, and the
  // provider refuses it below. It must be set, because the SDK reads a missing
  // redirect URL as a client-credentials client.
  const redirectUrl = 'http://127.0.0.1/lennys-data/unused'
  return {
    redirectUrl,
    clientMetadata: {
      client_name: 'hames',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientInformation: () => ({ client_id: config.clientId }),
    tokens: () => tokens,
    saveTokens: (next) => {
      if (next.refresh_token && next.refresh_token !== tokens.refresh_token) onRotate()
      tokens = { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token }
    },
    redirectToAuthorization: () => {
      throw new SignInRequired()
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => {
      throw new SignInRequired()
    },
  }
}

/** Refresh slack: a token this close to its stated expiry is refreshed first. */
const EXPIRY_SLACK_MS = 60_000

export interface TokenManager {
  /** A usable access token, refreshing when there is none or it is expiring.
   *  Concurrent callers share ONE in-flight refresh. */
  accessToken(): Promise<string>
  /** Drop `stale` after the server refused it, unless a newer token already
   *  replaced it (a concurrent call refreshed first). */
  invalidate(stale: string): void
}

export function createTokenManager(
  config: Pick<LennysDataConfig, 'clientId' | 'refreshToken'>,
  fetchFn?: FetchLike,
): TokenManager {
  let rotationLogged = false
  const provider = envAuthProvider(config, () => {
    if (rotationLogged) return
    rotationLogged = true
    console.warn(
      '[lennys-data] the refresh token rotated; the env value is now stale, so a restart needs a fresh sign-in',
    )
  })
  let access = ''
  let expiresAt = Infinity
  let inFlight: Promise<string> | null = null

  function refresh(): Promise<string> {
    inFlight ??= (async () => {
      const result = await auth(provider, { serverUrl: LENNYS_MCP_URL, fetchFn })
      if (result !== 'AUTHORIZED') throw new SignInRequired()
      const tokens = await provider.tokens()
      if (!tokens?.access_token) throw new SignInRequired()
      access = tokens.access_token
      expiresAt =
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : Infinity
      return access
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    accessToken: () => {
      if (inFlight) return inFlight
      if (access && Date.now() < expiresAt - EXPIRY_SLACK_MS) return Promise.resolve(access)
      return refresh()
    },
    invalidate: (stale) => {
      if (access === stale) access = ''
    },
  }
}

/** JSON-schema keywords kept from a server-supplied input schema. Free-text
 *  keywords (description, title, examples, default, …) are dropped: they are
 *  model-visible and the injection guard never reads them. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array'])

export function structuralSchema(schema: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof schema !== 'object' || schema === null || depth > 3) return out
  const src = schema as Record<string, unknown>
  if (typeof src.type === 'string' && SCHEMA_TYPES.has(src.type)) out.type = src.type
  if (Array.isArray(src.enum)) {
    const values = src.enum.filter(
      (v) => typeof v === 'number' || (typeof v === 'string' && IDENTIFIER.test(v)),
    )
    if (values.length) out.enum = values
  }
  if (src.items !== undefined) out.items = structuralSchema(src.items, depth + 1)
  if (typeof src.properties === 'object' && src.properties !== null) {
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(src.properties)) {
      if (IDENTIFIER.test(key)) properties[key] = structuralSchema(value, depth + 1)
    }
    out.properties = properties
    if (Array.isArray(src.required)) {
      out.required = src.required.filter(
        (k): k is string => typeof k === 'string' && k in properties,
      )
    }
  }
  return out
}

const fixedDescription = (remote: string): string =>
  `Lenny's Data archive tool "${remote}": a third-party product-management newsletter and podcast archive. Arguments follow the schema.`

/** How long a failed discovery waits before the next attempt. */
const DISCOVERY_RETRY_MS = 30_000

export function createLennysDataTransport(
  config: LennysDataConfig | null = lennysDataConfig(),
  userEmail: () => Promise<string | null> = requestUserEmail,
  fetchFn?: FetchLike,
): ToolTransport {
  const tokens = config ? createTokenManager(config, fetchFn) : null
  /** Fail closed: no config, no user, an unlisted email or a failed lookup. */
  async function userAllowed(): Promise<boolean> {
    if (!config) return false
    try {
      const email = await userEmail()
      return email !== null && config.users.has(normaliseEmail(email))
    } catch {
      return false
    }
  }
  const pinned = (name: string): boolean =>
    config !== null &&
    name.startsWith(LENNYS_TOOL_PREFIX) &&
    config.tools.has(name.slice(LENNYS_TOOL_PREFIX.length))

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await tokens!.accessToken()
      const client = new Client({ name: 'hames-lennys-data', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(LENNYS_MCP_URL), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            ...(fetchFn ? { fetch: fetchFn } : {}),
          }),
        )
        return await run(client)
      } catch (err) {
        // One retry after the server refused the token (revoked or clock skew);
        // the retry goes through the same shared refresh.
        if (attempt === 0 && errorCode(err) === 401) {
          tokens!.invalidate(token)
          continue
        }
        throw err
      } finally {
        try {
          await client.close()
        } catch {
          // Best effort after a failed request; never expose SDK error details.
        }
      }
    }
  }

  // The sanitised listing, kept once discovery succeeds (the pinned names and
  // structural schemas do not depend on who asks), so a re-read is cheap.
  let listing: MCPToolDescription[] | null = null
  let lastFailure = -Infinity
  async function discover(): Promise<MCPToolDescription[]> {
    if (listing) return listing
    if (Date.now() - lastFailure < DISCOVERY_RETRY_MS) {
      throw new Error(`Lenny's Data tool discovery failed: ${LENNYS_FAILURES.unavailable}`)
    }
    try {
      const { tools } = await withClient((client) => client.listTools())
      listing = tools
        .filter((tool) => config!.tools.has(tool.name))
        .map((tool) => ({
          name: `${LENNYS_TOOL_PREFIX}${tool.name}`,
          description: fixedDescription(tool.name),
          inputSchema: structuralSchema(tool.inputSchema),
        }))
      for (const name of config!.tools) {
        if (!tools.some((tool) => tool.name === name)) {
          console.warn(`[lennys-data] pinned tool ${name} is absent from the server's listing`)
        }
      }
      return listing
    } catch (err) {
      lastFailure = Date.now()
      // The shared catalog logs the transport id. Name the cause, never the SDK text.
      throw new Error(`Lenny's Data tool discovery failed: ${classifyFailure(err)}`)
    }
  }

  return {
    id: 'lennys-data-hosted',
    ownsTool: pinned,
    namespaceFor: (name) => (pinned(name) ? LENNYS_NAMESPACE : undefined),
    listTools: async (): Promise<MCPToolDescription[]> => {
      if (!config || !(await userAllowed())) return []
      return discover()
    },
    callTool: async (name, args): Promise<ToolCallResult> => {
      if (!pinned(name) || !(await userAllowed())) {
        return { success: false, data: null, error: "Lenny's Data tool unavailable" }
      }
      try {
        const remote = name.slice(LENNYS_TOOL_PREFIX.length)
        const result = await withClient((client) =>
          client.callTool({ name: remote, arguments: args }),
        )
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
        return { success: false, data: null, error: classifyFailure(err) }
      }
    },
  }
}

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
 * tool into the prompt. The pin also names each tool's arguments and enum
 * values (`name(arg,arg=v1|v2)`), so the server chooses none of the schema text
 * the model sees: the description is a fixed line, the schema is built from the
 * pin (`pinnedSchema`), and a call sends only pinned arguments with pinned values
 * (`pinnedArguments`).
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
  invalidParams:
    "Lenny's Data rejected the arguments: the server's schema no longer matches the pin; re-pin with scripts/lennys-data-sign-in.ts",
} as const

/** The fixed refusal for a tool whose live schema drifted from its pin. The
 *  name is the operator's pin, never server text. */
export const driftRefusal = (remote: string): string =>
  `Lenny's Data tool "${remote}" no longer matches its pin; re-pin with scripts/lennys-data-sign-in.ts`

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
  if (code === ErrorCode.InvalidParams) return LENNYS_FAILURES.invalidParams
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
  /** The operator's pinned surface (unprefixed remote name → its pinned
   *  arguments → the argument's pinned enum values, or null); never empty. */
  readonly tools: PinnedTools
}

/** Pinned arguments of one tool: name → allowed values, or null for any. */
export type PinnedArgs = ReadonlyMap<string, ReadonlySet<string> | null>
export type PinnedTools = ReadonlyMap<string, PinnedArgs>

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ENUM_VALUE = /^[A-Za-z0-9_.-]{1,40}$/

/**
 * Parse `LENNYS_DATA_MCP_TOOLS`: `name(arg,arg=v1|v2),name2(arg)`, as the
 * sign-in script prints it. Tool names, argument names and enum values are all
 * operator-pinned, so nothing the server says chooses them. A malformed spec
 * refuses boot — a typo must not silently drop a tool or widen one.
 */
export function parsePinnedTools(value: string | undefined): PinnedTools {
  const tools = new Map<string, PinnedArgs>()
  const groups: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value ?? '') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth < 0 || depth > 1) throw new Error('LENNYS_DATA_MCP_TOOLS is malformed')
    if (ch === ',' && depth === 0) {
      groups.push(current)
      current = ''
    } else current += ch
  }
  if (depth !== 0) throw new Error('LENNYS_DATA_MCP_TOOLS is malformed')
  groups.push(current)
  for (const group of groups.map((g) => g.trim()).filter(Boolean)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]{0,63})\(([^()]*)\)$/.exec(group)
    if (!match || tools.has(match[1])) throw new Error('LENNYS_DATA_MCP_TOOLS is malformed')
    const args = new Map<string, ReadonlySet<string> | null>()
    for (const arg of match[2]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)) {
      const [name, values, ...rest] = arg.split('=').map((part) => part.trim())
      const allowed = values === undefined ? null : values.split('|').map((v) => v.trim())
      if (
        rest.length ||
        !IDENTIFIER.test(name) ||
        args.has(name) ||
        (allowed !== null && !allowed.every((v) => ENUM_VALUE.test(v)))
      ) {
        throw new Error('LENNYS_DATA_MCP_TOOLS is malformed')
      }
      args.set(name, allowed && new Set(allowed))
    }
    tools.set(match[1], args)
  }
  return tools
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
  const tools = parsePinnedTools(env.LENNYS_DATA_MCP_TOOLS)
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

/** The input schema the model sees, built from the operator's pin. Only pinned
 *  argument names the server also declares appear, each with the server's
 *  primitive `type` and the PINNED enum values; nothing else of the server's
 *  schema is copied — no description, title or default, no server-chosen enum
 *  value, and no nested property name (an array keeps only its items' type). */
const SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array'])

function typeOnly(schema: unknown): Record<string, unknown> {
  const src = (typeof schema === 'object' && schema !== null ? schema : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, unknown> = {}
  if (typeof src.type === 'string' && SCHEMA_TYPES.has(src.type)) out.type = src.type
  if (out.type === 'array' && typeof src.items === 'object' && src.items !== null) {
    const items = (src.items as Record<string, unknown>).type
    if (typeof items === 'string' && SCHEMA_TYPES.has(items) && items !== 'object') {
      out.items = { type: items }
    }
  }
  return out
}

export function pinnedSchema(server: unknown, args: PinnedArgs): Record<string, unknown> {
  const src = (typeof server === 'object' && server !== null ? server : {}) as Record<
    string,
    unknown
  >
  const declared = (
    typeof src.properties === 'object' && src.properties !== null ? src.properties : {}
  ) as Record<string, unknown>
  const properties: Record<string, unknown> = {}
  for (const [name, values] of args) {
    if (!Object.hasOwn(declared, name)) continue
    const prop = typeOnly(declared[name])
    if (values) {
      const numeric = prop.type === 'number' || prop.type === 'integer'
      const allowed = [...values]
      if (prop.type === 'array') {
        prop.items = { ...(prop.items as object), enum: allowed }
      } else {
        prop.enum = numeric ? allowed.map(Number) : allowed
      }
    }
    properties[name] = prop
  }
  const required = Array.isArray(src.required)
    ? src.required.filter((k): k is string => typeof k === 'string' && k in properties)
    : []
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** The arguments that may leave: pinned names only, and a pinned argument's
 *  value (or each array element) must be one of its pinned values. Null means
 *  refuse the call. */
export function pinnedArguments(
  args: Record<string, unknown>,
  pinnedArgs: PinnedArgs,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args)) {
    if (!pinnedArgs.has(name)) continue
    const allowed = pinnedArgs.get(name)
    if (allowed) {
      const values = Array.isArray(value) ? value : [value]
      if (!values.every((v) => allowed.has(String(v)))) return null
    }
    out[name] = value
  }
  return out
}

/**
 * Whether the server's live schema still matches a tool's pin (PR #986 E1).
 * Drift is a pinned argument the server no longer declares, a server-required
 * argument the pin leaves out, or a pinned enum value outside the server's own
 * enum (when it declares one). Returns a fixed category, never server text, or
 * null when the pin still matches. A drifted tool is withheld: offering it would
 * send a call the server has to reject, and the user would see a generic
 * failure instead of the cause.
 */
export function schemaDrift(server: unknown, args: PinnedArgs): string | null {
  const src = (typeof server === 'object' && server !== null ? server : {}) as Record<
    string,
    unknown
  >
  const declared = (
    typeof src.properties === 'object' && src.properties !== null ? src.properties : {}
  ) as Record<string, Record<string, unknown> | undefined>
  for (const name of args.keys()) {
    if (!Object.hasOwn(declared, name)) return 'a pinned argument is no longer declared'
  }
  const required = Array.isArray(src.required) ? src.required : []
  if (required.some((k) => typeof k === 'string' && !args.has(k))) {
    return 'a required argument is not pinned'
  }
  for (const [name, values] of args) {
    if (!values) continue
    const prop = declared[name] ?? {}
    const items = prop.type === 'array' ? (prop.items as Record<string, unknown> | undefined) : prop
    const serverEnum = Array.isArray(items?.enum) ? items.enum.map(String) : null
    if (serverEnum && [...values].some((v) => !serverEnum.includes(v))) {
      return 'a pinned enum value is outside the server enum'
    }
  }
  return null
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
  // Pinned tools whose live schema drifted from the pin: withheld from the
  // listing, refused at call time, and logged once each.
  const drifted = new Map<string, string>()
  const warned = new Set<string>()
  function warnDrift(remote: string, reason: string): void {
    if (warned.has(remote)) return
    warned.add(remote)
    console.warn(`[lennys-data] withheld ${remote}: ${reason}; re-pin with the sign-in script`)
  }
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
        .filter((tool) => {
          const reason = schemaDrift(tool.inputSchema, config!.tools.get(tool.name)!)
          if (reason) drifted.set(tool.name, reason)
          return reason === null
        })
        .map((tool) => ({
          name: `${LENNYS_TOOL_PREFIX}${tool.name}`,
          description: fixedDescription(tool.name),
          inputSchema: pinnedSchema(tool.inputSchema, config!.tools.get(tool.name)!),
        }))
      for (const [name, reason] of drifted) warnDrift(name, reason)
      for (const name of config!.tools.keys()) {
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
      const remote = name.slice(LENNYS_TOOL_PREFIX.length)
      // The drift verdict needs a discovery; a failed one leaves the call to
      // fail on its own, with its own fixed message.
      await discover().catch(() => null)
      const reason = drifted.get(remote)
      if (reason) {
        warnDrift(remote, reason)
        return { success: false, data: null, error: driftRefusal(remote) }
      }
      const sent = pinnedArguments(args, config!.tools.get(remote)!)
      if (!sent) {
        return { success: false, data: null, error: "Lenny's Data argument value not allowed" }
      }
      try {
        const result = await withClient((client) =>
          client.callTool({ name: remote, arguments: sent }),
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

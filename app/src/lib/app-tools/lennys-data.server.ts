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
 * token it prints into the server environment. This module holds the access
 * token in memory only and lets the MCP SDK refresh it on a 401. When the
 * refresh is refused, the call fails with a fixed message naming the sign-in
 * script; it never starts an interactive flow and never logs SDK detail.
 *
 * Remote tool names are exposed with `LENNYS_TOOL_PREFIX`, and the prefix is
 * stripped again on the way out: an unprefixed remote name such as `search`
 * would otherwise take over the gateway's tool of the same name, because a
 * process transport is consulted before the gateway (`tool-transport.server.ts`).
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
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
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

function classifyFailure(err: unknown): string {
  // A refused refresh surfaces as an OAuthError subclass (invalid_grant…).
  if (
    err instanceof UnauthorizedError ||
    err instanceof SignInRequired ||
    err instanceof OAuthError
  ) {
    return LENNYS_FAILURES.signIn
  }
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code: unknown }).code
      : undefined
  if (code === 401 || code === 403) return LENNYS_FAILURES.signIn
  if (code === ErrorCode.RequestTimeout) return LENNYS_FAILURES.timeout
  if (code === 429) return LENNYS_FAILURES.rateLimit
  return LENNYS_FAILURES.unavailable
}

class SignInRequired extends Error {}

export interface LennysDataConfig {
  readonly clientId: string
  readonly refreshToken: string
  /** Normalised (trimmed, lower-cased) emails; never empty. */
  readonly users: ReadonlySet<string>
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase()

/** The developer switch. Default OFF: nothing is discovered or sent unless the
 *  operator turns it on. `on` without both credentials, or any other value,
 *  refuses boot rather than offering a tool that fails every call. `on` with no
 *  listed user is off for everyone, with a boot warning. */
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
  const users = new Set(
    (env.LENNYS_DATA_MCP_USERS ?? '').split(',').map(normaliseEmail).filter(Boolean),
  )
  if (!users.size) {
    console.warn("[lennys-data] LENNYS_DATA_MCP_USERS is empty; Lenny's Data is off for every user")
    return null
  }
  return { clientId, refreshToken, users }
}

/** The request user's verified email, or null outside a request or for a user
 *  with no row. Never a display name. */
async function requestUserEmail(): Promise<string | null> {
  const id = getRequestUserId()
  if (!id) return null
  return (await getUser(id))?.email ?? null
}

/** A non-interactive OAuth provider over the operator's env credentials. The
 *  access token starts empty, so the first request's 401 is what fetches one;
 *  a rotated refresh token is kept for the life of the process. */
export function envAuthProvider(config: LennysDataConfig): OAuthClientProvider {
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

export function createLennysDataTransport(
  config: LennysDataConfig | null = lennysDataConfig(),
  userEmail: () => Promise<string | null> = requestUserEmail,
): ToolTransport {
  const auth = config ? envAuthProvider(config) : null
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
  // Prefixed names this process discovered; empty until discovery succeeds.
  const discovered = new Set<string>()
  const owns = (name: string): boolean => auth !== null && name.startsWith(LENNYS_TOOL_PREFIX)

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'hames-lennys-data', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(LENNYS_MCP_URL), { authProvider: auth! }),
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
    id: 'lennys-data-hosted',
    ownsTool: owns,
    namespaceFor: (name) => (owns(name) ? LENNYS_NAMESPACE : undefined),
    listTools: async (): Promise<MCPToolDescription[]> => {
      if (!auth || !(await userAllowed())) return []
      try {
        const { tools } = await withClient((client) => client.listTools())
        discovered.clear()
        return tools.map((tool) => {
          const name = `${LENNYS_TOOL_PREFIX}${tool.name}`
          discovered.add(name)
          return {
            name,
            description: `Lenny's Data (third-party product-management archive): ${tool.description ?? ''}`,
            inputSchema: tool.inputSchema,
          }
        })
      } catch (err) {
        // The shared catalog logs the transport id. Name the cause, never the SDK text.
        throw new Error(`Lenny's Data tool discovery failed: ${classifyFailure(err)}`)
      }
    },
    callTool: async (name, args): Promise<ToolCallResult> => {
      if (!auth || !discovered.has(name) || !(await userAllowed())) {
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

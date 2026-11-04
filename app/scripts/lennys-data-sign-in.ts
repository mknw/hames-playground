/**
 * One-time operator sign-in for the Lenny's Data MCP (`LENNYS_DATA_MCP=on`).
 *
 * Lenny's Data authenticates with OAuth 2.1 and an emailed sign-in link, which
 * the app server cannot follow by itself. Run this once, on a machine with a
 * browser, as the subscriber whose access the deployment will use:
 *
 *   pnpm dlx tsx scripts/lennys-data-sign-in.ts      # from app/
 *
 * It registers a public OAuth client (dynamic registration, PKCE), prints a
 * sign-in URL and waits on a loopback callback. It then refreshes ONCE, the way
 * the app will, and reports only whether the refresh token changed — if it did,
 * the server rotates refresh tokens, and the env copy goes stale on the app's
 * first refresh, so a restart would need a fresh sign-in. It prints three lines
 * for the SERVER environment (`app/.env`, or the repo-root `.env` in production),
 * the refresh token being the one it holds AFTER that refresh:
 *
 *   LENNYS_DATA_MCP_CLIENT_ID=...
 *   LENNYS_DATA_MCP_REFRESH_TOKEN=...
 *   LENNYS_DATA_MCP_TOOLS=...       # name(arg,arg=v1|v2),… to pin; review before use
 *
 * The first two are secrets. The script writes nothing to disk, and the tool
 * listing sends no query.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

const SERVER_URL = 'https://mcp.lennysdata.com/mcp'
const PORT = Number(process.env.LENNYS_SIGN_IN_PORT ?? 8976)
const REDIRECT = `http://127.0.0.1:${PORT}/callback`
const WAIT_MS = 15 * 60_000

const state = randomBytes(16).toString('hex')
let client: OAuthClientInformationMixed | undefined
let tokens: OAuthTokens | undefined
let verifier = ''

const provider: OAuthClientProvider = {
  redirectUrl: REDIRECT,
  clientMetadata: {
    client_name: 'hames (self-hosted)',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  state: () => state,
  clientInformation: () => client,
  saveClientInformation: (info) => {
    client = info
  },
  tokens: () => tokens,
  saveTokens: (t) => {
    tokens = t
  },
  redirectToAuthorization: (url) => {
    console.log('\nOpen this URL, enter the subscriber email and follow the emailed link:\n')
    console.log(url.toString(), '\n')
  },
  saveCodeVerifier: (v) => {
    verifier = v
  },
  codeVerifier: () => verifier,
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('no sign-in within 15 minutes'))
    }, WAIT_MS)
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const ok = code && url.searchParams.get('state') === state
      res
        .writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
        .end(ok ? 'Signed in. You can close this tab.' : 'Sign-in failed; see the terminal.')
      clearTimeout(timer)
      server.close()
      if (ok) resolve(code)
      else reject(new Error(url.searchParams.get('error') ?? 'callback state mismatch'))
    })
    server.listen(PORT, '127.0.0.1')
  })
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ENUM_VALUE = /^[A-Za-z0-9_.-]{1,40}$/

/** One tool's pin in the app's `name(arg,arg=v1|v2)` form, from what the server
 *  lists. Names or values the app's parser would refuse are left out and
 *  reported, so the printed line always parses; the operator reviews it. */
function pinFor(tool: { name: string; inputSchema?: unknown }): string | null {
  if (!IDENTIFIER.test(tool.name)) {
    console.warn(`left out a tool whose name the app cannot pin`)
    return null
  }
  const schema = (tool.inputSchema ?? {}) as { properties?: Record<string, { enum?: unknown[] }> }
  const args: string[] = []
  for (const [arg, prop] of Object.entries(schema.properties ?? {})) {
    if (!IDENTIFIER.test(arg)) {
      console.warn(`${tool.name}: left out an argument whose name the app cannot pin`)
      continue
    }
    const values = (Array.isArray(prop?.enum) ? prop.enum : []).map(String)
    const kept = values.filter((v) => ENUM_VALUE.test(v))
    if (kept.length < values.length) console.warn(`${tool.name}.${arg}: left out enum values`)
    args.push(kept.length ? `${arg}=${kept.join('|')}` : arg)
  }
  return `${tool.name}(${args.join(',')})`
}

async function main(): Promise<void> {
  const codePromise = waitForCode()
  if ((await auth(provider, { serverUrl: SERVER_URL })) !== 'REDIRECT') {
    throw new Error('expected a sign-in redirect')
  }
  const code = await codePromise
  await auth(provider, { serverUrl: SERVER_URL, authorizationCode: code })
  if (!client || !tokens?.refresh_token) {
    throw new Error('the server issued no refresh token; the app cannot keep a session')
  }
  // One refresh, exactly as the app does it (auth() with a refresh token and no
  // code). Only the boolean is reported; the values are never compared in print.
  const before = tokens.refresh_token
  if ((await auth(provider, { serverUrl: SERVER_URL })) !== 'AUTHORIZED') {
    throw new Error('the refresh was refused')
  }
  const after = tokens.refresh_token
  if (!after) throw new Error('the refresh returned no refresh token')
  const rotated = after !== before

  const mcp = new Client({ name: 'hames-lennys-data-sign-in', version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  )
  let pins: string[]
  try {
    pins = (await mcp.listTools()).tools.map(pinFor).filter((pin): pin is string => pin !== null)
  } finally {
    await mcp.close()
  }

  console.log(`Refresh token rotated on refresh: ${rotated}`)
  console.log(
    `Access token lifetime: ${tokens.expires_in ?? 'not stated'} s; scope: ${tokens.scope ?? 'not stated'}`,
  )
  console.log('\nAdd these to the server environment (secrets; never commit them):\n')
  console.log(`LENNYS_DATA_MCP_CLIENT_ID=${client.client_id}`)
  console.log(`LENNYS_DATA_MCP_REFRESH_TOKEN=${after}`)
  console.log(`LENNYS_DATA_MCP_TOOLS=${pins.join(',')}`)
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)

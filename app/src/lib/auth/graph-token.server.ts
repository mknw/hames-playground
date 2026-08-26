/**
 * Per-user Microsoft Graph tokens — Server Only.
 *
 * Pattern C (#110): obtain a short-lived access token that acts **as the
 * signed-in user**, so Entra enforces the delegated scope and we never rely on
 * an over-privileged org token guarded only by app code.
 *
 * ## Why `acquireTokenSilent` and not the OBO grant
 * The classic On-Behalf-Of grant is for a *middle-tier API*: a separate client
 * (SPA/mobile) signs in, receives a token scoped to **our** API, calls us, and
 * we exchange that user assertion for a downstream token. Since #119 this app
 * **is** the confidential OIDC client — the browser holds an opaque session
 * cookie, not a token — so there is no user assertion to exchange. We already
 * hold the user's refresh token from sign-in, which makes `acquireTokenSilent`
 * the correct (and simpler) call: same outcome, delegated per-user token from
 * Entra, no `api://…/access_as_user` scope and no "Expose an API" config.
 *
 * `acquireTokenOnBehalfOf` becomes necessary only if a distinct client ever
 * authenticates to Entra itself and calls our API (e.g. giving the iOS
 * Shortcut its own client id). The token-cache plumbing here is the seam for
 * that; see `docs/deployment/entra-setup.md`.
 *
 * ## Security posture (#107 principle 1)
 * Tokens are resolved server-side from the authenticated `userId` and are
 * never tool arguments, never logged, and never placed in the prompt/context.
 * Callers should prefer {@link graphFetch}, which attaches the credential
 * internally so no calling code ever handles a raw token.
 */
import {
  ConfidentialClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
} from '@azure/msal-node'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { buildEntraConfig, msalConfiguration } from './entra-config.server'
import { loadUserTokenCache, saveUserTokenCache } from './user-tokens.server'

assertServerOnImport()

/** Graph base URL (v1.0). */
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/**
 * Default delegated scope set. `User.Read` is already admin-consented in the
 * tenant, so the first slice needs no new consent. Additional connector scopes
 * (Mail.Read, Files.Read.All, …) are requested at **sign-in** so the refresh
 * token can mint them silently — see `entra-config.server.ts`.
 */
export const DEFAULT_GRAPH_SCOPES = ['User.Read'] as const

/**
 * Raised when we cannot get a token without user interaction — no stored cache,
 * an unusable/expired refresh token, or a scope the user hasn't consented to.
 * Tool wrappers translate this into a "please sign in again" result rather than
 * failing the whole run.
 */
export class GraphAuthRequiredError extends Error {
  constructor(
    message: string,
    readonly userId: string,
    /** HTTP status when Graph itself rejected the call (401 expired token,
     *  403 missing consent OR resource-level denial such as SharePoint
     *  Embedded); undefined when token ACQUISITION failed before any HTTP
     *  request. Lets tools tell "sign in again" apart from "re-auth won't
     *  help" (e.g. Loop content, #137). */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GraphAuthRequiredError'
  }
}

/**
 * Acquire a delegated Graph access token for `userId`.
 *
 * Rehydrates that user's MSAL cache, acquires silently (MSAL uses a cached
 * access token when still valid, else redeems the refresh token), and persists
 * the cache back when MSAL mutated it — Entra rotates refresh tokens, so
 * skipping the write-back would strand the user after the old token expires.
 */
export async function getUserGraphToken(
  userId: string,
  scopes: readonly string[] = DEFAULT_GRAPH_SCOPES,
): Promise<string> {
  const stored = await loadUserTokenCache(userId)
  if (!stored) {
    throw new GraphAuthRequiredError(
      'No Microsoft token cache for this user — sign in to connect Microsoft 365.',
      userId,
    )
  }

  const cfg = buildEntraConfig()
  const cca = new ConfidentialClientApplication(msalConfiguration(cfg))
  const cache = cca.getTokenCache()
  await cache.deserialize(stored.tokenCache)

  const account = await resolveAccount(cache, stored.homeAccountId)
  if (!account) {
    throw new GraphAuthRequiredError(
      'Stored Microsoft token cache has no usable account — sign in again.',
      userId,
    )
  }

  try {
    const result = await cca.acquireTokenSilent({
      account,
      scopes: [...scopes],
    })
    if (!result?.accessToken) {
      throw new GraphAuthRequiredError(
        'Microsoft returned no access token — sign in again.',
        userId,
      )
    }

    // Persist rotation. `hasChanged` avoids a pointless write when MSAL served
    // a still-valid cached access token.
    if (cache.hasChanged()) {
      await saveUserTokenCache(
        userId,
        cache.serialize(),
        account.homeAccountId ?? stored.homeAccountId,
      ).catch((err) =>
        // A failed write-back doesn't invalidate the token we just got; the
        // next call will simply re-redeem. Log, don't fail the request.
        console.error('[graph-token] failed to persist rotated cache:', err),
      )
    }

    return result.accessToken
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) throw err
    if (err instanceof InteractionRequiredAuthError) {
      throw new GraphAuthRequiredError(
        'Microsoft requires interactive sign-in (consent or expired credential) — sign in again.',
        userId,
      )
    }
    throw err
  }
}

/** Prefer the recorded account; fall back to the cache's sole account. */
async function resolveAccount(
  cache: ReturnType<ConfidentialClientApplication['getTokenCache']>,
  homeAccountId: string | null,
): Promise<AccountInfo | null> {
  if (homeAccountId) {
    const byId = await cache.getAccountByHomeId(homeAccountId)
    if (byId) return byId
  }
  const all = await cache.getAllAccounts()
  return all.length === 1 ? all[0] : null
}

/**
 * Call Microsoft Graph as `userId`. The token is attached here and never
 * returned to callers, so tool implementations cannot leak it.
 *
 * @param path Graph path beginning with `/` (e.g. `/me`), or an absolute URL
 *             (used for `@odata.nextLink` pagination).
 *
 * ## `responseType: 'base64'` and the `/content` redirect
 * File downloads (`/drive/items/{id}/content`) answer **302** to a
 * pre-authenticated CDN URL (`*.sharepoint.com`, `*.files.1drv.com`) that
 * carries its own short-lived token in the query string. We deliberately let
 * `fetch` follow it: per the Fetch standard — and verified on this runtime
 * (Node 22 / undici 6) — `Authorization` is **stripped on a cross-origin
 * redirect**, so our delegated bearer token never reaches the CDN, while the
 * same-origin Graph→Graph case keeps it. `redirect: 'manual'` plus a bare
 * follow-up fetch would achieve the same thing with more moving parts, so it
 * isn't used. `Accept` *is* forwarded, hence `*​/*` in binary mode rather than
 * asking a blob endpoint for JSON.
 */
export async function graphFetch(
  userId: string,
  path: string,
  init: {
    method?: string
    scopes?: readonly string[]
    body?: unknown
    /** Extra request headers, e.g. `Prefer: outlook.timezone="Europe/Brussels"`.
     *  Cannot override Authorization — the credential is set here, not by callers. */
    headers?: Record<string, string>
    /**
     * How to decode the response body. `'json'` (default) parses JSON;
     * `'base64'` returns the raw bytes base64-encoded — the only faithful way to
     * carry a binary file (xlsx/pdf/png) through the string-typed Data Stash.
     */
    responseType?: 'json' | 'base64'
  } = {},
): Promise<unknown> {
  const token = await getUserGraphToken(userId, init.scopes ?? DEFAULT_GRAPH_SCOPES)
  const res = await sendGraphRequest(token, path, init)

  if (res.status === 401 || res.status === 403) {
    // Entra rejected the delegated token — treat as re-auth/consent needed.
    // The body can echo request detail, so it is deliberately not surfaced.
    throw new GraphAuthRequiredError(
      `Microsoft Graph denied the request (${res.status}) — the account may lack consent for this scope.`,
      userId,
      res.status,
    )
  }
  return decodeGraphResponse(res, path, init)
}

/** Options both {@link graphFetch} and {@link graphAppFetch} accept. */
interface GraphRequestInit {
  method?: string
  scopes?: readonly string[]
  body?: unknown
  headers?: Record<string, string>
  responseType?: 'json' | 'base64'
}

/**
 * Issue the HTTP request. The credential is attached **here**, in the one place
 * both the delegated and the app-only path share, so neither can drift into
 * letting a caller supply or override `Authorization`.
 *
 * ## Why a `Headers` and not an object literal
 * Header names are case-insensitive and `Headers` **appends** rather than
 * replaces when it is built from a record. Spreading the caller's headers into
 * an object and writing `Authorization` last therefore only wins against that
 * exact spelling: a caller passing lowercase `authorization` produced *two*
 * entries, which `fetch` folds into one comma-joined value with the caller's
 * credential in front of ours. `Headers.set` is case-insensitive and really
 * does replace, so the sentence above is now true of every spelling rather
 * than of one. Same for `Content-Type`, which had the same shape.
 */
function sendGraphRequest(token: string, path: string, init: GraphRequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`
  const wantsBytes = init.responseType === 'base64'
  const headers = new Headers(init.headers)
  // Set last, and by name rather than by key, so a caller can never replace the
  // credential or the content type.
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', wantsBytes ? '*/*' : 'application/json')
  // Decorated traffic is prioritized under Graph throttling; undecorated
  // traffic is first to be shed. NONISV|<company>|<app>/<version> is the
  // documented shape for internal (non-ISV) apps.
  headers.set('User-Agent', 'NONISV|DTSC|kg-agent/1.0')
  if (init.body) headers.set('Content-Type', 'application/json')
  return fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })
}

/** Shared non-auth response handling: throw on any other error status, then
 *  decode per `responseType`. */
async function decodeGraphResponse(
  res: Response,
  path: string,
  init: GraphRequestInit,
): Promise<unknown> {
  if (!res.ok) {
    throw new Error(
      `[graph] ${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`,
    )
  }
  if (res.status === 204) return null
  if (init.responseType === 'base64') {
    return Buffer.from(await res.arrayBuffer()).toString('base64')
  }
  return res.json()
}

// ============================================================================
// App-only (client-credentials) access — the directory read, and nothing else
// ============================================================================

/**
 * The `.default` scope of the Graph resource. Client credentials cannot request
 * individual permissions: Entra issues whatever **application** roles the app
 * registration has been granted admin consent for, and `.default` is how you
 * ask for exactly that set. Which roles those are is therefore a tenant fact,
 * not a code fact — see {@link graphAppFetch}'s note on the blast radius.
 */
export const GRAPH_APP_SCOPE = 'https://graph.microsoft.com/.default'

/**
 * Raised when Graph refuses an **app-only** call. Deliberately not
 * {@link GraphAuthRequiredError}: no user can sign in to fix this. A 403 here
 * means the app registration lacks the application permission, which is an
 * admin-consent change in the tenant, and telling a user to "sign in again"
 * would be actively misleading.
 */
export class GraphAppPermissionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GraphAppPermissionError'
  }
}

/** Cached app token — one per process, refreshed a minute before expiry. */
let appToken: { value: string; expiresAt: number } | null = null

/** How early to treat a cached app token as spent, in ms. */
const APP_TOKEN_SKEW_MS = 60_000

/**
 * Acquire an **app-only** Graph token via the client-credentials grant.
 *
 * This token carries no user identity, so nothing Entra does constrains it to
 * one person's data: it is bounded solely by the application permissions the
 * tenant granted. That is why there is exactly one caller shape for it in this
 * repo — the directory roster read — and why it is a separate function from
 * {@link getUserGraphToken} rather than a flag on it. A flag would have made
 * "act as the app" one boolean away from every existing per-user call site,
 * which is the opposite of #107 principle 1 (`graph-token.server.ts` header).
 *
 * MSAL's own app-token cache lives on the client instance, and a fresh
 * `ConfidentialClientApplication` per call would defeat it, so the token is
 * memoized here instead.
 */
export async function getAppGraphToken(): Promise<string> {
  const now = Date.now()
  if (appToken && appToken.expiresAt - APP_TOKEN_SKEW_MS > now) return appToken.value

  const cfg = buildEntraConfig()
  const cca = new ConfidentialClientApplication(msalConfiguration(cfg))
  const result = await cca.acquireTokenByClientCredential({ scopes: [GRAPH_APP_SCOPE] })
  if (!result?.accessToken) {
    throw new GraphAppPermissionError(
      'Entra returned no app-only access token for the client-credentials grant.',
      401,
    )
  }
  appToken = {
    value: result.accessToken,
    // `expiresOn` is nullable on the MSAL type; an hour is the documented
    // default and erring short only costs one extra token request.
    expiresAt: result.expiresOn?.getTime() ?? now + 3_600_000,
  }
  return result.accessToken
}

/** Drop the memoized app token. For tests, and for a credential rotation. */
export function resetAppGraphToken(): void {
  appToken = null
}

/**
 * Call Microsoft Graph **as the application**, not as a user.
 *
 * Use this only where acting as a user is impossible in principle — the
 * directory roster is read for the whole tenant, so there is no user whose
 * delegated view would be correct. Everything else must go through
 * {@link graphFetch}, so Entra keeps enforcing per-user scope.
 *
 * A 401/403 raises {@link GraphAppPermissionError} rather than the
 * re-authenticate error, because an app-only denial is a tenant-consent fact.
 */
export async function graphAppFetch(
  path: string,
  init: Omit<GraphRequestInit, 'scopes'> = {},
): Promise<unknown> {
  const token = await getAppGraphToken()
  const res = await sendGraphRequest(token, path, init)

  if (res.status === 401 || res.status === 403) {
    // The body echoes the request, so it is deliberately not surfaced.
    throw new GraphAppPermissionError(
      `Microsoft Graph denied an app-only request (${res.status}) — the app ` +
        `registration is missing the application permission this path needs.`,
      res.status,
    )
  }
  return decodeGraphResponse(res, path, init)
}

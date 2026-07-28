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
 * that; see `docs/deploy/entra-setup.md`.
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
} from "@azure/msal-node";
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { buildEntraConfig, msalConfiguration } from "./entra-config.server";
import { loadUserTokenCache, saveUserTokenCache } from "./user-tokens.server";

assertServerOnImport();

/** Graph base URL (v1.0). */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Default delegated scope set. `User.Read` is already admin-consented in the
 * tenant, so the first slice needs no new consent. Additional connector scopes
 * (Mail.Read, Files.Read.All, …) are requested at **sign-in** so the refresh
 * token can mint them silently — see `entra-config.server.ts`.
 */
export const DEFAULT_GRAPH_SCOPES = ["User.Read"] as const;

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
  ) {
    super(message);
    this.name = "GraphAuthRequiredError";
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
  const stored = await loadUserTokenCache(userId);
  if (!stored) {
    throw new GraphAuthRequiredError(
      "No Microsoft token cache for this user — sign in to connect Microsoft 365.",
      userId,
    );
  }

  const cfg = buildEntraConfig();
  const cca = new ConfidentialClientApplication(msalConfiguration(cfg));
  const cache = cca.getTokenCache();
  await cache.deserialize(stored.tokenCache);

  const account = await resolveAccount(cache, stored.homeAccountId);
  if (!account) {
    throw new GraphAuthRequiredError(
      "Stored Microsoft token cache has no usable account — sign in again.",
      userId,
    );
  }

  try {
    const result = await cca.acquireTokenSilent({
      account,
      scopes: [...scopes],
    });
    if (!result?.accessToken) {
      throw new GraphAuthRequiredError(
        "Microsoft returned no access token — sign in again.",
        userId,
      );
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
        console.error("[graph-token] failed to persist rotated cache:", err),
      );
    }

    return result.accessToken;
  } catch (err) {
    if (err instanceof GraphAuthRequiredError) throw err;
    if (err instanceof InteractionRequiredAuthError) {
      throw new GraphAuthRequiredError(
        "Microsoft requires interactive sign-in (consent or expired credential) — sign in again.",
        userId,
      );
    }
    throw err;
  }
}

/** Prefer the recorded account; fall back to the cache's sole account. */
async function resolveAccount(
  cache: ReturnType<ConfidentialClientApplication["getTokenCache"]>,
  homeAccountId: string | null,
): Promise<AccountInfo | null> {
  if (homeAccountId) {
    const byId = await cache.getAccountByHomeId(homeAccountId);
    if (byId) return byId;
  }
  const all = await cache.getAllAccounts();
  return all.length === 1 ? all[0] : null;
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
    method?: string;
    scopes?: readonly string[];
    body?: unknown;
    /** Extra request headers, e.g. `Prefer: outlook.timezone="Europe/Brussels"`.
     *  Cannot override Authorization — the credential is set here, not by callers. */
    headers?: Record<string, string>;
    /**
     * How to decode the response body. `'json'` (default) parses JSON;
     * `'base64'` returns the raw bytes base64-encoded — the only faithful way to
     * carry a binary file (xlsx/pdf/png) through the string-typed Data Stash.
     */
    responseType?: "json" | "base64";
  } = {},
): Promise<unknown> {
  const token = await getUserGraphToken(userId, init.scopes ?? DEFAULT_GRAPH_SCOPES);
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const wantsBytes = init.responseType === "base64";

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...init.headers,
      // Set last so a caller can never replace the credential or content type.
      Authorization: `Bearer ${token}`,
      Accept: wantsBytes ? "*/*" : "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  if (res.status === 401 || res.status === 403) {
    // Entra rejected the delegated token — treat as re-auth/consent needed.
    // The body can echo request detail, so it is deliberately not surfaced.
    throw new GraphAuthRequiredError(
      `Microsoft Graph denied the request (${res.status}) — the account may lack consent for this scope.`,
      userId,
    );
  }
  if (!res.ok) {
    throw new Error(
      `[graph] ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}`,
    );
  }
  if (res.status === 204) return null;
  if (wantsBytes) return Buffer.from(await res.arrayBuffer()).toString("base64");
  return res.json();
}

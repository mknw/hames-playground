/**
 * Entra OIDC auth-code flow (MSAL confidential client) — Server Only.
 *
 * Thin wrapper over `@azure/msal-node` for the three things the routes need:
 *   1. build the authorize URL (with PKCE + state + nonce),
 *   2. redeem the authorization code → identity claims + serialized token cache,
 *   3. build the sign-out URL.
 *
 * A fresh `ConfidentialClientApplication` is created per operation so each
 * sign-in's token cache contains only that user's tokens (clean per-user
 * isolation when we later persist it for OBO — #110). `acquireTokenOnBehalfOf`
 * is intentionally NOT used here; OBO is #110.
 */
import {
  ConfidentialClientApplication,
  CryptoProvider,
  ResponseMode,
} from "@azure/msal-node";
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { buildEntraConfig, msalConfiguration, type EntraConfig } from "./entra-config.server";
import { extractIdentity, type EntraIdTokenClaims } from "./entra-claims";

assertServerOnImport();

export { extractIdentity };
export type { EntraIdTokenClaims, EntraIdentity } from "./entra-claims";

function makeClient(cfg: EntraConfig): ConfidentialClientApplication {
  return new ConfidentialClientApplication(msalConfiguration(cfg));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const crypto = new CryptoProvider();

/** Generate a PKCE verifier/challenge pair (S256). */
export function generatePkce(): Promise<PkcePair> {
  return crypto.generatePkceCodes();
}

/** Opaque anti-CSRF value / OIDC nonce. */
export function newStateValue(): string {
  return crypto.createNewGuid();
}

/**
 * Build the Entra authorize URL. `codeChallenge` comes from {@link generatePkce};
 * keep the matching `verifier` server-side (in the handshake cookie) for the
 * code redemption.
 */
export async function buildAuthCodeUrl(args: {
  state: string;
  nonce: string;
  codeChallenge: string;
  cfg?: EntraConfig;
}): Promise<string> {
  const cfg = args.cfg ?? buildEntraConfig();
  const cca = makeClient(cfg);
  return cca.getAuthCodeUrl({
    scopes: cfg.scopes,
    redirectUri: cfg.redirectUri,
    state: args.state,
    nonce: args.nonce,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: "S256",
    responseMode: ResponseMode.QUERY,
  });
}

export interface RedeemedCode {
  identity: EntraIdentity;
  homeAccountId: string | null;
  /** Serialized MSAL token cache for this account — persisted for OBO (#110). */
  tokenCache: string;
}

/**
 * Exchange an authorization code for tokens and extract the identity + the
 * serialized token cache. The `nonce` is validated by MSAL against the ID
 * token when supplied.
 */
export async function redeemAuthCode(args: {
  code: string;
  codeVerifier: string;
  nonce?: string;
  cfg?: EntraConfig;
}): Promise<RedeemedCode> {
  const cfg = args.cfg ?? buildEntraConfig();
  const cca = makeClient(cfg);
  const result = await cca.acquireTokenByCode({
    code: args.code,
    scopes: cfg.scopes,
    redirectUri: cfg.redirectUri,
    codeVerifier: args.codeVerifier,
    ...(args.nonce ? { nonce: args.nonce } : {}),
  });
  if (!result) {
    throw new Error("[entra] token endpoint returned no result for the authorization code.");
  }
  const identity = extractIdentity(result.idTokenClaims as EntraIdTokenClaims);
  return {
    identity,
    homeAccountId: result.account?.homeAccountId ?? null,
    tokenCache: cca.getTokenCache().serialize(),
  };
}

/**
 * Build the Entra sign-out URL. MSAL Node has no `getLogoutUri`, so we compose
 * the standard v2.0 logout endpoint with `post_logout_redirect_uri`.
 */
export function buildLogoutUrl(cfg: EntraConfig = buildEntraConfig()): string {
  const u = new URL(`${cfg.authority}/oauth2/v2.0/logout`);
  u.searchParams.set("post_logout_redirect_uri", cfg.postLogoutRedirectUri);
  return u.toString();
}

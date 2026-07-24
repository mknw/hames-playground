/**
 * Entra (Microsoft identity platform) OIDC configuration — Server Only.
 *
 * Reads the `AZURE_*` env + auth-session settings and produces the MSAL
 * confidential-client `Configuration` plus the OIDC parameters (authority,
 * redirect URI, scopes). Direct MSAL OIDC replaces Stack Auth for #119; the
 * decision to go direct (rather than federate Entra into Stack) hinges on
 * #110 (OBO) needing the raw Entra token server-side — a Stack-brokered flow
 * never yields it. Tenant-owner provisioning is documented in
 * `docs/deploy/entra-setup.md`.
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import type { Configuration } from "@azure/msal-node";

assertServerOnImport();

/** Public Azure AD (Entra) authority host. */
export const AAD_HOST = "https://login.microsoftonline.com";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** `${AAD_HOST}/${tenantId}` — single-tenant authority. */
  authority: string;
  /** Must match a Redirect URI registered on the app (Web platform). */
  redirectUri: string;
  /** Where Entra returns the browser after sign-out. */
  postLogoutRedirectUri: string;
  /**
   * Resource scopes requested at sign-in. `openid` / `profile` /
   * `offline_access` are reserved and added by MSAL automatically — do NOT
   * list them here (MSAL throws if you do). `offline_access` is what yields
   * the refresh token we persist for the future OBO exchange (#110).
   */
  scopes: string[];
}

const DEFAULT_REDIRECT_URI = "http://localhost:3444/api/auth/callback";
const DEFAULT_POST_LOGOUT_REDIRECT_URI = "http://localhost:3444/auth/signin";

/**
 * True when all three `AZURE_*` secrets are present. `/api/auth/login` checks
 * this and returns a helpful error instead of a raw MSAL crash when the tenant
 * config hasn't been filled in yet (dev-bypass remains the zero-config path).
 */
export function isEntraConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env.AZURE_TENANT_ID?.trim() &&
      env.AZURE_CLIENT_ID?.trim() &&
      env.AZURE_CLIENT_SECRET?.trim(),
  );
}

/**
 * Build the validated Entra config, or throw with a precise message naming the
 * missing var. Pure w.r.t. its `env` argument so it can be unit-tested without
 * touching `process.env`.
 */
export function buildEntraConfig(
  env: Record<string, string | undefined> = process.env,
): EntraConfig {
  const tenantId = required(env, "AZURE_TENANT_ID");
  const clientId = required(env, "AZURE_CLIENT_ID");
  const clientSecret = required(env, "AZURE_CLIENT_SECRET");
  return {
    tenantId,
    clientId,
    clientSecret,
    authority: `${AAD_HOST}/${tenantId}`,
    redirectUri: env.AUTH_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    postLogoutRedirectUri:
      env.AUTH_POST_LOGOUT_REDIRECT_URI?.trim() ||
      DEFAULT_POST_LOGOUT_REDIRECT_URI,
    scopes: ["User.Read", "email"],
  };
}

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const v = env[key]?.trim();
  if (!v) {
    throw new Error(
      `[entra] ${key} is not set. Entra SSO is not configured — set ` +
        `AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (see ` +
        `docs/deploy/entra-setup.md), or run dev with VITE_DEV_BYPASS_AUTH=true.`,
    );
  }
  return v;
}

/**
 * MSAL `ConfidentialClientApplication` configuration derived from an
 * `EntraConfig`. Kept separate from client construction so the shape is
 * testable and the MSAL instance can be created per-request (clean per-user
 * token cache — see `entra.server.ts`).
 */
export function msalConfiguration(cfg: EntraConfig): Configuration {
  return {
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority,
      clientSecret: cfg.clientSecret,
    },
  };
}

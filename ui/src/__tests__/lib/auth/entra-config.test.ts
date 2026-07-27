/**
 * Entra config validation (#119). `buildEntraConfig` is pure w.r.t. its `env`
 * arg, so no `process.env` juggling.
 */
import { describe, it, expect, vi } from "vitest";

// Bypass the server-only guard in the jsdom test env.
vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

import {
  buildEntraConfig,
  isEntraConfigured,
  msalConfiguration,
  AAD_HOST,
} from "../../../lib/auth/entra-config.server";

const full = {
  AZURE_TENANT_ID: "tid",
  AZURE_CLIENT_ID: "cid",
  AZURE_CLIENT_SECRET: "secret",
};

describe("isEntraConfigured", () => {
  it("is true only when all three secrets are present + non-blank", () => {
    expect(isEntraConfigured(full)).toBe(true);
    expect(isEntraConfigured({ ...full, AZURE_CLIENT_SECRET: "" })).toBe(false);
    expect(isEntraConfigured({ ...full, AZURE_TENANT_ID: "   " })).toBe(false);
    expect(isEntraConfigured({})).toBe(false);
  });
});

describe("buildEntraConfig", () => {
  it("derives the single-tenant authority and dev defaults", () => {
    const cfg = buildEntraConfig(full);
    expect(cfg.authority).toBe(`${AAD_HOST}/tid`);
    expect(cfg.redirectUri).toBe("http://localhost:3444/api/auth/callback");
    expect(cfg.postLogoutRedirectUri).toBe("http://localhost:3444/auth/signin");
    expect(cfg.scopes).toEqual(["User.Read", "email"]);
  });

  it("does NOT list reserved OIDC scopes (MSAL adds them)", () => {
    const cfg = buildEntraConfig(full);
    for (const reserved of ["openid", "profile", "offline_access"]) {
      expect(cfg.scopes).not.toContain(reserved);
    }
  });

  it("honors explicit redirect / post-logout overrides", () => {
    const cfg = buildEntraConfig({
      ...full,
      AUTH_REDIRECT_URI: "https://app.example/api/auth/callback",
      AUTH_POST_LOGOUT_REDIRECT_URI: "https://app.example/auth/signin",
    });
    expect(cfg.redirectUri).toBe("https://app.example/api/auth/callback");
    expect(cfg.postLogoutRedirectUri).toBe("https://app.example/auth/signin");
  });

  it("throws naming the specific missing var", () => {
    expect(() =>
      buildEntraConfig({ AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s" }),
    ).toThrow(/AZURE_TENANT_ID/);
    expect(() =>
      buildEntraConfig({ AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "s" }),
    ).toThrow(/AZURE_CLIENT_ID/);
    expect(() =>
      buildEntraConfig({ AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c" }),
    ).toThrow(/AZURE_CLIENT_SECRET/);
  });

  it("msalConfiguration mirrors the auth fields", () => {
    const msal = msalConfiguration(buildEntraConfig(full));
    expect(msal.auth.clientId).toBe("cid");
    expect(msal.auth.authority).toBe(`${AAD_HOST}/tid`);
    expect(msal.auth.clientSecret).toBe("secret");
  });
});

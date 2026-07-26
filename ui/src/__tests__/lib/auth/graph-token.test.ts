/**
 * Per-user Graph token acquisition (#110) — MSAL, config and store are mocked,
 * so this runs with no tenant, no network and no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

// ---- MSAL double ------------------------------------------------------------
// The class must be hoisted with the mock factory: vi.mock is lifted above
// normal declarations, so a plain `class` here would still be in its TDZ when
// the factory runs.
const { FakeInteractionRequiredAuthError } = vi.hoisted(() => ({
  FakeInteractionRequiredAuthError: class extends Error {},
}));

const acquireTokenSilent = vi.fn();
const cacheState = {
  deserialize: vi.fn(),
  serialize: vi.fn(() => '{"cache":"rotated"}'),
  hasChanged: vi.fn(() => true),
  getAccountByHomeId: vi.fn(async () => ({ homeAccountId: "hai-1" })),
  getAllAccounts: vi.fn(async () => [{ homeAccountId: "hai-1" }]),
};

vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    getTokenCache() {
      return cacheState;
    }
    acquireTokenSilent = acquireTokenSilent;
  },
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError,
}));

vi.mock("../../../lib/auth/entra-config.server", () => ({
  buildEntraConfig: () => ({
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    authority: "https://login.microsoftonline.com/t",
    redirectUri: "http://localhost:3444/api/auth/callback",
    postLogoutRedirectUri: "http://localhost:3444/auth/signin",
    scopes: ["User.Read"],
  }),
  msalConfiguration: () => ({ auth: { clientId: "c" } }),
}));

const loadUserTokenCache = vi.fn();
const saveUserTokenCache = vi.fn(async () => {});
vi.mock("../../../lib/auth/user-tokens.server", () => ({
  loadUserTokenCache: (...a: unknown[]) => loadUserTokenCache(...a),
  saveUserTokenCache: (...a: unknown[]) => saveUserTokenCache(...a),
}));

import {
  getUserGraphToken,
  graphFetch,
  GraphAuthRequiredError,
  GRAPH_BASE,
} from "../../../lib/auth/graph-token.server";

const USER = "oid-123";

beforeEach(() => {
  vi.clearAllMocks();
  cacheState.hasChanged.mockReturnValue(true);
  cacheState.serialize.mockReturnValue('{"cache":"rotated"}');
  cacheState.getAccountByHomeId.mockResolvedValue({ homeAccountId: "hai-1" });
  cacheState.getAllAccounts.mockResolvedValue([{ homeAccountId: "hai-1" }]);
  loadUserTokenCache.mockResolvedValue({
    homeAccountId: "hai-1",
    tokenCache: '{"cache":"stored"}',
    updatedAt: new Date(0),
  });
  acquireTokenSilent.mockResolvedValue({ accessToken: "tok-abc" });
});

describe("getUserGraphToken", () => {
  it("returns a delegated token and rehydrates the user's cache", async () => {
    await expect(getUserGraphToken(USER)).resolves.toBe("tok-abc");
    expect(cacheState.deserialize).toHaveBeenCalledWith('{"cache":"stored"}');
    expect(acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["User.Read"] }),
    );
  });

  it("persists the rotated cache when MSAL mutated it", async () => {
    await getUserGraphToken(USER);
    expect(saveUserTokenCache).toHaveBeenCalledWith(USER, '{"cache":"rotated"}', "hai-1");
  });

  it("skips the write-back when the cache is unchanged", async () => {
    cacheState.hasChanged.mockReturnValue(false);
    await getUserGraphToken(USER);
    expect(saveUserTokenCache).not.toHaveBeenCalled();
  });

  it("still returns the token when the write-back fails", async () => {
    saveUserTokenCache.mockRejectedValueOnce(new Error("db down"));
    await expect(getUserGraphToken(USER)).resolves.toBe("tok-abc");
  });

  it("passes through custom scopes", async () => {
    await getUserGraphToken(USER, ["Mail.Read"]);
    expect(acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["Mail.Read"] }),
    );
  });

  it("throws GraphAuthRequiredError when the user has no stored cache", async () => {
    loadUserTokenCache.mockResolvedValue(null);
    await expect(getUserGraphToken(USER)).rejects.toBeInstanceOf(GraphAuthRequiredError);
    expect(acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("throws GraphAuthRequiredError when no account resolves", async () => {
    cacheState.getAccountByHomeId.mockResolvedValue(null);
    cacheState.getAllAccounts.mockResolvedValue([]);
    await expect(getUserGraphToken(USER)).rejects.toBeInstanceOf(GraphAuthRequiredError);
  });

  it("falls back to the sole cached account when the recorded id misses", async () => {
    cacheState.getAccountByHomeId.mockResolvedValue(null);
    cacheState.getAllAccounts.mockResolvedValue([{ homeAccountId: "hai-2" }]);
    await expect(getUserGraphToken(USER)).resolves.toBe("tok-abc");
  });

  it("maps InteractionRequiredAuthError → GraphAuthRequiredError", async () => {
    acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError("consent"));
    await expect(getUserGraphToken(USER)).rejects.toBeInstanceOf(GraphAuthRequiredError);
  });

  it("propagates unexpected errors unchanged", async () => {
    acquireTokenSilent.mockRejectedValue(new Error("network boom"));
    await expect(getUserGraphToken(USER)).rejects.toThrow("network boom");
  });
});

describe("graphFetch", () => {
  it("attaches the bearer token and returns parsed JSON", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ displayName: "U" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(graphFetch(USER, "/me")).resolves.toEqual({ displayName: "U" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GRAPH_BASE}/me`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
  });

  it("accepts an absolute URL (nextLink pagination)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await graphFetch(USER, "https://graph.microsoft.com/v1.0/me/messages?$skip=10");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("$skip=10");
  });

  it("maps 401/403 to GraphAuthRequiredError", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, statusText: "no" })));
      await expect(graphFetch(USER, "/me")).rejects.toBeInstanceOf(GraphAuthRequiredError);
    }
  });

  it("throws a plain error on other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, statusText: "Server Error" })),
    );
    await expect(graphFetch(USER, "/me")).rejects.toThrow(/500/);
  });

  it("returns null for 204 No Content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));
    await expect(graphFetch(USER, "/me")).resolves.toBeNull();
  });
});

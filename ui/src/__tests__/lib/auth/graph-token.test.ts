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

type FakeAccount = { homeAccountId: string };

const acquireTokenSilent = vi.fn();
const cacheState = {
  deserialize: vi.fn(),
  serialize: vi.fn(() => '{"cache":"rotated"}'),
  hasChanged: vi.fn(() => true),
  getAccountByHomeId: vi.fn<(id: string) => Promise<FakeAccount | null>>(async () => ({
    homeAccountId: "hai-1",
  })),
  getAllAccounts: vi.fn<() => Promise<FakeAccount[]>>(async () => [
    { homeAccountId: "hai-1" },
  ]),
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

const loadUserTokenCache = vi.fn<(userId: string) => Promise<unknown>>();
const saveUserTokenCache = vi.fn<
  (userId: string, cache: string, homeAccountId: string | null) => Promise<void>
>(async () => {});
vi.mock("../../../lib/auth/user-tokens.server", () => ({
  loadUserTokenCache: (userId: string) => loadUserTokenCache(userId),
  saveUserTokenCache: (userId: string, cache: string, hai: string | null) =>
    saveUserTokenCache(userId, cache, hai),
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

  it("maps 401/403 to GraphAuthRequiredError carrying the HTTP status", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, statusText: "no" })));
      const err = await graphFetch(USER, "/me").then(
        () => null,
        (e) => e as GraphAuthRequiredError,
      );
      expect(err).toBeInstanceOf(GraphAuthRequiredError);
      // Status lets tools tell "sign in again" (401) apart from a per-item
      // denial where re-auth cannot help (403 on SharePoint Embedded, #137).
      expect(err!.status).toBe(status);
    }
  });

  it("token-acquisition failures carry NO status (no HTTP request was made)", async () => {
    loadUserTokenCache.mockResolvedValue(null);
    const err = await getUserGraphToken(USER).then(
      () => null,
      (e) => e as GraphAuthRequiredError,
    );
    expect(err).toBeInstanceOf(GraphAuthRequiredError);
    expect(err!.status).toBeUndefined();
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

  it("asks for JSON by default and never sends a body-less Content-Type", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await graphFetch(USER, "/me");
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  describe("responseType: 'base64'", () => {
    const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);

    function stubBinaryFetch() {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => BYTES.buffer,
        json: async () => {
          throw new Error("json() must not be called in binary mode");
        },
      }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("returns the raw bytes base64-encoded", async () => {
      stubBinaryFetch();
      await expect(
        graphFetch(USER, "/me/drive/items/01ABC/content", { responseType: "base64" }),
      ).resolves.toBe(Buffer.from(BYTES).toString("base64"));
    });

    it("asks for any content type — a blob endpoint has no JSON to give", async () => {
      const fetchMock = stubBinaryFetch();
      await graphFetch(USER, "/me/drive/items/01ABC/content", {
        responseType: "base64",
        scopes: ["Files.Read.All"],
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(url).toBe(`${GRAPH_BASE}/me/drive/items/01ABC/content`);
      expect(headers.Accept).toBe("*/*");
      // Still delegated, and the 302 to the CDN is followed by fetch itself —
      // which drops Authorization cross-origin (see graphFetch's doc comment).
      expect(headers.Authorization).toBe("Bearer tok-abc");
      expect(init.redirect).toBeUndefined();
      expect(acquireTokenSilent).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ["Files.Read.All"] }),
      );
    });

    it("still maps 401/403 and 204 the same way", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, statusText: "no" })));
      await expect(
        graphFetch(USER, "/x/content", { responseType: "base64" }),
      ).rejects.toBeInstanceOf(GraphAuthRequiredError);

      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));
      await expect(
        graphFetch(USER, "/x/content", { responseType: "base64" }),
      ).resolves.toBeNull();
    });
  });
});

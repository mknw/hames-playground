/**
 * Token-cache isolation between concurrent users (#110 / #107).
 *
 * Uses the REAL `getUserGraphToken` with a fake MSAL whose token is derived
 * from whichever cache was deserialized into that client instance. Deliberate
 * awaits inside deserialize/acquire create a window in which a shared client
 * would cross wires — so if these ever pass tokens between users, the test
 * fails rather than the tenant finding out.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock("@azure/msal-node", () => ({
  InteractionRequiredAuthError: class extends Error {},
  ConfidentialClientApplication: class {
    private loaded: string | null = null;
    getTokenCache() {
      return {
        deserialize: async (s: string) => {
          await sleep(5); // window for another user's call to interfere
          this.loaded = s;
        },
        serialize: () => this.loaded ?? "",
        hasChanged: () => true,
        getAccountByHomeId: async () => ({ homeAccountId: `acct-${this.loaded}` }),
        getAllAccounts: async () => [{ homeAccountId: `acct-${this.loaded}` }],
      };
    }
    acquireTokenSilent = async () => {
      await sleep(5);
      return {
        accessToken: `token-from-${this.loaded}`,
        account: { homeAccountId: `acct-${this.loaded}` },
      };
    };
  },
}));

vi.mock("../../../lib/auth/entra-config.server", () => ({
  buildEntraConfig: () => ({
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    authority: "https://login.microsoftonline.com/t",
    redirectUri: "r",
    postLogoutRedirectUri: "p",
    scopes: ["User.Read"],
  }),
  msalConfiguration: () => ({ auth: { clientId: "c" } }),
}));

const saved: Array<[string, string]> = [];
vi.mock("../../../lib/auth/user-tokens.server", () => ({
  loadUserTokenCache: async (userId: string) => {
    await sleep(3);
    return {
      homeAccountId: `acct-cache-of-${userId}`,
      tokenCache: `cache-of-${userId}`,
      updatedAt: new Date(0),
    };
  },
  saveUserTokenCache: async (userId: string, cache: string) => {
    saved.push([userId, cache]);
  },
}));

import { getUserGraphToken } from "../../../lib/auth/graph-token.server";

describe("token-cache isolation under concurrency", () => {
  beforeEach(() => {
    saved.length = 0;
  });

  it("gives each concurrent user a token derived from their OWN cache", async () => {
    const users = ["u1", "u2", "u3", "u4", "u5"];
    const tokens = await Promise.all(users.map((u) => getUserGraphToken(u)));

    // A shared MSAL client would hand two users the same token.
    users.forEach((u, i) => expect(tokens[i]).toBe(`token-from-cache-of-${u}`));
    expect(new Set(tokens).size).toBe(users.length);
  });

  it("writes each rotated cache back under the right user", async () => {
    const users = ["a1", "a2", "a3"];
    await Promise.all(users.map((u) => getUserGraphToken(u)));

    expect(saved).toHaveLength(3);
    for (const [userId, cache] of saved) {
      // Never persist one user's cache under another's id.
      expect(cache).toBe(`cache-of-${userId}`);
    }
  });

  it("repeated interleaved calls for the same two users never cross", async () => {
    const pairs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        getUserGraphToken(i % 2 === 0 ? "even-user" : "odd-user"),
      ),
    );
    pairs.forEach((tok, i) => {
      expect(tok).toBe(`token-from-cache-of-${i % 2 === 0 ? "even-user" : "odd-user"}`);
    });
  });
});

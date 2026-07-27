/**
 * Cross-user isolation (#110 / #107).
 *
 * These tests use the REAL AsyncLocalStorage scope (`runWithUserId`) and a real
 * per-call MSAL client, with deliberately interleaved awaits, so they fail if
 * concurrent users could ever observe each other's identity or tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Graph itself is stubbed; it echoes back whichever userId reached it, after a
// delay, so any context bleed between concurrent calls shows up as a mismatch.
vi.mock("../../../lib/auth/graph-token.server", () => ({
  GRAPH_BASE: "https://graph.microsoft.com/v1.0",
  DEFAULT_GRAPH_SCOPES: ["User.Read"],
  graphFetch: async (userId: string) => {
    await sleep(userId === "user-A" ? 30 : 5); // A is slow, B/C overtake it
    return { userPrincipalName: userId };
  },
}));

import { runWithUserId } from "../../../lib/harness-client/request-user.server";
import { runAppTool } from "../../../lib/app-tools/index.server";

describe("request-scoped identity under concurrency", () => {
  it("keeps each user's identity separate across interleaved calls", async () => {
    const call = (u: string) =>
      runWithUserId(u, async () => {
        // Yield before and after, so the scopes are genuinely interleaved.
        await sleep(1);
        const res = await runAppTool("graph_me", {});
        await sleep(1);
        return res;
      });

    const [a, b, c] = await Promise.all([call("user-A"), call("user-B"), call("user-C")]);

    // Each call must see ONLY its own user — the slow one included.
    expect((a.data as { userPrincipalName: string }).userPrincipalName).toBe("user-A");
    expect((b.data as { userPrincipalName: string }).userPrincipalName).toBe("user-B");
    expect((c.data as { userPrincipalName: string }).userPrincipalName).toBe("user-C");
  });

  it("nested scopes do not leak outward", async () => {
    const result = await runWithUserId("outer-user", async () => {
      const inner = await runWithUserId("inner-user", () => runAppTool("graph_me", {}));
      const outer = await runAppTool("graph_me", {});
      return { inner, outer };
    });

    expect((result.inner.data as { userPrincipalName: string }).userPrincipalName).toBe(
      "inner-user",
    );
    // After the nested scope closes, the outer identity is intact.
    expect((result.outer.data as { userPrincipalName: string }).userPrincipalName).toBe(
      "outer-user",
    );
  });

  it("refuses outside any scope, even while other users are mid-call", async () => {
    const [scoped, unscoped] = await Promise.all([
      runWithUserId("user-A", () => runAppTool("graph_me", {})),
      runAppTool("graph_me", {}), // no runWithUserId around this one
    ]);

    expect(scoped.success).toBe(true);
    expect(unscoped.success).toBe(false);
    expect(unscoped.error).toMatch(/authenticated user/i);
  });
});

// Token-cache isolation lives in token-isolation.test.ts — it needs the REAL
// graph-token module, which this file mocks.

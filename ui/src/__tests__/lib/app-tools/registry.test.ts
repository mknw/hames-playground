/**
 * App-side tool registry + the graph_me tool (#110).
 *
 * Asserts the security invariants from #107: the advertised schema carries no
 * credential field, the user id comes from request scope (never args), and a
 * call outside any user scope is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/harness-patterns/assert.server", () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}));

const getRequestUserId = vi.fn<() => string | null>(() => "oid-1");
const getRequestSessionId = vi.fn<() => string | null>(() => "sess-1");
vi.mock("../../../lib/harness-client/request-user.server", () => ({
  getRequestUserId: () => getRequestUserId(),
  getRequestSessionId: () => getRequestSessionId(),
  runWithUserId: (_u: string, fn: () => Promise<unknown>) => fn(),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}));

const graphFetch = vi.fn();
vi.mock("../../../lib/auth/graph-token.server", () => ({
  graphFetch: (...a: unknown[]) => graphFetch(...a),
  GRAPH_BASE: "https://graph.microsoft.com/v1.0",
  DEFAULT_GRAPH_SCOPES: ["User.Read"],
}));

// Importing the barrel registers the built-in tools as a side effect.
import {
  hasAppTool,
  runAppTool,
  appToolDescriptions,
  appToolNamespace,
  registerAppTool,
} from "../../../lib/app-tools/index.server";
import { shapeMe } from "../../../lib/app-tools/graph.server";

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
});

describe("registry wiring", () => {
  it("registers graph_me under the graph namespace", () => {
    expect(hasAppTool("graph_me")).toBe(true);
    expect(appToolNamespace("graph_me")).toBe("graph");
    expect(hasAppTool("read_neo4j_cypher")).toBe(false);
    expect(appToolNamespace("read_neo4j_cypher")).toBeNull();
  });

  it("advertises graph_me with NO credential/user field (#107 principle 1)", () => {
    const def = appToolDescriptions().find((t) => t.name === "graph_me");
    expect(def).toBeDefined();
    const schema = JSON.stringify(def!.inputSchema).toLowerCase();
    for (const forbidden of ["token", "credential", "secret", "userid", "user_id", "access"]) {
      expect(schema).not.toContain(forbidden);
    }
    expect(def!.inputSchema).toMatchObject({ type: "object", properties: {} });
  });
});

describe("runAppTool", () => {
  it("passes the request-scoped userId to the executor (not from args)", async () => {
    graphFetch.mockResolvedValue({ displayName: "Ada" });
    const res = await runAppTool("graph_me", { userId: "attacker-oid" });
    expect(res.success).toBe(true);
    // graphFetch receives the SCOPED user, ignoring the arg entirely.
    expect(graphFetch.mock.calls[0][0]).toBe("oid-1");
  });

  it("refuses when no user is in scope", async () => {
    getRequestUserId.mockReturnValue(null);
    const res = await runAppTool("graph_me", {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/authenticated user/i);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("returns a failed result (not a throw) when the tool errors", async () => {
    graphFetch.mockRejectedValue(new Error("sign in to connect Microsoft 365"));
    const res = await runAppTool("graph_me", {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sign in/i);
    expect(res.data).toBeNull();
  });

  it("reports unknown tool names", async () => {
    const res = await runAppTool("nope_not_here", {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown app tool/i);
  });

  it("supports registering additional tools (e.g. #109 vault tools)", async () => {
    registerAppTool({
      name: "test_echo",
      namespace: "test",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      execute: async (args, ctx) => ({ args, user: ctx.userId }),
    });
    const res = await runAppTool("test_echo", { a: 1 });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ args: { a: 1 }, user: "oid-1" });
  });

  it("passes the request-scoped sessionId to the executor (not from args)", async () => {
    registerAppTool({
      name: "test_ctx",
      namespace: "test",
      description: "ctx",
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => ({ ...ctx }),
    });
    getRequestSessionId.mockReturnValue("sess-real");
    const res = await runAppTool("test_ctx", { sessionId: "attacker-session" });
    expect(res.data).toEqual({ userId: "oid-1", sessionId: "sess-real" });
  });

  it("hands the executor sessionId: null when a user scope carries no session", async () => {
    registerAppTool({
      name: "test_ctx_null",
      namespace: "test",
      description: "ctx",
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => ({ ...ctx }),
    });
    // `runWithUserId` (background summarization, legacy call sites) — a user but
    // no conversation. Session-dependent tools must see null, not a guess.
    getRequestSessionId.mockReturnValue(null);
    const res = await runAppTool("test_ctx_null", {});
    expect(res.data).toEqual({ userId: "oid-1", sessionId: null });
  });
});

describe("graph_me result shaping", () => {
  it("selects only the advertised fields and null-normalizes", async () => {
    graphFetch.mockResolvedValue({
      displayName: "Ada Lovelace",
      mail: "ada@corp.com",
      jobTitle: "   ",
      id: "should-not-surface",
      "@odata.context": "should-not-surface",
    });
    const res = await runAppTool("graph_me", {});
    expect(res.data).toEqual({
      displayName: "Ada Lovelace",
      givenName: null,
      surname: null,
      userPrincipalName: null,
      mail: "ada@corp.com",
      jobTitle: null, // whitespace-only → null
      officeLocation: null,
      preferredLanguage: null,
    });
  });

  it("requests /me with an explicit $select and the User.Read scope", async () => {
    graphFetch.mockResolvedValue({});
    await runAppTool("graph_me", {});
    const [, path, init] = graphFetch.mock.calls[0] as [string, string, { scopes: string[] }];
    expect(path).toContain("/me?$select=");
    expect(path).toContain("displayName");
    expect(init.scopes).toEqual(["User.Read"]);
  });

  it("shapeMe tolerates null/garbage payloads", () => {
    expect(shapeMe(null).displayName).toBeNull();
    expect(shapeMe({ displayName: 42 }).displayName).toBeNull();
  });
});

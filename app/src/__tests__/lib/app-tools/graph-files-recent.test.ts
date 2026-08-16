/**
 * graph_files_recent — "the files I touched lately", from /me/insights/used.
 *
 * The gap this closes was measured, not guessed: with no recency tool, three
 * different model configurations degenerated on "list the last 10 files I
 * edited" into broad searches (`query: "a"`, 4,502 hits) — the same prompt
 * that produced every observed empty-completion failure. Insights is the
 * non-deprecated surface for exactly that question (`/me/drive/recent` dies
 * Nov 2026 and is deliberately not exposed).
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
const { GraphAuthRequiredError } = vi.hoisted(() => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {
    constructor(
      message: string,
      readonly userId: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = "GraphAuthRequiredError";
    }
  },
}));
vi.mock("../../../lib/auth/graph-token.server", () => ({
  graphFetch: (...a: unknown[]) => graphFetch(...a),
  GRAPH_BASE: "https://graph.microsoft.com/v1.0",
  DEFAULT_GRAPH_SCOPES: ["User.Read"],
  GraphAuthRequiredError,
}));

import { runAppTool, appToolDescriptions } from "../../../lib/app-tools/index.server";
import {
  shapeUsedInsight,
  type GraphRecentFilesResult,
} from "../../../lib/app-tools/graph.server";

/** One /me/insights/used row as Graph shapes it. */
function insight(
  title: string,
  refType = "microsoft.graph.driveItem",
  id = `drives/b!DRV/items/01ITEM-${title}`,
) {
  return {
    resourceVisualization: { title, type: "Word" },
    lastUsed: {
      lastAccessedDateTime: "2026-07-28T10:00:00Z",
      lastModifiedDateTime: "2026-07-27T09:00:00Z",
    },
    resourceReference: {
      webUrl: `https://contoso.sharepoint.com/x/${title}`,
      id,
      type: refType,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  graphFetch.mockResolvedValue({ value: [insight("a.docx"), insight("b.docx")] });
});

describe("advertisement", () => {
  it("takes only a limit — no query, no credential/user/session field", () => {
    const tool = appToolDescriptions().find((t) => t.name === "graph_files_recent")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
      "limit",
    ]);
    const schema = JSON.stringify(tool.inputSchema).toLowerCase();
    for (const banned of ["token", "credential", "secret", "userid", "user_id", "session", "oid"]) {
      expect(schema).not.toContain(banned);
    }
  });
});

describe("shapeUsedInsight", () => {
  it("parses the drive/item handoff pair out of resourceReference.id", () => {
    const row = shapeUsedInsight(insight("plan.docx"))!;
    expect(row).toEqual({
      name: "plan.docx",
      type: "Word",
      modified: "2026-07-27T09:00:00Z",
      accessed: "2026-07-28T10:00:00Z",
      drive_id: "b!DRV",
      item_id: "01ITEM-plan.docx",
      webUrl: "https://contoso.sharepoint.com/x/plan.docx",
    });
  });

  it("rejects non-driveItem rows (sites, whiteboard containers)", () => {
    expect(shapeUsedInsight(insight("Team Site", "microsoft.graph.site"))).toBeNull();
  });

  it("keeps a row whose id doesn't parse — name and dates still inform", () => {
    const row = shapeUsedInsight(insight("odd", "microsoft.graph.driveItem", "weird/id"))!;
    expect(row.name).toBe("odd");
    expect(row.drive_id).toBeNull();
    expect(row.item_id).toBeNull();
  });
});

describe("graph_files_recent", () => {
  it("inflates $top before the driveItem filter, then slices to limit", async () => {
    // $top applies to the MIXED insight stream (sites, whiteboards, files), so
    // asking for exactly `limit` rows could return fewer than `limit` files.
    graphFetch.mockResolvedValue({
      value: [insight("site!", "microsoft.graph.site"), insight("a"), insight("b"), insight("c")],
    });
    const res = await runAppTool("graph_files_recent", { limit: 2 });
    expect(res.success).toBe(true);
    const path = (graphFetch.mock.calls.at(-1) as [string, string])[1];
    expect(path).toBe("/me/insights/used?$top=4");
    const data = res.data as GraphRecentFilesResult;
    expect(data.items.map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("caps the inflated $top at 50", async () => {
    await runAppTool("graph_files_recent", { limit: 25 });
    expect((graphFetch.mock.calls.at(-1) as [string, string])[1]).toBe(
      "/me/insights/used?$top=50",
    );
  });

  it("degrades a 403 (insights disabled by policy) to a SUCCESSFUL steer toward search", async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError("denied", "oid-1", 403));
    const res = await runAppTool("graph_files_recent", {});
    expect(res.success).toBe(true);
    const data = res.data as GraphRecentFilesResult;
    expect(data.items).toEqual([]);
    expect(data.note).toMatch(/graph_files_search/);
    expect(data.note).toMatch(/sort="newest"/);
  });

  it("a 401 still fails — sign-in IS the fix there", async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError("expired", "oid-1", 401));
    const res = await runAppTool("graph_files_recent", {});
    expect(res.success).toBe(false);
  });
});

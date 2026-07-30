/**
 * graph_files_shared — "what was shared with me", from /me/insights/shared.
 *
 * Inbound only, by construction of the Office Graph: sharing is recorded on
 * the RECIPIENT's insights (measured live: 50 rows, 15 distinct sharers, zero
 * shared by the signed-in user). The tool's description says so explicitly —
 * "what did I share with X" is X's question to ask, and pretending otherwise
 * would produce confident undercounts.
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
  shapeSharedInsight,
  type GraphSharedFilesResult,
} from "../../../lib/app-tools/graph.server";

/** One /me/insights/shared row as Graph shapes it. */
function shared(
  title: string,
  by: string,
  refType = "microsoft.graph.driveItem",
  how = "Link",
) {
  return {
    resourceVisualization: { title },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(" ")[0].toLowerCase()}@dtsc.be` },
      sharedDateTime: "2026-07-30T08:00:00Z",
      sharingType: how,
    },
    resourceReference: {
      webUrl: `https://contoso.sharepoint.com/x/${encodeURIComponent(title)}`,
      id: refType === "microsoft.graph.driveItem" ? `drives/b!DRV/items/01-${title}` : undefined,
      type: refType,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  graphFetch.mockResolvedValue({
    value: [
      shared("plan.docx", "Quentin Delière"),
      shared("invoice.pdf", "Thibault Draye", "microsoft.graph.fileAttachment", "Attachment"),
      shared("mystery", "Denis Budin", "microsoft.graph.entity", "Direct"),
      shared("dpa.docx", "Thibault Draye"),
    ],
  });
});

describe("advertisement", () => {
  it("takes shared_by + limit and nothing else — no credential/user/session field", () => {
    const tool = appToolDescriptions().find((t) => t.name === "graph_files_shared")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
      "shared_by",
      "limit",
    ]);
    const schema = JSON.stringify(tool.inputSchema).toLowerCase();
    for (const banned of ["token", "credential", "secret", "userid", "user_id", "session", "oid"]) {
      expect(schema).not.toContain(banned);
    }
  });

  it("says plainly that it cannot answer the outbound direction", () => {
    const tool = appToolDescriptions().find((t) => t.name === "graph_files_shared")!;
    expect(tool.description).toMatch(/CANNOT list what the signed-in person shared/);
  });
});

describe("shapeSharedInsight", () => {
  it("a driveItem row is kind=file with the handoff pair", () => {
    expect(shapeSharedInsight(shared("plan.docx", "Quentin Delière"))).toEqual({
      name: "plan.docx",
      kind: "file",
      shared_by: "Quentin Delière",
      shared_when: "2026-07-30T08:00:00Z",
      how: "Link",
      drive_id: "b!DRV",
      item_id: "01-plan.docx",
      webUrl: "https://contoso.sharepoint.com/x/plan.docx",
    });
  });

  it("an email attachment is kind=attachment with null ids — it lives in a mailbox", () => {
    const row = shapeSharedInsight(
      shared("invoice.pdf", "Thibault Draye", "microsoft.graph.fileAttachment", "Attachment"),
    )!;
    expect(row.kind).toBe("attachment");
    expect(row.drive_id).toBeNull();
    expect(row.item_id).toBeNull();
    expect(row.how).toBe("Attachment");
  });

  it("bare entity rows are dropped — no title, no address, pure noise", () => {
    expect(shapeSharedInsight(shared("x", "y", "microsoft.graph.entity"))).toBeNull();
  });
});

describe("graph_files_shared", () => {
  it("returns files and attachments, entity rows filtered", async () => {
    const res = await runAppTool("graph_files_shared", {});
    expect(res.success).toBe(true);
    const data = res.data as GraphSharedFilesResult;
    expect(data.items.map((i) => i.name)).toEqual(["plan.docx", "invoice.pdf", "dpa.docx"]);
  });

  it("shared_by filters case-insensitively on a partial name, and inflates $top to 50", async () => {
    const res = await runAppTool("graph_files_shared", { shared_by: "thibault" });
    const data = res.data as GraphSharedFilesResult;
    expect(data.items.map((i) => i.name)).toEqual(["invoice.pdf", "dpa.docx"]);
    expect((graphFetch.mock.calls.at(-1) as [string, string])[1]).toBe(
      "/me/insights/shared?$top=50",
    );
  });

  it("a sharer that matches nothing returns a steering note, not a bare empty list", async () => {
    const res = await runAppTool("graph_files_shared", { shared_by: "Nobody Here" });
    const data = res.data as GraphSharedFilesResult;
    expect(data.items).toEqual([]);
    expect(data.note).toMatch(/Nobody Here/);
    expect(data.note).toMatch(/graph_files_search/);
  });

  it("degrades a 403 (insights disabled by policy) to a successful steer", async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError("denied", "oid-1", 403));
    const res = await runAppTool("graph_files_shared", {});
    expect(res.success).toBe(true);
    expect((res.data as GraphSharedFilesResult).note).toMatch(/graph_files_search/);
  });

  it("a 401 still fails toward sign-in", async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError("expired", "oid-1", 401));
    const res = await runAppTool("graph_files_shared", {});
    expect(res.success).toBe(false);
  });
});

/**
 * `graph_file_ingest` — the Microsoft Graph → Data Stash bridge (#110).
 *
 * Covers the contract the model and the stash both depend on: metadata before
 * download (so the size guard can refuse first), text vs. binary storage,
 * fire-and-forget ingest, a fail-closed refusal without a conversation in scope,
 * and no credential/session field in the advertised schema.
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

/** The store is mocked so the test never needs Redis; `MAX_CONTENT_BYTES` is
 *  re-declared at the real value so the size guard is exercised as shipped. */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const storeDocument = vi.fn();
vi.mock("../../../lib/document-store.server", () => ({
  MAX_CONTENT_BYTES,
  storeDocument: (...a: unknown[]) => storeDocument(...a),
}));

const ingestStashDocument = vi.fn<(sessionId: string, docId: string) => Promise<null>>(
  async () => null,
);
vi.mock("../../../lib/document-ingest.server", () => ({
  ingestStashDocument: (s: string, d: string) => ingestStashDocument(s, d),
}));

import { runAppTool, appToolDescriptions } from "../../../lib/app-tools/index.server";
import { driveItemPath, shapeDriveItem } from "../../../lib/app-tools/graph.server";

interface IngestResultShape {
  documentId: string;
  filename: string;
  mimeType: string;
  size: number;
  ingesting: boolean;
  webUrl: string | null;
}

/** Graph answers metadata first, then content — in that order. */
function graphAnswers(
  meta: Record<string, unknown>,
  content = Buffer.from("hello stash").toString("base64"),
) {
  graphFetch.mockReset();
  graphFetch.mockImplementation(async (_userId: string, path: string) =>
    path.endsWith("/content") ? content : meta,
  );
}

const FILE_META = {
  name: "notes.md",
  file: { mimeType: "text/markdown" },
  size: 11,
  webUrl: "https://contoso.sharepoint.com/notes.md",
};

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  storeDocument.mockImplementation(async (input: { content: string }) => ({
    ...input,
    id: "doc-1",
    size: Buffer.byteLength(input.content, "utf8"),
    uploadedAt: 1,
  }));
  ingestStashDocument.mockResolvedValue(null);
});

describe("advertisement", () => {
  it("registers graph_file_ingest with no credential/user/session field", () => {
    const def = appToolDescriptions().find((t) => t.name === "graph_file_ingest");
    expect(def).toBeDefined();
    const schema = JSON.stringify(def!.inputSchema).toLowerCase();
    for (const bad of [
      "token",
      "credential",
      "secret",
      "userid",
      "user_id",
      "session",
      "oid",
    ]) {
      expect(schema, `schema leaks ${bad}`).not.toContain(bad);
    }
    expect(def!.inputSchema).toMatchObject({ required: ["item_id"] });
  });
});

describe("driveItemPath", () => {
  it("defaults to the caller's own drive and encodes ids", () => {
    expect(driveItemPath("01ABC")).toBe("/me/drive/items/01ABC");
    expect(driveItemPath("a/../b")).toBe("/me/drive/items/a%2F..%2Fb");
  });

  it("targets a named drive when given one", () => {
    expect(driveItemPath("01ABC", "b!drive")).toBe("/drives/b!drive/items/01ABC");
  });
});

describe("shapeDriveItem", () => {
  it("reads name/mime/size/webUrl and flags files vs folders", () => {
    expect(shapeDriveItem(FILE_META)).toEqual({
      name: "notes.md",
      mimeType: "text/markdown",
      size: 11,
      webUrl: "https://contoso.sharepoint.com/notes.md",
      isFile: true,
    });
    expect(shapeDriveItem({ name: "Docs", folder: { childCount: 3 } }).isFile).toBe(false);
    expect(shapeDriveItem(null)).toMatchObject({ name: null, size: null, isFile: false });
  });
});

describe("happy path", () => {
  it("reads metadata with an explicit $select, then downloads as base64", async () => {
    graphAnswers(FILE_META);
    const res = await runAppTool("graph_file_ingest", { item_id: "01ABC" });
    expect(res.success).toBe(true);

    const [metaCall, contentCall] = graphFetch.mock.calls as Array<
      [string, string, { scopes?: string[]; responseType?: string }]
    >;
    expect(metaCall[0]).toBe("oid-1"); // scoped user, never an argument
    expect(metaCall[1]).toBe("/me/drive/items/01ABC?$select=name,file,size,webUrl");
    expect(metaCall[2].scopes).toEqual(["Files.Read.All"]);
    expect(metaCall[2].responseType).toBeUndefined();

    expect(contentCall[1]).toBe("/me/drive/items/01ABC/content");
    expect(contentCall[2].responseType).toBe("base64");
    expect(contentCall[2].scopes).toEqual(["Files.Read.All"]);
  });

  it("stores text formats as UTF-8 and fires the background ingest", async () => {
    graphAnswers(FILE_META);
    const res = await runAppTool("graph_file_ingest", { item_id: "01ABC" });

    expect(storeDocument).toHaveBeenCalledWith({
      sessionId: "sess-1", // from request scope
      filename: "notes.md",
      mimeType: "text/markdown",
      content: "hello stash", // decoded, not base64
      ingestStatus: "pending",
    });
    await vi.waitFor(() => expect(ingestStashDocument).toHaveBeenCalledWith("sess-1", "doc-1"));

    expect(res.data).toEqual<IngestResultShape>({
      documentId: "doc-1",
      filename: "notes.md",
      mimeType: "text/markdown",
      size: 11,
      ingesting: true,
      webUrl: "https://contoso.sharepoint.com/notes.md",
    });
    // The bytes never travel back to the model.
    expect(JSON.stringify(res.data)).not.toContain("hello stash");
  });

  it("keeps a non-convertible binary as base64 and does NOT ingest it", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    graphAnswers({ name: "chart.png", file: { mimeType: "image/png" }, size: 4 }, png);

    const res = await runAppTool("graph_file_ingest", { item_id: "01PNG" });
    expect(storeDocument).toHaveBeenCalledWith({
      sessionId: "sess-1",
      filename: "chart.png",
      mimeType: "image/png",
      content: png,
      encoding: "base64",
    });
    // Ingest would only mark it 'failed' (no converter for images).
    expect(ingestStashDocument).not.toHaveBeenCalled();
    expect((res.data as IngestResultShape).ingesting).toBe(false);
  });

  it("ingests a convertible binary (docx) when the converter is enabled", async () => {
    vi.stubEnv("STASH_CONVERT_DOCS", "1");
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04]) /* "PK" + zip magic */.toString("base64");
    graphAnswers(
      {
        name: "spec.docx",
        file: {
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        size: 4,
      },
      docx,
    );

    const res = await runAppTool("graph_file_ingest", { item_id: "01DOCX" });
    expect(storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: "base64", ingestStatus: "pending" }),
    );
    await vi.waitFor(() => expect(ingestStashDocument).toHaveBeenCalledWith("sess-1", "doc-1"));
    expect((res.data as IngestResultShape).ingesting).toBe(true);
    vi.unstubAllEnvs();
  });

  it("honours a drive_id and a filename override, and falls back on a missing MIME", async () => {
    graphAnswers({ name: "raw", file: {}, size: 11 });
    const res = await runAppTool("graph_file_ingest", {
      item_id: "01ABC",
      drive_id: "drive-9",
      filename: "renamed.csv",
    });
    expect(graphFetch.mock.calls[0][1]).toContain("/drives/drive-9/items/01ABC");
    expect((res.data as IngestResultShape).filename).toBe("renamed.csv");
    // No file.mimeType → guessed from the (overridden) filename.
    expect((res.data as IngestResultShape).mimeType).toBe("text/csv");
  });
});

describe("refusals", () => {
  it("fails closed with no conversation in scope, before touching Graph", async () => {
    getRequestSessionId.mockReturnValue(null);
    graphAnswers(FILE_META);
    const res = await runAppTool("graph_file_ingest", { item_id: "01ABC" });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/conversation/i);
    expect(graphFetch).not.toHaveBeenCalled();
    expect(storeDocument).not.toHaveBeenCalled();
  });

  it("rejects an oversized file without downloading it", async () => {
    graphAnswers({ ...FILE_META, name: "huge.csv", size: MAX_CONTENT_BYTES + 1 });
    const res = await runAppTool("graph_file_ingest", { item_id: "01BIG" });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/above the Data Stash limit/i);
    // Metadata only — the content call never happened.
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(storeDocument).not.toHaveBeenCalled();
  });

  it("accepts a file exactly at the limit", async () => {
    graphAnswers({ ...FILE_META, size: MAX_CONTENT_BYTES });
    const res = await runAppTool("graph_file_ingest", { item_id: "01EDGE" });
    expect(res.success).toBe(true);
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });

  it("proceeds when Graph reports no size (the store re-checks the limit)", async () => {
    graphAnswers({ name: "notes.md", file: { mimeType: "text/markdown" } });
    const res = await runAppTool("graph_file_ingest", { item_id: "01NOSIZE" });
    expect(res.success).toBe(true);
    expect(storeDocument).toHaveBeenCalled();
  });

  it("refuses a folder (no file facet) instead of downloading nothing", async () => {
    graphAnswers({ name: "Reports", folder: { childCount: 2 } });
    const res = await runAppTool("graph_file_ingest", { item_id: "01FOLDER" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no file content|folder/i);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it("requires item_id", async () => {
    const res = await runAppTool("graph_file_ingest", { item_id: "  " });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/item_id is required/i);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("surfaces a sign-in-needed failure as a failed result, not a throw", async () => {
    graphFetch.mockReset();
    graphFetch.mockRejectedValue(new Error("sign in to connect Microsoft 365"));
    const res = await runAppTool("graph_file_ingest", { item_id: "01ABC" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sign in/i);
    expect(res.data).toBeNull();
  });

  it("reports a content response that isn't bytes", async () => {
    graphFetch.mockReset();
    graphFetch.mockImplementation(async (_u: string, path: string) =>
      path.endsWith("/content") ? null : FILE_META,
    );
    const res = await runAppTool("graph_file_ingest", { item_id: "01ABC" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no content/i);
    expect(storeDocument).not.toHaveBeenCalled();
  });
});

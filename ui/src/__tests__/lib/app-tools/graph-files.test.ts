/**
 * `graph_files_search` + `graph_files_list` — finding a Microsoft 365 file (#110).
 *
 * Two contracts are load-bearing here and both are asserted rather than assumed:
 *
 * 1. **The app owns the query language.** The model passes structured arguments;
 *    every KQL clause is composed server-side. So the tests feed hostile values
 *    (quotes, `filetype:` restrictions, boolean operators, control characters) and
 *    assert the composed query still has exactly the structure *we* put there.
 * 2. **The flattened shape is the handoff.** `drive_id` + `item_id` are what
 *    `graph_file_ingest` takes, so they must survive Graph's nesting, a missing
 *    `resource`, and a OneDrive shortcut stub — and `item_id` must never be the
 *    parent folder's id.
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
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {
    constructor(message: string, readonly userId: string, readonly status?: number) {
      super(message);
      this.name = "GraphAuthRequiredError";
    }
  },
  graphFetch: (...a: unknown[]) => graphFetch(...a),
  GRAPH_BASE: "https://graph.microsoft.com/v1.0",
  DEFAULT_GRAPH_SCOPES: ["User.Read"],
}));

import { runAppTool, appToolDescriptions } from "../../../lib/app-tools/index.server";
import {
  composeFileQuery,
  kqlTerms,
  kqlUrlPhrase,
  kqlFileType,
  cleanSummary,
  drivePath,
  siteHost,
  shapeFileRef,
  shapeSearchHits,
  shapeFileEntries,
  type GraphFileHit,
  type GraphFileEntry,
  type GraphFileSearchResult,
  type GraphFileListResult,
} from "../../../lib/app-tools/graph.server";

/** Last graphFetch call as [userId, path, init]. */
function lastCall() {
  return graphFetch.mock.calls.at(-1) as [
    string,
    string,
    {
      method?: string;
      scopes?: string[];
      body?: { requests?: Array<Record<string, unknown>> };
    },
  ];
}

/** The single search request Graph was asked to run. */
function searchRequest(): Record<string, unknown> {
  const [, , init] = lastCall();
  return init.body!.requests![0];
}

/** The KQL string the app composed for the last search call. */
function sentQuery(): string {
  return (searchRequest().query as { queryString: string }).queryString;
}

/** One fully-populated driveItem search hit, as Graph nests it. */
const HIT = {
  hitId: "01HITID",
  rank: 1,
  summary: "the <c0>quarterly</c0> <c1>budget</c1> was signed off<ddd/>",
  resource: {
    id: "01ITEMID",
    name: "Q3 Budget.xlsx",
    size: 20480,
    webUrl: "https://contoso.sharepoint.com/sites/Finance/Q3%20Budget.xlsx",
    lastModifiedDateTime: "2026-07-20T10:00:00Z",
    file: { mimeType: "application/vnd.ms-excel" },
    parentReference: {
      driveId: "b!DRIVE",
      // Deliberately different from resource.id: this is the *folder*.
      id: "01PARENTFOLDER",
      path: "/drives/b!DRIVE/root:/Finance/Q3%20Reports",
      siteId: "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
    },
  },
};

function searchResponse(hits: unknown[], total: number | null = hits.length) {
  return {
    value: [
      {
        hitsContainers: [{ hits, ...(total == null ? {} : { total }) }],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  graphFetch.mockResolvedValue(searchResponse([]));
});

// ============================================================================
// Advertisement
// ============================================================================

describe("advertisement", () => {
  it("registers both file tools with no credential/user/session field", () => {
    const defs = appToolDescriptions().filter((t) =>
      ["graph_files_search", "graph_files_list"].includes(t.name),
    );
    expect(defs).toHaveLength(2);

    for (const def of defs) {
      const schema = JSON.stringify(def.inputSchema).toLowerCase();
      for (const bad of [
        "token",
        "credential",
        "secret",
        "userid",
        "user_id",
        "session",
        "oid",
      ]) {
        expect(schema, `${def.name} leaks ${bad}`).not.toContain(bad);
      }
      expect(def.inputSchema).toMatchObject({ additionalProperties: false });
    }
  });

  it("asks for a query and nothing else, and never advertises KQL", () => {
    const search = appToolDescriptions().find((t) => t.name === "graph_files_search")!;
    expect(search.inputSchema).toMatchObject({ required: ["query"] });
    expect(Object.keys((search.inputSchema as { properties: object }).properties)).toEqual([
      "query",
      "site",
      "file_type",
      "limit",
    ]);
    // The model must not be invited to write query syntax.
    expect(search.description?.toLowerCase()).not.toContain("kql");
  });

  it("leaves every graph_files_list argument optional (no args = OneDrive root)", () => {
    const list = appToolDescriptions().find((t) => t.name === "graph_files_list")!;
    expect(list.inputSchema).not.toHaveProperty("required");
    expect(Object.keys((list.inputSchema as { properties: object }).properties)).toEqual([
      "folder_item_id",
      "drive_id",
      "limit",
    ]);
    // The deprecated /me/drive/recent surface is deliberately not exposed.
    expect(JSON.stringify(list.inputSchema)).not.toContain("recent");
  });
});

// ============================================================================
// KQL composition — one clause per argument, and only ours
// ============================================================================

describe("composeFileQuery", () => {
  it("passes plain terms straight through", () => {
    expect(composeFileQuery({ query: "quarterly budget" })).toBe("quarterly budget");
  });

  it("adds filetype: for file_type", () => {
    expect(composeFileQuery({ query: "budget", fileType: "docx" })).toBe(
      "budget filetype:docx",
    );
  });

  it("adds path: for site, quoted because the value is a URL", () => {
    expect(
      composeFileQuery({ query: "budget", site: "https://contoso.sharepoint.com/sites/Finance" }),
    ).toBe('budget path:"https://contoso.sharepoint.com/sites/Finance"');
  });

  it("combines all three, terms first", () => {
    expect(
      composeFileQuery({
        query: "q3 budget",
        site: "https://contoso.sharepoint.com/sites/Finance",
        fileType: ".XLSX",
      }),
    ).toBe(
      'q3 budget filetype:xlsx path:"https://contoso.sharepoint.com/sites/Finance"',
    );
  });

  it("drops a filter that reduces to nothing rather than emitting a bare clause", () => {
    expect(composeFileQuery({ query: "budget", fileType: "  " })).toBe("budget");
    expect(composeFileQuery({ query: "budget", fileType: "!!!" })).toBe("budget");
    expect(composeFileQuery({ query: "budget", site: "   " })).toBe("budget");
  });

  it("returns an empty string when nothing searchable survives", () => {
    expect(composeFileQuery({ query: "" })).toBe("");
    expect(composeFileQuery({ query: '"" (:)' })).toBe("");
  });
});

describe("hostile input cannot restructure the query", () => {
  // A model (or a filename it echoed back) trying to bolt its own restrictions
  // onto ours: quotes to escape the phrase, a second filetype:, booleans, a
  // grouped clause and a size comparison.
  const HOSTILE = 'budget" OR filetype:exe OR (path:"https://evil.example" AND size>0) NOT';

  it("strips the operators out of free text instead of honouring them", () => {
    const kql = composeFileQuery({ query: HOSTILE });
    expect(kql).toBe(
      "budget or filetype exe or path https //evil.example and size 0 not",
    );
    // No quote to close, no colon to bind, no parenthesis to group.
    expect(kql).not.toContain('"');
    expect(kql).not.toContain(":");
    expect(kql).not.toMatch(/[()<>=]/);
  });

  it("leaves exactly one filetype: clause — the one we composed", () => {
    const kql = composeFileQuery({ query: HOSTILE, fileType: "pdf" });
    expect(kql.match(/filetype:/g)).toHaveLength(1);
    expect(kql.endsWith("filetype:pdf")).toBe(true);
  });

  it("leaves exactly one path: clause, with the attempt trapped inside its quotes", () => {
    const kql = composeFileQuery({
      query: HOSTILE,
      site: 'https://contoso.sharepoint.com" OR path:"https://evil.example',
    });
    // Exactly two quotes — the pair kqlPhrase added — so everything between them
    // is one value. A second restriction would need a quote of its own to close.
    expect(kql.match(/"/g)).toHaveLength(2);
    expect(kql.match(/path:"/g)).toHaveLength(1);
    // The injected `path:` survives as literal text *inside* the phrase, where
    // KQL reads it as part of the value rather than as a property restriction.
    expect(kql).toContain(
      'path:"https://contoso.sharepoint.comORpath:https://evil.example"',
    );
    expect(kql.endsWith('"')).toBe(true);
  });

  it("takes only the leading alphanumeric run of a hostile file_type", () => {
    expect(kqlFileType('docx" OR filetype:exe')).toBe("filetype:docx");
    expect(kqlFileType("../../etc/passwd")).toBe("filetype:etc");
    expect(kqlFileType("PDF")).toBe("filetype:pdf");
    expect(kqlFileType("...")).toBeNull();
  });

  it("removes control characters, which would otherwise split the request line", () => {
    const nasty = `bud${String.fromCharCode(0)}get${String.fromCharCode(10)}filetype${String.fromCharCode(58)}exe${String.fromCharCode(127)}`;
    expect(kqlTerms(nasty)).toBe("bud get filetype exe");
    // A quoted URL keeps its colon (literal inside quotes, and a URL needs one)
    // and closes up entirely — a restriction must not contain whitespace.
    expect(kqlUrlPhrase(nasty)).toBe('"budgetfiletype:exe"');
  });

  it("keeps caller whitespace out of a filter clause (a space silently widens it)", () => {
    // A space between `path:` and its value makes Search treat the rest as free
    // text, so a padded/spaced site URL is closed up rather than passed on.
    const kql = composeFileQuery({ query: "x", site: "  https://contoso.sharepoint.com/sites/A B  " });
    expect(kql).toBe('x path:"https://contoso.sharepoint.com/sites/AB"');
    expect(kql).not.toMatch(/path:\s/);
  });

  it("lowercases KQL's uppercase-only keywords, keeping the words", () => {
    expect(kqlTerms("cats AND dogs NOT birds")).toBe("cats and dogs not birds");
    // Lower case was never an operator, so it is left exactly as written.
    expect(kqlTerms("cats and dogs")).toBe("cats and dogs");
  });
});

// ============================================================================
// graph_files_search
// ============================================================================

describe("graph_files_search", () => {
  it("POSTs a driveItem search with the composed query and both file scopes", async () => {
    const res = await runAppTool("graph_files_search", { query: "quarterly budget" });
    expect(res.success).toBe(true);

    const [userId, path, init] = lastCall();
    expect(userId).toBe("oid-1"); // request-scoped, never an argument
    expect(path).toBe("/search/query");
    expect(init.method).toBe("POST");
    expect(init.scopes).toEqual(["Files.Read.All", "Sites.Read.All"]);

    expect(searchRequest()).toMatchObject({
      entityTypes: ["driveItem"],
      query: { queryString: "quarterly budget" },
      from: 0,
      size: 10,
    });
  });

  it("sends no `fields` — it would replace the resource and drop parentReference", async () => {
    await runAppTool("graph_files_search", { query: "x" });
    // `fields` is not `$select`: naming any field removes the rest, and losing
    // parentReference loses drive_id — the handoff this tool exists to produce.
    expect(searchRequest()).not.toHaveProperty("fields");
  });

  it("clamps limit into 1..25", async () => {
    await runAppTool("graph_files_search", { query: "x", limit: 999 });
    expect(searchRequest().size).toBe(25);
    await runAppTool("graph_files_search", { query: "x", limit: 0 });
    expect(searchRequest().size).toBe(10); // 0 is falsy → default
    await runAppTool("graph_files_search", { query: "x", limit: -5 });
    expect(searchRequest().size).toBe(1);
    await runAppTool("graph_files_search", { query: "x", limit: "junk" });
    expect(searchRequest().size).toBe(10);
  });

  it("refuses before calling Graph when nothing searchable was given", async () => {
    for (const args of [{}, { query: "   " }, { query: '":()' }]) {
      const res = await runAppTool("graph_files_search", args);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/query is required/i);
    }
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("flattens a hit to the shape the ingest handoff needs", async () => {
    graphFetch.mockResolvedValue(searchResponse([HIT], 42));
    const res = await runAppTool("graph_files_search", { query: "budget" });

    expect(res.data).toEqual<GraphFileSearchResult>({
      query: "budget", // the KQL actually run, echoed back
      total: 42,
      results: [
        {
          name: "Q3 Budget.xlsx",
          path: "Finance/Q3 Reports",
          site: "contoso.sharepoint.com",
          modified: "2026-07-20T10:00:00Z",
          size: 20480,
          snippet: "the quarterly budget was signed off…",
          drive_id: "b!DRIVE",
          item_id: "01ITEMID",
          webUrl: "https://contoso.sharepoint.com/sites/Finance/Q3%20Budget.xlsx",
        },
      ],
    });
  });

  it("reports the composed query, not the raw argument", async () => {
    const res = await runAppTool("graph_files_search", {
      query: "budget",
      file_type: "pdf",
    });
    expect((res.data as GraphFileSearchResult).query).toBe("budget filetype:pdf");
  });
});

describe("shapeSearchHits", () => {
  it("uses the item's own id, never its parent folder's", () => {
    const [hit] = shapeSearchHits(searchResponse([HIT])).results;
    expect(hit.item_id).toBe("01ITEMID");
    expect(hit.item_id).not.toBe("01PARENTFOLDER");
  });

  it("falls back to hitId when a hit came back without its resource", () => {
    const [hit] = shapeSearchHits(searchResponse([{ hitId: "01BARE" }])).results;
    expect(hit.item_id).toBe("01BARE");
    expect(hit.name).toBeNull();
    expect(hit.drive_id).toBeNull();
  });

  it("sums totals across containers and stays null when none reported one", () => {
    expect(shapeSearchHits(searchResponse([HIT], null)).total).toBeNull();
    const twoContainers = {
      value: [{ hitsContainers: [{ hits: [HIT], total: 3 }, { hits: [], total: 4 }] }],
    };
    expect(shapeSearchHits(twoContainers).total).toBe(7);
  });

  it("tolerates missing and garbage payloads instead of throwing", () => {
    expect(shapeSearchHits(null)).toEqual({ total: null, results: [] });
    expect(shapeSearchHits({})).toEqual({ total: null, results: [] });
    expect(shapeSearchHits({ value: "nope" })).toEqual({ total: null, results: [] });
    expect(shapeSearchHits({ value: [{}] })).toEqual({ total: null, results: [] });
    expect(shapeSearchHits({ value: [{ hitsContainers: [{ hits: "nope" }] }] })).toEqual({
      total: null,
      results: [],
    });

    const [hit] = shapeSearchHits(searchResponse([null, {}])).results;
    expect(hit).toEqual<GraphFileHit>({
      name: null,
      path: null,
      site: null,
      modified: null,
      size: null,
      snippet: null,
      drive_id: null,
      item_id: null,
      webUrl: null,
    });
  });

  it("ignores a numeric-looking total that isn't a number", () => {
    const bad = { value: [{ hitsContainers: [{ hits: [], total: "12" }] }] };
    expect(shapeSearchHits(bad).total).toBeNull();
  });
});

describe("cleanSummary", () => {
  it("strips every <cN> highlight marker, however high N goes", () => {
    expect(cleanSummary("<c0>a</c0> and <c1>b</c1> and <c12>c</c12>")).toBe(
      "a and b and c",
    );
  });

  it("turns Search's <ddd/> elision marker into an ellipsis", () => {
    expect(cleanSummary("start<ddd/>end")).toBe("start…end");
  });

  it("truncates to 300 chars, the same budget as a mail preview", () => {
    const long = cleanSummary(`<c0>${"x".repeat(1000)}</c0>`);
    expect(long).toHaveLength(300);
  });

  it("collapses whitespace and nulls out empties and non-strings", () => {
    expect(cleanSummary(" a \n  b ")).toBe("a b");
    expect(cleanSummary("<c0></c0>")).toBeNull();
    expect(cleanSummary(null)).toBeNull();
    expect(cleanSummary(42)).toBeNull();
  });
});

describe("drivePath", () => {
  it("decodes a drive-relative path and drops the addressing prefix", () => {
    expect(drivePath("/drive/root:/Reports/Q3%20Plans")).toBe("Reports/Q3 Plans");
    expect(drivePath("/drives/b!ABC/root:/Finance")).toBe("Finance");
  });

  it("reports a drive-root item as /", () => {
    expect(drivePath("/drive/root:")).toBe("/");
    expect(drivePath("/drives/b!ABC/root:/")).toBe("/");
  });

  it("keeps a malformed escape rather than failing the whole result", () => {
    expect(drivePath("/drive/root:/bad%zz")).toBe("bad%zz");
  });

  it("passes through a path with no root: marker, and nulls out non-strings", () => {
    expect(drivePath("Shared Documents")).toBe("Shared Documents");
    expect(drivePath(null)).toBeNull();
    expect(drivePath("   ")).toBeNull();
    expect(drivePath(42)).toBeNull();
  });
});

describe("siteHost", () => {
  it("keeps the hostname and drops the site/web guids", () => {
    expect(siteHost("contoso.sharepoint.com,1111,2222")).toBe("contoso.sharepoint.com");
  });

  it("passes through an id with no hostname, and nulls out non-strings", () => {
    expect(siteHost("1111")).toBe("1111");
    expect(siteHost(null)).toBeNull();
    expect(siteHost("  ")).toBeNull();
  });
});

// ============================================================================
// graph_files_list
// ============================================================================

describe("graph_files_list", () => {
  beforeEach(() => {
    graphFetch.mockResolvedValue({ value: [] });
  });

  it("lists the OneDrive root with an explicit $select when given no arguments", async () => {
    const res = await runAppTool("graph_files_list", {});
    expect(res.success).toBe(true);
    expect((res.data as GraphFileListResult).location).toBe("onedrive-root");

    const [userId, path, init] = lastCall();
    expect(userId).toBe("oid-1");
    expect(path).toBe(
      "/me/drive/root/children?$select=id,name,file,folder,size,webUrl," +
        "lastModifiedDateTime,parentReference,remoteItem&$top=20",
    );
    expect(init.scopes).toEqual(["Files.Read.All"]);
    expect(init.method).toBeUndefined(); // a GET
  });

  it("lists a folder's children, in the caller's own drive by default", async () => {
    const res = await runAppTool("graph_files_list", { folder_item_id: "01FOLDER" });
    expect((res.data as GraphFileListResult).location).toBe("folder");
    expect(lastCall()[1]).toContain("/me/drive/items/01FOLDER/children?$select=");
  });

  it("targets a named drive and encodes a crafted folder id", async () => {
    await runAppTool("graph_files_list", {
      folder_item_id: "a/../b",
      drive_id: "b!DRIVE",
    });
    expect(lastCall()[1]).toContain("/drives/b!DRIVE/items/a%2F..%2Fb/children");
  });

  it("clamps limit into 1..50", async () => {
    await runAppTool("graph_files_list", { limit: 999 });
    expect(lastCall()[1]).toContain("$top=50");
    await runAppTool("graph_files_list", { limit: 0 });
    expect(lastCall()[1]).toContain("$top=20"); // 0 is falsy → default
    await runAppTool("graph_files_list", { limit: -5 });
    expect(lastCall()[1]).toContain("$top=1");
  });

  it("never reaches the deprecated /me/drive/recent, even if asked to", async () => {
    // The argument doesn't exist; passing it must not change the location.
    const res = await runAppTool("graph_files_list", { recent: true });
    expect((res.data as GraphFileListResult).location).toBe("onedrive-root");
    expect(lastCall()[1]).not.toContain("recent?");
    expect(lastCall()[1]).toContain("/me/drive/root/children");
  });

  it("flags folders with a child count and files without one", async () => {
    graphFetch.mockResolvedValue({
      value: [
        {
          id: "01F",
          name: "Reports",
          folder: { childCount: 3 },
          parentReference: { driveId: "b!D", path: "/drive/root:" },
        },
        {
          id: "01X",
          name: "notes.md",
          file: { mimeType: "text/markdown" },
          size: 12,
          lastModifiedDateTime: "2026-07-01T00:00:00Z",
          webUrl: "https://contoso-my.sharepoint.com/notes.md",
          parentReference: { driveId: "b!D", path: "/drive/root:/Inbox" },
        },
      ],
    });
    const items = (await runAppTool("graph_files_list", {})).data as GraphFileListResult;

    expect(items.items[0]).toEqual<GraphFileEntry>({
      name: "Reports",
      path: "/",
      site: null,
      modified: null,
      size: null,
      drive_id: "b!D",
      item_id: "01F",
      webUrl: null,
      isFolder: true,
      child_count: 3,
    });
    expect(items.items[1]).toMatchObject({
      name: "notes.md",
      path: "Inbox",
      isFolder: false,
      child_count: null,
    });
  });

  it("reports an empty folder as 0 children, not as a file", () => {
    const [entry] = shapeFileEntries({ value: [{ folder: {} }] });
    expect(entry.isFolder).toBe(true);
    expect(entry.child_count).toBeNull();
    const [counted] = shapeFileEntries({ value: [{ folder: { childCount: 0 } }] });
    expect(counted.child_count).toBe(0);
  });

  it("unwraps a shortcut stub so the ids address the real file", () => {
    const [entry] = shapeFileEntries({
      value: [
        {
          id: "01SHORTCUT",
          name: "Shared Finance",
          parentReference: { driveId: "b!MYDRIVE", path: "/drive/root:" },
          remoteItem: {
            id: "01REALITEM",
            name: "Finance",
            folder: { childCount: 9 },
            parentReference: {
              driveId: "b!OTHERDRIVE",
              path: "/drives/b!OTHERDRIVE/root:/Sites",
              siteId: "contoso.sharepoint.com,1111,2222",
            },
          },
        },
      ],
    });
    expect(entry).toMatchObject({
      item_id: "01REALITEM",
      drive_id: "b!OTHERDRIVE",
      site: "contoso.sharepoint.com",
      path: "Sites",
      isFolder: true,
      child_count: 9,
    });
  });

  it("tolerates missing and garbage payloads", () => {
    expect(shapeFileEntries(null)).toEqual([]);
    expect(shapeFileEntries({ value: "nope" })).toEqual([]);
    expect(shapeFileEntries({ value: [null] })[0]).toMatchObject({
      name: null,
      item_id: null,
      isFolder: false,
      child_count: null,
    });
    expect(shapeFileEntries({ value: [{ folder: "nope" }] })[0].isFolder).toBe(false);
  });

  it("surfaces a sign-in-needed failure as a failed result, not a throw", async () => {
    graphFetch.mockRejectedValue(new Error("sign in to connect Microsoft 365"));
    const res = await runAppTool("graph_files_list", {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sign in/i);
    expect(res.data).toBeNull();
  });
});

describe("shapeFileRef", () => {
  it("reuses the ingest tool's field extraction for name/size/webUrl", () => {
    expect(shapeFileRef(HIT.resource)).toMatchObject({
      name: "Q3 Budget.xlsx",
      size: 20480,
      webUrl: HIT.resource.webUrl,
    });
  });

  it("returns an all-null ref for junk rather than throwing", () => {
    expect(shapeFileRef(undefined)).toEqual({
      name: null,
      path: null,
      site: null,
      modified: null,
      size: null,
      drive_id: null,
      item_id: null,
      webUrl: null,
    });
    expect(shapeFileRef({ size: "big", id: 42 })).toMatchObject({
      size: null,
      item_id: null,
    });
  });
});

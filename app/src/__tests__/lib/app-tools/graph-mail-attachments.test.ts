/**
 * graph_mail_attachments — "what files did I send X / did X send me", from the
 * mailbox.
 *
 * This is the honest approximation for outbound sharing: the Office Graph
 * records shares on the recipient's side only, so the sender's best delegated
 * record is their own sent mail. The tool name and description say "mail
 * attachments", not "shares" — OneDrive Share-dialog shares never pass through
 * Sent Items, and a tool named "shares" would relay confident undercounts.
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

import { runAppTool, appToolDescriptions } from "../../../lib/app-tools/index.server";
import { type GraphMailAttachmentsResult } from "../../../lib/app-tools/graph.server";

function message(
  subject: string,
  to: Array<{ name: string; address: string }>,
  fromName = "Michael Accetto",
  attachments: Array<{ name: string; size?: number }> = [{ name: `${subject}.pdf`, size: 100 }],
) {
  return {
    subject,
    toRecipients: to.map((t) => ({ emailAddress: t })),
    from: { emailAddress: { name: fromName, address: "michael.accetto@dtsc.be" } },
    sentDateTime: "2026-07-09T09:00:00Z",
    receivedDateTime: "2026-07-09T09:00:01Z",
    webLink: "https://outlook.office365.com/owa/?ItemID=abc",
    attachments: attachments.map((a) => ({ name: a.name, size: a.size ?? 1, contentType: "application/pdf" })),
  };
}

const THIBAULT = { name: "Thibault Draye", address: "thibault.draye@dtsc.be" };
const MARCO = { name: "Marco Di Gennaro", address: "marco@dtsc.be" };

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  graphFetch.mockResolvedValue({
    value: [
      message("Co-Working booking", [THIBAULT]),
      message("CORTEX draft", [MARCO]),
      message("Joint review", [MARCO, THIBAULT]),
    ],
  });
});

function lastPath(): string {
  return (graphFetch.mock.calls.at(-1) as [string, string])[1];
}

describe("advertisement", () => {
  it("takes person/direction/since/limit — no credential/user/session field", () => {
    const tool = appToolDescriptions().find((t) => t.name === "graph_mail_attachments")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
      "person",
      "direction",
      "since",
      "limit",
    ]);
    const schema = JSON.stringify(tool.inputSchema).toLowerCase();
    for (const banned of ["token", "credential", "secret", "userid", "user_id", "session", "oid"]) {
      expect(schema).not.toContain(banned);
    }
  });

  it("is honest about coverage: email only, Share-dialog shares invisible", () => {
    const tool = appToolDescriptions().find((t) => t.name === "graph_mail_attachments")!;
    expect(tool.description).toMatch(/do not appear in\s+sent mail/i);
  });
});

describe("graph_mail_attachments", () => {
  it("defaults to sent items, expands attachment names WITHOUT content bytes", async () => {
    const res = await runAppTool("graph_mail_attachments", {});
    expect(res.success).toBe(true);
    expect(lastPath()).toContain("/me/mailFolders/sentitems/messages");
    expect(lastPath()).toContain("$expand=attachments($select=name,size,contentType)");
    expect(lastPath()).not.toContain("contentBytes");
    const data = res.data as GraphMailAttachmentsResult;
    expect(data.direction).toBe("sent");
    expect(data.messages[0].attachments[0].name).toBe("Co-Working booking.pdf");
  });

  it("direction=received reads the inbox and reports the sender as `with`", async () => {
    graphFetch.mockResolvedValue({
      value: [message("Invoice", [{ name: "Me", address: "me@dtsc.be" }], "Thibault Draye")],
    });
    const res = await runAppTool("graph_mail_attachments", { direction: "received" });
    expect(lastPath()).toContain("/me/mailFolders/inbox/messages");
    const data = res.data as GraphMailAttachmentsResult;
    expect(data.messages[0].with).toEqual(["Thibault Draye"]);
  });

  it("person filters sent mail by recipient — first name, any position in the To line", async () => {
    const res = await runAppTool("graph_mail_attachments", { person: "thibault" });
    const data = res.data as GraphMailAttachmentsResult;
    expect(data.messages.map((m) => m.subject)).toEqual(["Co-Working booking", "Joint review"]);
    // App-side filtering inflates the request window.
    expect(lastPath()).toContain("$top=50");
  });

  it("since composes a canonical date filter; garbage throws instead of widening", async () => {
    await runAppTool("graph_mail_attachments", { since: "2026-07-01" });
    expect(lastPath()).toContain(
      "$filter=hasAttachments eq true and receivedDateTime ge 2026-07-01T00:00:00Z",
    );

    graphFetch.mockClear();
    const res = await runAppTool("graph_mail_attachments", { since: "last month" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/since must be a date/);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("drops messages whose attachments turn out empty (inline-image false positives)", async () => {
    graphFetch.mockResolvedValue({
      value: [message("Signature only", [THIBAULT], "Michael Accetto", [])],
    });
    const res = await runAppTool("graph_mail_attachments", {});
    expect((res.data as GraphMailAttachmentsResult).messages).toEqual([]);
  });
});

/**
 * Calendar + mail connector tools (#110).
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

import { runAppTool, appToolDescriptions } from "../../../lib/app-tools/index.server";
import {
  shapeEvents,
  shapeMessages,
  localDayBounds,
} from "../../../lib/app-tools/graph.server";

/** Last graphFetch call as [userId, path, init]. */
function lastCall() {
  return graphFetch.mock.calls.at(-1) as [
    string,
    string,
    { scopes?: string[]; headers?: Record<string, string> },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequestUserId.mockReturnValue("oid-1");
  getRequestSessionId.mockReturnValue("sess-1");
  graphFetch.mockResolvedValue({ value: [] });
});

describe("tool advertisement", () => {
  it("registers both connectors with no credential field", () => {
    const names = appToolDescriptions().map((t) => t.name);
    expect(names).toContain("graph_calendar_today");
    expect(names).toContain("graph_mail_recent");

    for (const t of appToolDescriptions()) {
      const schema = JSON.stringify(t.inputSchema).toLowerCase();
      for (const bad of ["token", "credential", "secret", "userid", "user_id"]) {
        expect(schema, `${t.name} leaks ${bad}`).not.toContain(bad);
      }
    }
  });
});

describe("localDayBounds", () => {
  it("returns naive local ISO bounds for the day (no Z — Graph applies Prefer tz)", () => {
    const { start, end } = localDayBounds(new Date(2026, 6, 27, 15, 30));
    expect(start).toBe("2026-07-27T00:00:00");
    expect(end).toBe("2026-07-27T23:59:59");
    expect(start.endsWith("Z")).toBe(false);
  });

  it("applies a day offset, crossing month boundaries", () => {
    expect(localDayBounds(new Date(2026, 6, 31, 12, 0), 1).start).toBe("2026-08-01T00:00:00");
    expect(localDayBounds(new Date(2026, 7, 1, 12, 0), -1).start).toBe("2026-07-31T00:00:00");
  });
});

describe("graph_calendar_today", () => {
  it("queries calendarView for today with an ordered window + timezone header", async () => {
    const res = await runAppTool("graph_calendar_today", {});
    expect(res.success).toBe(true);

    const [userId, path, init] = lastCall();
    expect(userId).toBe("oid-1");
    expect(path).toContain("/me/calendarView"); // expands recurring series
    expect(path).toContain("startDateTime=");
    expect(path).toContain("$orderby=start/dateTime");
    expect(init.scopes).toEqual(["Calendars.ReadWrite"]);
    expect(init.headers?.Prefer).toMatch(/^outlook\.timezone="/);
  });

  it("honours day_offset and reports the day it queried", async () => {
    const today = (await runAppTool("graph_calendar_today", {})).data as { day: string };
    const tomorrow = (await runAppTool("graph_calendar_today", { day_offset: 1 }))
      .data as { day: string };
    expect(tomorrow.day).not.toBe(today.day);
  });

  it("ignores a non-numeric day_offset instead of building a broken query", async () => {
    const res = await runAppTool("graph_calendar_today", { day_offset: "junk" });
    expect(res.success).toBe(true);
    expect(lastCall()[1]).not.toContain("NaN");
  });

  it("flattens Graph's nested event shape", () => {
    const events = shapeEvents({
      value: [
        {
          subject: "Standup",
          start: { dateTime: "2026-07-27T09:00:00.0000000", timeZone: "Europe/Brussels" },
          end: { dateTime: "2026-07-27T09:15:00.0000000" },
          isAllDay: false,
          location: { displayName: "Teams" },
          organizer: { emailAddress: { name: "Ada", address: "ada@corp.com" } },
          onlineMeetingUrl: "https://teams/x",
        },
      ],
    });
    expect(events).toEqual([
      {
        subject: "Standup",
        start: "2026-07-27T09:00:00.0000000",
        end: "2026-07-27T09:15:00.0000000",
        isAllDay: false,
        location: "Teams",
        organizer: "Ada",
        onlineMeetingUrl: "https://teams/x",
      },
    ]);
  });

  it("shapeEvents tolerates missing/garbage payloads", () => {
    expect(shapeEvents(null)).toEqual([]);
    expect(shapeEvents({})).toEqual([]);
    expect(shapeEvents({ value: [{}] })[0]).toMatchObject({
      subject: null,
      start: null,
      isAllDay: false,
      organizer: null,
    });
  });
});

describe("graph_mail_recent", () => {
  it("reads the inbox newest-first with Mail.Read", async () => {
    await runAppTool("graph_mail_recent", {});
    const [, path, init] = lastCall();
    expect(path).toContain("/me/mailFolders/inbox/messages");
    expect(path).toContain("$orderby=receivedDateTime desc");
    expect(path).toContain("$top=10");
    expect(path).not.toContain("$filter");
    expect(init.scopes).toEqual(["Mail.Read"]);
  });

  it("filters to unread when asked", async () => {
    await runAppTool("graph_mail_recent", { unread_only: true });
    expect(lastCall()[1]).toContain("$filter=isRead eq false");
  });

  it("clamps limit into 1..25", async () => {
    await runAppTool("graph_mail_recent", { limit: 999 });
    expect(lastCall()[1]).toContain("$top=25");
    await runAppTool("graph_mail_recent", { limit: 0 });
    expect(lastCall()[1]).toContain("$top=10"); // 0 is falsy → default
    await runAppTool("graph_mail_recent", { limit: -5 });
    expect(lastCall()[1]).toContain("$top=1");
  });

  it("compacts messages and truncates the preview", () => {
    const [msg] = shapeMessages({
      value: [
        {
          subject: "Invoice",
          from: { emailAddress: { name: "Bob", address: "bob@x.com" } },
          receivedDateTime: "2026-07-27T08:00:00Z",
          isRead: false,
          hasAttachments: true,
          bodyPreview: "x".repeat(1000),
          webLink: "https://outlook/1",
        },
      ],
    });
    expect(msg).toMatchObject({
      subject: "Invoice",
      from: "Bob",
      isRead: false,
      hasAttachments: true,
      webLink: "https://outlook/1",
    });
    expect(msg.preview).toHaveLength(300);
  });

  it("falls back to the sender address when no display name exists", () => {
    const [msg] = shapeMessages({
      value: [{ from: { emailAddress: { address: "no-name@x.com" } } }],
    });
    expect(msg.from).toBe("no-name@x.com");
  });

  it("shapeMessages tolerates garbage", () => {
    expect(shapeMessages(null)).toEqual([]);
    expect(shapeMessages({ value: "nope" })).toEqual([]);
  });
});

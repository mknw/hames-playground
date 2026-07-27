/**
 * Microsoft Graph app-side tools (Pattern C, #110) — Server Only.
 *
 * Each tool calls Graph **as the signed-in user** via `graphFetch`, which
 * resolves that user's delegated token server-side. Entra enforces the scope,
 * so we don't write a scoping guard and the model never sees a credential.
 *
 * First slice is deliberately `User.Read`-only — the scope already has tenant
 * admin consent, so the whole per-user token path is provable end-to-end with
 * no new tenant configuration. Mail/Files/Calendar tools slot in here once
 * their scopes are consented and added to the sign-in request
 * (`entra-config.server.ts`).
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { graphFetch } from "../auth/graph-token.server";
import { registerAppTool } from "./registry.server";

assertServerOnImport();

/** Fields we surface from `/me`. Explicit so we never dump the whole payload
 *  (which can include tenant metadata) into the model's context. */
const ME_FIELDS = [
  "displayName",
  "givenName",
  "surname",
  "userPrincipalName",
  "mail",
  "jobTitle",
  "officeLocation",
  "preferredLanguage",
] as const;

export interface GraphMeResult {
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  userPrincipalName: string | null;
  mail: string | null;
  jobTitle: string | null;
  officeLocation: string | null;
  preferredLanguage: string | null;
}

/** Pick + null-normalize the fields we advertise. */
export function shapeMe(raw: unknown): GraphMeResult {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = {} as Record<string, string | null>;
  for (const f of ME_FIELDS) {
    const v = src[f];
    out[f] = typeof v === "string" && v.trim() ? v : null;
  }
  return out as unknown as GraphMeResult;
}

// ============================================================================
// Calendar
// ============================================================================

/** IANA timezone Graph should render event times in. Defaults to the server's
 *  own zone, which is right for a single-tenant deployment; override with
 *  `GRAPH_TIMEZONE` if the app and its users don't share one. */
function graphTimeZone(): string {
  return (
    process.env.GRAPH_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC"
  );
}

/**
 * Local-day bounds as naive ISO strings (no `Z`). Graph interprets these in the
 * timezone from the `Prefer: outlook.timezone` header, so we must NOT send UTC
 * instants here — that would shift the day boundary.
 */
export function localDayBounds(now: Date, dayOffset = 0): { start: string; end: string } {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { start: `${day}T00:00:00`, end: `${day}T23:59:59` };
}

export interface CalendarEvent {
  subject: string | null;
  start: string | null;
  end: string | null;
  isAllDay: boolean;
  location: string | null;
  organizer: string | null;
  onlineMeetingUrl: string | null;
}

/** Flatten Graph's nested event shape into something compact for the model. */
export function shapeEvents(raw: unknown): CalendarEvent[] {
  const items = (raw as { value?: unknown[] })?.value;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const e = (it ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    return {
      subject: str(e.subject),
      start: str((e.start as { dateTime?: unknown })?.dateTime),
      end: str((e.end as { dateTime?: unknown })?.dateTime),
      isAllDay: e.isAllDay === true,
      location: str((e.location as { displayName?: unknown })?.displayName),
      organizer: str(
        ((e.organizer as { emailAddress?: Record<string, unknown> })?.emailAddress
          ?.name ??
          (e.organizer as { emailAddress?: Record<string, unknown> })?.emailAddress
            ?.address) as unknown,
      ),
      onlineMeetingUrl: str(e.onlineMeetingUrl),
    };
  });
}

registerAppTool({
  name: "graph_calendar_today",
  namespace: "graph",
  description:
    "List the signed-in user's own calendar events for today (or another day via " +
    "day_offset: 0=today, 1=tomorrow, -1=yesterday). Returns subject, start/end, " +
    "location and organizer. Expands recurring meetings. Acts as the current user.",
  inputSchema: {
    type: "object",
    properties: {
      day_offset: {
        type: "integer",
        description: "Days from today. 0=today (default), 1=tomorrow, -1=yesterday.",
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }) => {
    const offset = Number.isFinite(Number(args.day_offset))
      ? Number(args.day_offset)
      : 0;
    const tz = graphTimeZone();
    const { start, end } = localDayBounds(new Date(), offset);

    // calendarView (not /events) so recurring series are expanded into
    // occurrences within the window.
    const raw = await graphFetch(
      userId,
      `/me/calendarView?startDateTime=${start}&endDateTime=${end}` +
        `&$select=subject,start,end,isAllDay,location,organizer,onlineMeetingUrl` +
        `&$orderby=start/dateTime&$top=50`,
      {
        scopes: ["Calendars.ReadWrite"],
        headers: { Prefer: `outlook.timezone="${tz}"` },
      },
    );
    return { timeZone: tz, day: start.slice(0, 10), events: shapeEvents(raw) };
  },
});

// ============================================================================
// Mail
// ============================================================================

export interface MailMessage {
  subject: string | null;
  from: string | null;
  received: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  preview: string | null;
  webLink: string | null;
}

/** Compact Graph's message shape; `bodyPreview` is truncated to keep turns small. */
export function shapeMessages(raw: unknown): MailMessage[] {
  const items = (raw as { value?: unknown[] })?.value;
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const m = (it ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    const sender = (m.from as { emailAddress?: Record<string, unknown> })?.emailAddress;
    const preview = str(m.bodyPreview);
    return {
      subject: str(m.subject),
      from: str((sender?.name ?? sender?.address) as unknown),
      received: str(m.receivedDateTime),
      isRead: m.isRead === true,
      hasAttachments: m.hasAttachments === true,
      preview: preview ? preview.slice(0, 300) : null,
      webLink: str(m.webLink),
    };
  });
}

registerAppTool({
  name: "graph_mail_recent",
  namespace: "graph",
  description:
    "List recent messages from the signed-in user's inbox, newest first. Set " +
    "unread_only=true for just unread mail. Returns sender, subject, received " +
    "time and a short preview — not full bodies. Acts as the current user.",
  inputSchema: {
    type: "object",
    properties: {
      unread_only: {
        type: "boolean",
        description: "Only unread messages (default false).",
      },
      limit: {
        type: "integer",
        description: "How many messages to return, 1-25 (default 10).",
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }) => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
    const unreadOnly = args.unread_only === true;

    // Inbox specifically (not all folders), so Sent/Archive don't pollute
    // "recent mail". $filter + $orderby together is supported on messages.
    const raw = await graphFetch(
      userId,
      `/me/mailFolders/inbox/messages?$top=${limit}` +
        `&$select=subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink` +
        `&$orderby=receivedDateTime desc` +
        (unreadOnly ? `&$filter=isRead eq false` : ""),
      { scopes: ["Mail.Read"] },
    );
    return { unreadOnly, messages: shapeMessages(raw) };
  },
});

registerAppTool({
  name: "graph_me",
  namespace: "graph",
  description:
    "Get the signed-in user's own Microsoft 365 profile (name, work email/UPN, " +
    "job title, office, language). Acts as the current user — no user or token " +
    "argument is accepted or needed.",
  // No parameters at all: the identity is the request's authenticated user.
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: async (_args, { userId }) => {
    const raw = await graphFetch(
      userId,
      `/me?$select=${ME_FIELDS.join(",")}`,
      { scopes: ["User.Read"] },
    );
    return shapeMe(raw);
  },
});

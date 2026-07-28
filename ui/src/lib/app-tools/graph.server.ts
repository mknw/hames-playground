/**
 * Microsoft Graph app-side tools (Pattern C, #110) — Server Only.
 *
 * Each tool calls Graph **as the signed-in user** via `graphFetch`, which
 * resolves that user's delegated token server-side. Entra enforces the scope,
 * so we don't write a scoping guard and the model never sees a credential.
 *
 * First slice was deliberately `User.Read`-only — the scope already has tenant
 * admin consent, so the whole per-user token path was provable end-to-end with
 * no new tenant configuration. Further tools slot in here once their scopes are
 * consented and added to the sign-in request (`entra-config.server.ts`).
 *
 * `graph_file_ingest` is the one tool that does more than read-and-shape: it
 * bridges Microsoft 365 into the **Data Stash**, so a file the person already
 * owns becomes something later turns (retriever, sandbox, file viewer) can use
 * without the bytes ever passing through the model's context.
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { graphFetch } from "../auth/graph-token.server";
import { conversionEnabled, isConvertible } from "../doc-convert.server";
import { guessMimeType, isTextMime } from "../stash/upload-service.server";
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

// ============================================================================
// Files → Data Stash
// ============================================================================

/** Narrowest scope that can read a driveItem and its content. */
const FILE_SCOPES = ["Files.Read.All"] as const;

/** driveItem fields we need: enough to name, classify and size-check the file.
 *  Explicit because a full driveItem carries a lot we'd never use. */
const DRIVE_ITEM_SELECT = "name,file,size,webUrl";

/** What the model gets back. Notably **not** the content: the bytes go to the
 *  Data Stash, and `documentId` is how later turns reach them. */
export interface GraphFileIngestResult {
  documentId: string;
  filename: string;
  mimeType: string;
  /** Stored size in bytes (original bytes, not the base64 expansion). */
  size: number;
  /** A background chunk→embed→index was started for this document. */
  ingesting: boolean;
  /** Provenance — the file's Microsoft 365 link, for citing back to the person. */
  webUrl: string | null;
}

interface DriveItemMeta {
  name: string | null;
  mimeType: string | null;
  /** Byte size, or null when Graph didn't report one. */
  size: number | null;
  webUrl: string | null;
  isFile: boolean;
}

/**
 * `/drives/{drive}/items/{item}` when a drive is named, else the caller's own
 * OneDrive. Ids are URL-encoded so a crafted id cannot escape its path segment
 * (`../`) and address an unrelated Graph resource.
 */
export function driveItemPath(itemId: string, driveId?: string | null): string {
  const item = encodeURIComponent(itemId);
  return driveId
    ? `/drives/${encodeURIComponent(driveId)}/items/${item}`
    : `/me/drive/items/${item}`;
}

/** Pick the four things we need off a driveItem, tolerating a partial payload. */
export function shapeDriveItem(raw: unknown): DriveItemMeta {
  const it = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const file = it.file as Record<string, unknown> | undefined;
  return {
    name: str(it.name),
    mimeType: str(file?.mimeType),
    size: typeof it.size === "number" && Number.isFinite(it.size) ? it.size : null,
    webUrl: str(it.webUrl),
    // The `file` facet is what distinguishes a file from a folder or package —
    // `$select=file` returns it for files only.
    isFile: file != null && typeof file === "object",
  };
}

registerAppTool({
  name: "graph_file_ingest",
  namespace: "graph",
  description:
    "Copy one of the signed-in person's own Microsoft 365 files (OneDrive or " +
    "SharePoint) into this conversation's Data Stash, so later turns can search " +
    "it, read it or hand it to the sandbox. Identify the file by item_id, " +
    "optionally with drive_id for a shared/SharePoint drive. Text files become " +
    "searchable automatically; other formats are stored as-is. Returns the stash " +
    "document id and metadata — never the file contents. Acts as the current " +
    "signed-in person.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "Microsoft Graph driveItem id of the file to copy.",
      },
      drive_id: {
        type: "string",
        description:
          "Drive holding the item. Omit for the signed-in person's own OneDrive.",
      },
      filename: {
        type: "string",
        description:
          "Override the stored filename. Defaults to the name in Microsoft 365.",
      },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  execute: async (args, { userId, sessionId }): Promise<GraphFileIngestResult> => {
    // Fail closed: the Data Stash is keyed by conversation, so without one in
    // scope there is no correct place to put the file — and guessing would mean
    // writing one person's file into another conversation's stash.
    if (!sessionId) {
      throw new Error(
        "graph_file_ingest stores the file in the current conversation's Data Stash, " +
          "and no conversation is in scope for this call. Run it from a chat turn or " +
          "a triggered action run.",
      );
    }
    const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
    if (!itemId) {
      throw new Error("item_id is required — the Microsoft Graph driveItem id of the file.");
    }
    const driveId =
      typeof args.drive_id === "string" ? args.drive_id.trim() || null : null;
    const base = driveItemPath(itemId, driveId);

    // Metadata first — and separately from the download — because it carries the
    // size, which is how an oversized file is refused BEFORE its bytes are in
    // this process's heap. It also gives the real filename and MIME type.
    const meta = shapeDriveItem(
      await graphFetch(userId, `${base}?$select=${DRIVE_ITEM_SELECT}`, {
        scopes: FILE_SCOPES,
      }),
    );
    if (!meta.isFile) {
      throw new Error(
        `Microsoft 365 item ${itemId} has no file content — it is probably a folder. ` +
          "Pass the id of a file.",
      );
    }

    // The Data Stash layer is imported lazily: it pulls in ioredis and the whole
    // chunk/embed/vector stack, and `mcp-client.server.ts` imports this registry
    // eagerly for *every* harness run — including deployments with no stash.
    const { storeDocument, MAX_CONTENT_BYTES } = await import("../document-store.server");
    // A missing size (Graph reports one for every file in practice) is not
    // treated as oversized; `storeDocument` re-checks the limit on the decoded
    // bytes, so an unreported giant still can't be stored.
    if (meta.size != null && meta.size > MAX_CONTENT_BYTES) {
      throw new Error(
        `"${meta.name ?? itemId}" is ${meta.size} bytes, above the Data Stash limit of ` +
          `${MAX_CONTENT_BYTES} bytes, so it was not downloaded. Use a smaller file or ` +
          "an extract of this one.",
      );
    }

    const override = typeof args.filename === "string" ? args.filename.trim() : "";
    const filename = override || meta.name || `driveitem-${itemId}`;
    const mimeType = meta.mimeType ?? guessMimeType(filename);

    // Always download bytes, then decide how to STORE them — mirroring the
    // upload route's intake: text formats go in as UTF-8 (the chunker reads
    // `content` directly), anything else keeps its exact bytes as base64 so the
    // `/work` round-trip and `?download` still serve the real file.
    const encoded = await graphFetch(userId, `${base}/content`, {
      scopes: FILE_SCOPES,
      responseType: "base64",
    });
    if (typeof encoded !== "string") {
      throw new Error(`Microsoft 365 returned no content for "${filename}".`);
    }
    const isText = isTextMime(mimeType);
    const content = isText ? Buffer.from(encoded, "base64").toString("utf8") : encoded;

    // Same gate as the upload route: a binary is only worth ingesting when we can
    // turn it into text; otherwise `ingestStashDocument` would only mark it
    // failed. Unlike that route we do NOT also require the agent to compose a
    // redis retriever — calling this tool is an explicit request to make the file
    // usable, and a retriever added later reads an already-indexed corpus.
    const ingesting = isText || (conversionEnabled() && isConvertible(mimeType));

    const doc = await storeDocument({
      sessionId,
      filename,
      mimeType,
      content,
      ...(isText ? {} : { encoding: "base64" as const }),
      // Persist 'pending' in the FIRST write (as the upload route does) so a
      // status poll can never read a doc with no ingest status and flicker.
      ...(ingesting ? { ingestStatus: "pending" as const } : {}),
    });

    if (ingesting) {
      // Fire-and-forget, mirroring `POST /api/stash/upload`: embedding is slow
      // and the tool result must come back inside the turn. Failures are
      // recorded in the document's `ingestStatus`, which is why the rejection is
      // swallowed here rather than surfaced.
      void import("../document-ingest.server")
        .then(({ ingestStashDocument }) => ingestStashDocument(sessionId, doc.id))
        .catch(() => {});
    }

    return {
      documentId: doc.id,
      filename,
      mimeType,
      size: doc.size,
      ingesting,
      webUrl: meta.webUrl,
    };
  },
});

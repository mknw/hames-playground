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
 *
 * `graph_files_search` and `graph_files_list` are how a file is *found* in the
 * first place, and both hand back the `drive_id` + `item_id` pair that names a
 * file to any tool acting on one. Search keeps the **query language on the
 * server**: the model passes structured arguments and this module composes the
 * KQL, so no model-authored operator can reshape the query it didn't write.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { graphFetch, GraphAuthRequiredError } from '../auth/graph-token.server'
import { conversionEnabled, isConvertible } from '../doc-convert.server'
import { guessMimeType, isTextMime } from '../stash/upload-service.server'
import { registerAppTool } from './registry.server'

assertServerOnImport()

/** Fields we surface from `/me`. Explicit so we never dump the whole payload
 *  (which can include tenant metadata) into the model's context. */
const ME_FIELDS = [
  'displayName',
  'givenName',
  'surname',
  'userPrincipalName',
  'mail',
  'jobTitle',
  'officeLocation',
  'preferredLanguage',
] as const

export interface GraphMeResult {
  displayName: string | null
  givenName: string | null
  surname: string | null
  userPrincipalName: string | null
  mail: string | null
  jobTitle: string | null
  officeLocation: string | null
  preferredLanguage: string | null
}

/** Pick + null-normalize the fields we advertise. */
export function shapeMe(raw: unknown): GraphMeResult {
  const src = (raw ?? {}) as Record<string, unknown>
  const out = {} as Record<string, string | null>
  for (const f of ME_FIELDS) {
    const v = src[f]
    out[f] = typeof v === 'string' && v.trim() ? v : null
  }
  return out as unknown as GraphMeResult
}

// ============================================================================
// Calendar
// ============================================================================

/** IANA timezone Graph should render event times in. Defaults to the server's
 *  own zone, which is right for a single-tenant deployment; override with
 *  `GRAPH_TIMEZONE` if the app and its users don't share one. */
function graphTimeZone(): string {
  return (
    process.env.GRAPH_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  )
}

/**
 * Local-day bounds as naive ISO strings (no `Z`). Graph interprets these in the
 * timezone from the `Prefer: outlook.timezone` header, so we must NOT send UTC
 * instants here — that would shift the day boundary.
 */
export function localDayBounds(now: Date, dayOffset = 0): { start: string; end: string } {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return { start: `${day}T00:00:00`, end: `${day}T23:59:59` }
}

export interface CalendarEvent {
  subject: string | null
  start: string | null
  end: string | null
  isAllDay: boolean
  location: string | null
  organizer: string | null
  onlineMeetingUrl: string | null
}

/** Flatten Graph's nested event shape into something compact for the model. */
export function shapeEvents(raw: unknown): CalendarEvent[] {
  const items = (raw as { value?: unknown[] })?.value
  if (!Array.isArray(items)) return []
  return items.map((it) => {
    const e = (it ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
    return {
      subject: str(e.subject),
      start: str((e.start as { dateTime?: unknown })?.dateTime),
      end: str((e.end as { dateTime?: unknown })?.dateTime),
      isAllDay: e.isAllDay === true,
      location: str((e.location as { displayName?: unknown })?.displayName),
      organizer: str(
        ((e.organizer as { emailAddress?: Record<string, unknown> })?.emailAddress?.name ??
          (e.organizer as { emailAddress?: Record<string, unknown> })?.emailAddress
            ?.address) as unknown,
      ),
      onlineMeetingUrl: str(e.onlineMeetingUrl),
    }
  })
}

registerAppTool({
  name: 'graph_calendar_today',
  namespace: 'graph',
  description:
    "List the signed-in user's own calendar events for today (or another day via " +
    'day_offset: 0=today, 1=tomorrow, -1=yesterday). Returns subject, start/end, ' +
    'location and organizer. Expands recurring meetings. Acts as the current user.',
  inputSchema: {
    type: 'object',
    properties: {
      day_offset: {
        type: 'integer',
        description: 'Days from today. 0=today (default), 1=tomorrow, -1=yesterday.',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }) => {
    const offset = Number.isFinite(Number(args.day_offset)) ? Number(args.day_offset) : 0
    const tz = graphTimeZone()
    const { start, end } = localDayBounds(new Date(), offset)

    // calendarView (not /events) so recurring series are expanded into
    // occurrences within the window.
    const raw = await graphFetch(
      userId,
      `/me/calendarView?startDateTime=${start}&endDateTime=${end}` +
        `&$select=subject,start,end,isAllDay,location,organizer,onlineMeetingUrl` +
        `&$orderby=start/dateTime&$top=50`,
      {
        scopes: ['Calendars.ReadWrite'],
        headers: { Prefer: `outlook.timezone="${tz}"` },
      },
    )
    return { timeZone: tz, day: start.slice(0, 10), events: shapeEvents(raw) }
  },
})

// ============================================================================
// Mail
// ============================================================================

export interface MailMessage {
  subject: string | null
  from: string | null
  received: string | null
  isRead: boolean
  hasAttachments: boolean
  preview: string | null
  webLink: string | null
}

/** Compact Graph's message shape; `bodyPreview` is truncated to keep turns small. */
export function shapeMessages(raw: unknown): MailMessage[] {
  const items = (raw as { value?: unknown[] })?.value
  if (!Array.isArray(items)) return []
  return items.map((it) => {
    const m = (it ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
    const sender = (m.from as { emailAddress?: Record<string, unknown> })?.emailAddress
    const preview = str(m.bodyPreview)
    return {
      subject: str(m.subject),
      from: str((sender?.name ?? sender?.address) as unknown),
      received: str(m.receivedDateTime),
      isRead: m.isRead === true,
      hasAttachments: m.hasAttachments === true,
      preview: preview ? preview.slice(0, 300) : null,
      webLink: str(m.webLink),
    }
  })
}

registerAppTool({
  name: 'graph_mail_recent',
  namespace: 'graph',
  description:
    "List recent messages from the signed-in user's inbox, newest first. Set " +
    'unread_only=true for just unread mail. Returns sender, subject, received ' +
    'time and a short preview — not full bodies. Acts as the current user.',
  inputSchema: {
    type: 'object',
    properties: {
      unread_only: {
        type: 'boolean',
        description: 'Only unread messages (default false).',
      },
      limit: {
        type: 'integer',
        description: 'How many messages to return, 1-25 (default 10).',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }) => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    const unreadOnly = args.unread_only === true

    // Inbox specifically (not all folders), so Sent/Archive don't pollute
    // "recent mail". $filter + $orderby together is supported on messages.
    const raw = await graphFetch(
      userId,
      `/me/mailFolders/inbox/messages?$top=${limit}` +
        `&$select=subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink` +
        `&$orderby=receivedDateTime desc` +
        (unreadOnly ? `&$filter=isRead eq false` : ''),
      { scopes: ['Mail.Read'] },
    )
    return { unreadOnly, messages: shapeMessages(raw) }
  },
})

registerAppTool({
  name: 'graph_me',
  namespace: 'graph',
  description:
    "Get the signed-in user's own Microsoft 365 profile (name, work email/UPN, " +
    'job title, office, language). Acts as the current user — no user or token ' +
    'argument is accepted or needed.',
  // No parameters at all: the identity is the request's authenticated user.
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, { userId }) => {
    const raw = await graphFetch(userId, `/me?$select=${ME_FIELDS.join(',')}`, {
      scopes: ['User.Read'],
    })
    return shapeMe(raw)
  },
})

// ============================================================================
// Files → Data Stash
// ============================================================================

/** Narrowest scope that can read a driveItem and its content. */
const FILE_SCOPES = ['Files.Read.All'] as const

/** driveItem fields we need: enough to name, classify and size-check the file.
 *  Explicit because a full driveItem carries a lot we'd never use. */
const DRIVE_ITEM_SELECT = 'name,file,size,webUrl'

/** What the model gets back. Notably **not** the content: the bytes go to the
 *  Data Stash, and `documentId` is how later turns reach them. */
export interface GraphFileIngestResult {
  documentId: string
  filename: string
  mimeType: string
  /** Stored size in bytes (original bytes, not the base64 expansion). */
  size: number
  /** A background chunk→embed→index was started for this document. */
  ingesting: boolean
  /** Provenance — the file's Microsoft 365 link, for citing back to the person. */
  webUrl: string | null
}

interface DriveItemMeta {
  name: string | null
  mimeType: string | null
  /** Byte size, or null when Graph didn't report one. */
  size: number | null
  webUrl: string | null
  isFile: boolean
}

/**
 * `/drives/{drive}/items/{item}` when a drive is named, else the caller's own
 * OneDrive. Ids are URL-encoded so a crafted id cannot escape its path segment
 * (`../`) and address an unrelated Graph resource.
 */
export function driveItemPath(itemId: string, driveId?: string | null): string {
  const item = encodeURIComponent(itemId)
  return driveId
    ? `/drives/${encodeURIComponent(driveId)}/items/${item}`
    : `/me/drive/items/${item}`
}

/** Pick the four things we need off a driveItem, tolerating a partial payload. */
export function shapeDriveItem(raw: unknown): DriveItemMeta {
  const it = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const file = it.file as Record<string, unknown> | undefined
  return {
    name: str(it.name),
    mimeType: str(file?.mimeType),
    size: typeof it.size === 'number' && Number.isFinite(it.size) ? it.size : null,
    webUrl: str(it.webUrl),
    // The `file` facet is what distinguishes a file from a folder or package —
    // `$select=file` returns it for files only.
    isFile: file != null && typeof file === 'object',
  }
}

/**
 * Turn a Graph 403 into an error a model can act on. graphFetch's generic
 * message ("may lack consent … sign in") is actively MISLEADING for a 403 on a
 * driveItem: the consented delegated scopes already cover ordinary files, so a
 * 403 here almost always means the item lives where delegated tokens cannot
 * reach — a SharePoint Embedded container (Loop pages/workspaces, Copilot
 * pages; measured live: 22 of this tenant's 25 .loop items). Re-signing-in
 * cannot help; app-only guest access is the tracked fix (#137).
 *
 * 401 and token-acquisition failures (status undefined) pass through — for
 * those, "sign in again" is the correct advice.
 */
function translateIngestDenial(err: unknown, itemId: string): unknown {
  if (err instanceof GraphAuthRequiredError && err.status === 403) {
    return new Error(
      `Microsoft 365 denied access to item ${itemId} (403). This is a per-item denial, ` +
        'not a sign-in problem — signing in again will not help. Items stored in ' +
        'SharePoint Embedded containers (Microsoft Loop pages and workspaces) are not ' +
        "readable with the app's delegated permissions (#137); only their search " +
        'metadata (title, link, snippet) is available. Relay that metadata instead. ' +
        'If this is an ordinary file, the account may genuinely lack access to it.',
    )
  }
  return err
}

registerAppTool({
  name: 'graph_file_ingest',
  namespace: 'graph',
  description:
    "Copy one of the signed-in person's own Microsoft 365 files (OneDrive or " +
    "SharePoint) into this conversation's Data Stash, so later turns can search " +
    'it, read it or hand it to the sandbox. Identify the file by item_id, ' +
    'optionally with drive_id for a shared/SharePoint drive. Text files become ' +
    'searchable automatically; other formats are stored as-is. Returns the stash ' +
    'document id and metadata — never the file contents. Acts as the current ' +
    'signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      item_id: {
        type: 'string',
        description: 'Microsoft Graph driveItem id of the file to copy.',
      },
      drive_id: {
        type: 'string',
        description: "Drive holding the item. Omit for the signed-in person's own OneDrive.",
      },
      filename: {
        type: 'string',
        description: 'Override the stored filename. Defaults to the name in Microsoft 365.',
      },
    },
    required: ['item_id'],
    additionalProperties: false,
  },
  execute: async (args, { userId, sessionId }): Promise<GraphFileIngestResult> => {
    // Fail closed: the Data Stash is keyed by conversation, so without one in
    // scope there is no correct place to put the file — and guessing would mean
    // writing one person's file into another conversation's stash.
    if (!sessionId) {
      throw new Error(
        "graph_file_ingest stores the file in the current conversation's Data Stash, " +
          'and no conversation is in scope for this call. Run it from a chat turn or ' +
          'a triggered action run.',
      )
    }
    const itemId = typeof args.item_id === 'string' ? args.item_id.trim() : ''
    if (!itemId) {
      throw new Error('item_id is required — the Microsoft Graph driveItem id of the file.')
    }
    const driveId = typeof args.drive_id === 'string' ? args.drive_id.trim() || null : null
    const base = driveItemPath(itemId, driveId)

    // Metadata first — and separately from the download — because it carries the
    // size, which is how an oversized file is refused BEFORE its bytes are in
    // this process's heap. It also gives the real filename and MIME type.
    const meta = shapeDriveItem(
      await graphFetch(userId, `${base}?$select=${DRIVE_ITEM_SELECT}`, {
        scopes: FILE_SCOPES,
      }).catch((err) => {
        throw translateIngestDenial(err, itemId)
      }),
    )
    if (!meta.isFile) {
      throw new Error(
        `Microsoft 365 item ${itemId} has no file content — it is probably a folder. ` +
          'Pass the id of a file.',
      )
    }

    // The Data Stash layer is imported lazily: it pulls in ioredis and the whole
    // chunk/embed/vector stack, and `mcp-client.server.ts` imports this registry
    // eagerly for *every* harness run — including deployments with no stash.
    const { storeDocument, MAX_CONTENT_BYTES } = await import('../document-store.server')
    // A missing size (Graph reports one for every file in practice) is not
    // treated as oversized; `storeDocument` re-checks the limit on the decoded
    // bytes, so an unreported giant still can't be stored.
    if (meta.size != null && meta.size > MAX_CONTENT_BYTES) {
      throw new Error(
        `"${meta.name ?? itemId}" is ${meta.size} bytes, above the Data Stash limit of ` +
          `${MAX_CONTENT_BYTES} bytes, so it was not downloaded. Use a smaller file or ` +
          'an extract of this one.',
      )
    }

    const override = typeof args.filename === 'string' ? args.filename.trim() : ''
    const filename = override || meta.name || `driveitem-${itemId}`
    const mimeType = meta.mimeType ?? guessMimeType(filename)

    // Always download bytes, then decide how to STORE them — mirroring the
    // upload route's intake: text formats go in as UTF-8 (the chunker reads
    // `content` directly), anything else keeps its exact bytes as base64 so the
    // `/work` round-trip and `?download` still serve the real file.
    const encoded = await graphFetch(userId, `${base}/content`, {
      scopes: FILE_SCOPES,
      responseType: 'base64',
    }).catch((err) => {
      throw translateIngestDenial(err, itemId)
    })
    if (typeof encoded !== 'string') {
      throw new Error(`Microsoft 365 returned no content for "${filename}".`)
    }
    const isText = isTextMime(mimeType)
    const content = isText ? Buffer.from(encoded, 'base64').toString('utf8') : encoded

    // Same gate as the upload route: a binary is only worth ingesting when we can
    // turn it into text; otherwise `ingestStashDocument` would only mark it
    // failed. Unlike that route we do NOT also require the agent to compose a
    // redis retriever — calling this tool is an explicit request to make the file
    // usable, and a retriever added later reads an already-indexed corpus.
    const ingesting = isText || (conversionEnabled() && isConvertible(mimeType))

    const doc = await storeDocument({
      sessionId,
      filename,
      mimeType,
      content,
      ...(isText ? {} : { encoding: 'base64' as const }),
      // Persist 'pending' in the FIRST write (as the upload route does) so a
      // status poll can never read a doc with no ingest status and flicker.
      ...(ingesting ? { ingestStatus: 'pending' as const } : {}),
    })

    if (ingesting) {
      // Fire-and-forget, mirroring `POST /api/stash/upload`: embedding is slow
      // and the tool result must come back inside the turn. Failures are
      // recorded in the document's `ingestStatus`, which is why the rejection is
      // swallowed here rather than surfaced.
      void import('../document-ingest.server')
        .then(({ ingestStashDocument }) => ingestStashDocument(sessionId, doc.id))
        .catch(() => {})
    }

    return {
      documentId: doc.id,
      filename,
      mimeType,
      size: doc.size,
      ingesting,
      webUrl: meta.webUrl,
    }
  },
})

// ============================================================================
// Files — search and browse
//
// Both tools return the same flattened item shape and both reuse the drive
// helpers above (`driveItemPath`, `shapeDriveItem`), so a file found here is
// addressable by `graph_file_ingest` without the model reformatting anything.
// ============================================================================

/** Search reaches SharePoint as well as OneDrive, so it needs the sites scope on
 *  top of the file scope. Kept separate from `FILE_SCOPES` so browsing and
 *  ingesting stay on the narrower one. */
const FILE_SEARCH_SCOPES = [...FILE_SCOPES, 'Sites.Read.All'] as const

/** driveItem fields the browse tool reads. Explicit for the same reason as
 *  `DRIVE_ITEM_SELECT`, plus `parentReference` (the drive id + folder path) and
 *  `remoteItem` (a OneDrive root holds shortcuts to other drives as stubs). */
const DRIVE_ITEM_LIST_SELECT =
  'id,name,file,folder,size,webUrl,lastModifiedDateTime,parentReference,remoteItem'

// ----------------------------------------------------------------------------
// KQL composition — the app owns the query language
//
// Microsoft Search speaks KQL, which has clause grammar (`AND`, parentheses)
// and property restrictions (`filetype:exe`, `path:"…"`, `size>1000`). A model
// writing that string directly would be writing the query's *structure* from
// untrusted-shaped text: one stray quote in a filename it echoes back and the
// restriction we added is closed and a different one opened. So the model never
// writes KQL. It passes plain terms plus structured filters, the functions below
// compose every clause, and each user-supplied value is reduced to something
// that can only ever be a value.
// ----------------------------------------------------------------------------

/** What can end a quoted value or break the request line: the quote itself,
 *  plus C0 control characters and DEL. */
// Matching control characters is the entire point here: they are what would let
// user input break out of a KQL clause.
// eslint-disable-next-line no-control-regex
const PHRASE_UNSAFE = /["\u0000-\u001f\u007f]+/g

/** For unquoted terms, also the operators: `(` `)` group clauses, and `:` `<`
 *  `>` `=` are what bind a value to a managed property (`filetype:exe`). */
// eslint-disable-next-line no-control-regex -- see PHRASE_UNSAFE above.
const TERM_UNSAFE = /["():<>=\u0000-\u001f\u007f]+/g

/** KQL's boolean and ranking keywords, which it honours in upper case only. */
const KQL_KEYWORDS = /\b(AND|OR|NOT|NEAR|ONEAR|XRANK)\b/g

/**
 * Quote a URL as a KQL value — today the `path:` site restriction.
 *
 * The double quote is **stripped, not escaped**. KQL publishes no escape
 * sequence for a quote inside a value, so an escaping implementation would be
 * inventing a contract Microsoft doesn't define and hoping the parser agrees;
 * removal is the only handling whose behaviour is knowable. Control characters
 * go with it — they would split the request line.
 *
 * Then *all* whitespace goes: a URL contains none, and a single space inside a
 * restriction makes Search stop reading it as a restriction and treat the rest as
 * free text — a silently wider search rather than an error. Whitespace is handled
 * last because removing an unsafe character can itself leave a gap behind.
 */
export function kqlUrlPhrase(value: string): string {
  return `"${value.replace(PHRASE_UNSAFE, '').replace(/\s+/g, '')}"`
}

/**
 * Strip KQL grammar out of free-text terms while keeping them searchable.
 *
 * Quoting the whole thing would turn every multi-word request into an exact
 * phrase match and defeat stemming, so the terms stay bare and the *operators*
 * are removed instead: quotes and parentheses (clause structure), and `:` `<`
 * `>` `=` (what makes `filetype:exe` or `size>1000` a property restriction).
 * KQL's boolean keywords are uppercase-only, so lowercasing them leaves the
 * caller's words intact while reducing them to ordinary search terms.
 *
 * What survives cannot open a clause, close one, or restrict a property — the
 * only structure in the composed query is the structure we added.
 */
export function kqlTerms(value: string): string {
  const cleaned = value.replace(TERM_UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.replace(KQL_KEYWORDS, (op) => op.toLowerCase())
}

/**
 * `filetype:` clause from a supplied extension, or null when there isn't one.
 *
 * An extension is alphanumeric, so the leading alphanumeric run is taken and
 * everything after it is discarded — `docx" OR filetype:exe` yields
 * `filetype:docx`. That leaves no quoting question to get wrong. A leading dot
 * (`.pdf`) is tolerated because models write it.
 */
export function kqlFileType(value: string): string | null {
  const match = /[a-z0-9]+/i.exec(value.trim().replace(/^\.+/, ''))
  return match ? `filetype:${match[0].toLowerCase()}` : null
}

/**
 * Quote a human phrase as a KQL value — today the `author:` restriction.
 *
 * Same strip-don't-escape rule as {@link kqlUrlPhrase} (KQL publishes no escape
 * for a quote), but whitespace is COLLAPSED, not removed: names legitimately
 * contain spaces, and inside a quoted phrase they are valid KQL. The
 * whitespace-removal in `kqlUrlPhrase` is URL-specific, not a general rule.
 * Null when nothing survives, so the clause is dropped like `site`/`file_type`.
 */
export function kqlPhrase(value: string): string | null {
  const cleaned = value.replace(PHRASE_UNSAFE, '').replace(/\s+/g, ' ').trim()
  return cleaned ? `"${cleaned}"` : null
}

/**
 * `LastModifiedTime` restriction from one or both ISO-ish dates.
 *
 * Injection-proof BY CONSTRUCTION, not by sanitization: the value is parsed
 * with `new Date()` and the emitted text derives from the Date object
 * (`toISOString().slice(0,10)`), so no caller character can transit into the
 * query. An unparseable date THROWS rather than being silently dropped — a
 * silently widened search is exactly the "filter didn't bite" churn this
 * exists to prevent, and the thrown message round-trips to the model, which
 * fixes the date on the next turn.
 *
 * Both bounds emit the single range clause `LastModifiedTime:a..b` — verified
 * live (2026-07-30): two space-joined restrictions on the SAME property are
 * SILENTLY IGNORED by Microsoft Search (the query behaves as if neither were
 * there), while the range operator and explicit `AND` both filter correctly.
 */
export function kqlModifiedRange(
  after: string | null | undefined,
  before: string | null | undefined,
): string | null {
  const day = (raw: string, argName: string): string => {
    const d = new Date(raw.trim())
    if (Number.isNaN(d.getTime())) {
      throw new Error(`${argName} must be a date like 2026-07-01 (got "${raw}").`)
    }
    return d.toISOString().slice(0, 10)
  }
  const a = after?.trim() ? day(after, 'modified_after') : null
  const b = before?.trim() ? day(before, 'modified_before') : null
  if (a && b) return `LastModifiedTime:${a}..${b}`
  if (a) return `LastModifiedTime>=${a}`
  if (b) return `LastModifiedTime<=${b}`
  return null
}

export interface FileSearchArgs {
  /** Free-text terms from the caller. */
  query: string
  /** SharePoint site URL to restrict to, composed as `path:"…"`. */
  site?: string | null
  /** File extension to restrict to, composed as `filetype:…`. */
  fileType?: string | null
  /** Author display name, composed as `author:"…"`. */
  author?: string | null
  /** ISO-ish dates, composed as a `LastModifiedTime` restriction. Invalid
   *  values THROW (see kqlModifiedRange). */
  modifiedAfter?: string | null
  modifiedBefore?: string | null
}

/**
 * Compose the KQL sent to `/search/query`.
 *
 * Terms first, then the restrictions, joined by whitespace — KQL's default
 * operator is AND, so this reads as "these words, in this site, of this type".
 * Returns `""` when nothing survives sanitization, which the tool treats as a
 * missing query rather than sending Graph an empty search.
 *
 * A restriction is fragile in one direction worth naming: a stray space inside
 * the clause makes Search stop reading it as a restriction and treat the rest as
 * free text — silently widening the search instead of failing. So no clause here
 * contains caller-controlled whitespace: `filetype:` takes an alphanumeric run,
 * and the `path:` URL has its whitespace removed rather than preserved.
 */
export function composeFileQuery({
  query,
  site,
  fileType,
  author,
  modifiedAfter,
  modifiedBefore,
}: FileSearchArgs): string {
  const parts: string[] = []

  const terms = kqlTerms(query ?? '')
  if (terms) parts.push(terms)

  const type = fileType?.trim() ? kqlFileType(fileType) : null
  if (type) parts.push(type)

  // `path:` is the documented way to scope Microsoft Search to one site (KQL has
  // no `site:` operator — that's Purview eDiscovery). The value is a URL, so it
  // needs quoting: it contains `:` and `/`.
  if (site?.trim()) parts.push(`path:${kqlUrlPhrase(site)}`)

  const byAuthor = author?.trim() ? kqlPhrase(author) : null
  if (byAuthor) parts.push(`author:${byAuthor}`)

  const modified = kqlModifiedRange(modifiedAfter, modifiedBefore)
  if (modified) parts.push(modified)

  return parts.join(' ')
}

// ----------------------------------------------------------------------------
// Response flattening
// ----------------------------------------------------------------------------

/**
 * Strip Microsoft Search's summary markup and truncate.
 *
 * Search wraps each matched term in the summary as `<c0>term</c0>` (one `<cN>`
 * per term) and marks elided text as `<ddd/>`. To a model that is broken markup
 * it may well try to reproduce, so the highlight markers go and the elision
 * becomes an ellipsis. Capped at 300 chars, the same budget as
 * `graph_mail_recent`'s preview, because a page of matched text per hit is how a
 * 25-result search blows a turn.
 */
export function cleanSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/<\/?c\d+>/gi, '')
    .replace(/<ddd\s*\/?>/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 300) : null
}

/**
 * `parentReference.path` → a path a person could read.
 *
 * Graph reports it as `/drive/root:/Reports/Q3%20Plans` (or
 * `/drives/{id}/root:/…`): an addressing prefix, a `root:` marker, then
 * URL-encoded segments. The prefix is noise and the encoding reads as mojibake,
 * so both go, leaving `Reports/Q3 Plans`. An item at the drive root has nothing
 * after `root:` and is reported as `/`.
 */
export function drivePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const marker = raw.indexOf('root:')
  const rel = (marker >= 0 ? raw.slice(marker + 'root:'.length) : raw).replace(/^\/+/, '')
  if (!rel) return '/'
  try {
    return decodeURIComponent(rel)
  } catch {
    // A malformed escape (`%zz`) must not fail the whole search — a slightly
    // ugly path is a better result than no results.
    return rel
  }
}

/**
 * Best-effort containing-folder location derived from an item's `webUrl` —
 * the fallback when `parentReference.path` is absent, which is EVERY
 * `/search/query` hit (search resources carry `parentReference` with driveId /
 * id / siteId but no `path`; `/children` listings do carry it).
 *
 * Only attempted for real SharePoint URLs (`*.sharepoint.com`, which covers
 * `contoso-my.sharepoint.com` personal drives): Loop pages advertise
 * `loop.cloud.microsoft/p/<base64>` — no folder to read — and Office viewer
 * URLs (`/_layouts/15/Doc.aspx?...`) name a handler, not a location, so both
 * yield null. The result is site-relative (`sites/Finance/Shared Documents/Q3`)
 * rather than drive-relative like {@link drivePath} output — good enough for a
 * person or a model citing where a file lives.
 */
export function webUrlFolderPath(webUrl: unknown): string | null {
  if (typeof webUrl !== 'string' || !webUrl.trim()) return null
  try {
    const url = new URL(webUrl)
    if (!url.hostname.toLowerCase().endsWith('.sharepoint.com')) return null
    if (url.pathname.includes('/_layouts/')) return null
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null // nothing left once the item goes
    const folder = segments.slice(0, -1).join('/')
    try {
      return decodeURIComponent(folder)
    } catch {
      // Malformed escape — an ugly path beats no path (same rule as drivePath).
      return folder
    }
  } catch {
    return null
  }
}

/**
 * Readable site from `parentReference.siteId`, which Graph reports as
 * `contoso.sharepoint.com,{siteGuid},{webGuid}`. Only the hostname means
 * anything to a person or to a model citing a source, so the guids are dropped.
 * An id with no hostname is passed through rather than invented over.
 */
export function siteHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.split(',')[0].trim() || null
}

/** What a found file looks like, whether it came from search or from browsing. */
export interface GraphFileRef {
  name: string | null
  /** Containing folder relative to the drive root; `/` at the root itself. */
  path: string | null
  /** SharePoint host the item lives on, or null for a plain OneDrive item. */
  site: string | null
  modified: string | null
  size: number | null
  /** Half of the handoff to the tools that act on a file — always surfaced. */
  drive_id: string | null
  /** The other half: the item's *own* id, not its parent's. */
  item_id: string | null
  webUrl: string | null
}

export interface GraphFileHit extends GraphFileRef {
  /** Matched text, markup stripped. Null when Search returned no summary. */
  snippet: string | null
}

export interface GraphFileEntry extends GraphFileRef {
  isFolder: boolean
  /** Items inside a folder; null for a file, so the model can tell "empty
   *  folder" from "not a folder". */
  child_count: number | null
}

/**
 * A OneDrive root listing contains shortcuts as well as files: "Add shortcut to
 * My files" puts a stub driveItem in the root whose real identity sits under
 * `remoteItem`. Unwrapping it keeps `drive_id` / `item_id` pointing at the file
 * itself, because the stub's own ids address the shortcut — handing those to a
 * tool that reads content would 404.
 */
function unwrapRemote(raw: unknown): Record<string, unknown> {
  const it = (raw ?? {}) as Record<string, unknown>
  const remote = it.remoteItem
  return remote && typeof remote === 'object'
    ? { ...it, ...(remote as Record<string, unknown>) }
    : it
}

/**
 * Flatten one driveItem — from a search hit or from a folder listing.
 * Name/size/webUrl extraction is `shapeDriveItem`'s, so the two file paths can't
 * drift apart on what a "file" looks like; the rest is the location the model
 * needs to navigate or to hand the file on.
 */
export function shapeFileRef(raw: unknown): GraphFileRef {
  const it = unwrapRemote(raw)
  const base = shapeDriveItem(it)
  const parent = (it.parentReference ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    name: base.name,
    // Search hits never carry `parentReference.path` — fall back to reading
    // the containing folder out of the webUrl (see webUrlFolderPath).
    path: drivePath(parent.path) ?? webUrlFolderPath(base.webUrl),
    site: siteHost(parent.siteId),
    modified: str(it.lastModifiedDateTime),
    size: base.size,
    drive_id: str(parent.driveId),
    // `parentReference.id` is the *folder* the item sits in; using it here would
    // point every downstream call at the wrong resource.
    item_id: str(it.id),
    webUrl: base.webUrl,
  }
}

/**
 * Flatten `/search/query`'s three levels of nesting
 * (`value[].hitsContainers[].hits[].resource`) into one list.
 *
 * Hits arrive in rank order, so `rank` itself is dropped — a position in a list
 * says the same thing in fewer tokens. `total` is summed over the containers
 * that reported one and left null when none did, because Search omits it for
 * some result sets and a fabricated 0 would read as "nothing found".
 */
export function shapeSearchHits(raw: unknown): {
  total: number | null
  results: GraphFileHit[]
} {
  const responses = (raw as { value?: unknown[] })?.value
  if (!Array.isArray(responses)) return { total: null, results: [] }

  const results: GraphFileHit[] = []
  let total: number | null = null

  for (const response of responses) {
    const containers = (response as { hitsContainers?: unknown[] })?.hitsContainers
    if (!Array.isArray(containers)) continue
    for (const container of containers) {
      const c = (container ?? {}) as { hits?: unknown[]; total?: unknown }
      if (typeof c.total === 'number' && Number.isFinite(c.total)) {
        total = (total ?? 0) + c.total
      }
      if (!Array.isArray(c.hits)) continue
      for (const hit of c.hits) {
        const h = (hit ?? {}) as Record<string, unknown>
        const ref = shapeFileRef(h.resource)
        results.push({
          ...ref,
          // For a driveItem hit `hitId` *is* the item id, which makes it the
          // fallback when a hit came back without its resource expanded.
          item_id: ref.item_id ?? (typeof h.hitId === 'string' ? h.hitId : null),
          snippet: cleanSummary(h.summary),
        })
      }
    }
  }
  return { total, results }
}

/** Flatten a driveItem collection (a `children` listing) for browsing. */
export function shapeFileEntries(raw: unknown): GraphFileEntry[] {
  const items = (raw as { value?: unknown[] })?.value
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    const it = unwrapRemote(item)
    const folder = it.folder as Record<string, unknown> | undefined
    // The `folder` facet is the counterpart of `file`: present on folders only.
    const isFolder = folder != null && typeof folder === 'object'
    const count = folder?.childCount
    return {
      ...shapeFileRef(it),
      isFolder,
      child_count: isFolder && typeof count === 'number' && Number.isFinite(count) ? count : null,
    }
  })
}

export interface GraphFileSearchResult {
  /** The KQL the app composed, so the model can see how its arguments were
   *  read — and correct them — instead of guessing why a filter didn't bite. */
  query: string
  /** Graph's reported match count; null when Search didn't report one. */
  total: number | null
  results: GraphFileHit[]
  /** Steering for the model when `total` exceeds what was returned: the raw
   *  number alone wasn't acted on (observed: a 4,502-match search answered by
   *  raising `limit`). Present only when triggered. */
  hint?: string
}

registerAppTool({
  name: 'graph_files_search',
  namespace: 'graph',
  description:
    'Search the files the signed-in person can open — their own OneDrive and ' +
    'every SharePoint site they have access to. Pass plain words in `query`: the ' +
    'app builds the search expression, so search syntax is neither needed nor ' +
    'honoured. Narrow with `site` (a SharePoint site URL), `file_type` (an ' +
    "extension like docx or pdf), `author` (a person's name), or " +
    '`modified_after` / `modified_before` (dates). Set sort="newest" for ' +
    "most-recently-modified first. Returns each file's name, folder, site, " +
    'modified date, size and a snippet of the matched text, plus the drive_id + ' +
    'item_id pair that identifies a file to the tools that act on one. Acts as ' +
    'the current signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Words to look for, e.g. "q3 budget forecast". Plain terms only — ' +
          'operators and field:value syntax are stripped, not interpreted.',
      },
      site: {
        type: 'string',
        description:
          'Restrict to one SharePoint site, given as its URL ' +
          '(https://contoso.sharepoint.com/sites/Finance).',
      },
      file_type: {
        type: 'string',
        description: 'Restrict to one file extension, e.g. docx, xlsx, pdf.',
      },
      author: {
        type: 'string',
        description: 'Restrict to files authored by this person, e.g. "Jane Smith".',
      },
      modified_after: {
        type: 'string',
        description: 'Only files modified on/after this date, e.g. 2026-07-01.',
      },
      modified_before: {
        type: 'string',
        description: 'Only files modified on/before this date, e.g. 2026-07-31.',
      },
      sort: {
        type: 'string',
        enum: ['relevance', 'newest'],
        description:
          'Result order: best match first (relevance, default) or ' +
          'most-recently-modified first (newest).',
      },
      limit: {
        type: 'integer',
        description: 'How many files to return, 1-25 (default 10).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (args, { userId }): Promise<GraphFileSearchResult> => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    const query = composeFileQuery({
      query: typeof args.query === 'string' ? args.query : '',
      site: typeof args.site === 'string' ? args.site : null,
      fileType: typeof args.file_type === 'string' ? args.file_type : null,
      author: typeof args.author === 'string' ? args.author : null,
      modifiedAfter: typeof args.modified_after === 'string' ? args.modified_after : null,
      modifiedBefore: typeof args.modified_before === 'string' ? args.modified_before : null,
    })
    if (!query) {
      throw new Error(
        'query is required — the words to look for, e.g. "q3 budget". ' +
          'Nothing searchable was left after the arguments were parsed.',
      )
    }

    const raw = await graphFetch(userId, '/search/query', {
      method: 'POST',
      scopes: FILE_SEARCH_SCOPES,
      body: {
        requests: [
          {
            // driveItem covers OneDrive *and* SharePoint document libraries in
            // one request. `listItem` and `site` are combinable with it here,
            // but they'd fold list rows and site pages into a *file* search.
            entityTypes: ['driveItem'],
            query: { queryString: query },
            from: 0,
            size: limit,
            // Deliberately no `fields`: unlike `$select` it *replaces* the
            // returned resource properties, and a hit stripped of
            // `parentReference` loses `drive_id` — the handoff this tool exists
            // to produce. `shapeSearchHits` is the allowlist instead, so no raw
            // Graph payload reaches the model either way.
            //
            // `isDescending` is the STRING "true" — the shape verified live
            // against this tenant. Microsoft's docs type it Boolean; do not
            // "correct" it untested.
            ...(args.sort === 'newest'
              ? { sortProperties: [{ name: 'lastModifiedDateTime', isDescending: 'true' }] }
              : {}),
          },
        ],
      },
    })

    const { total, results } = shapeSearchHits(raw)
    const hint =
      total != null && total > results.length
        ? `Showing ${results.length} of ${total} matches. Prefer narrowing ` +
          `(modified_after, file_type, site, author, sort="newest") over raising limit.`
        : undefined
    return { query, total, results, ...(hint ? { hint } : {}) }
  },
})

export interface GraphFileListResult {
  /** Which place was listed, echoed back because the arguments select it
   *  implicitly. */
  location: 'onedrive-root' | 'folder'
  items: GraphFileEntry[]
}

/**
 * Browse a known location. Two modes — the person's OneDrive root, or one named
 * folder in any drive they can reach.
 *
 * ## Why there is no `recent` mode
 * The obvious third mode would be `/me/drive/recent` (and its sibling
 * `/me/drive/sharedWithMe`), but both are **deprecated and already degrading**:
 * `sharedWithMe` is currently clamped to roughly one result by a live Microsoft
 * mitigation, and both stop returning data in **November 2026**, with no
 * replacement endpoint. Shipping a tool mode on top of that would build a
 * capability with a known expiry date and no migration path — a model would learn
 * to reach for it and then quietly get nothing back. "Files I touched lately"
 * is its own tool instead — `graph_files_recent`, on the non-deprecated Office
 * Graph insights surface (`/me/insights/used`).
 */
registerAppTool({
  name: 'graph_files_list',
  namespace: 'graph',
  description:
    "Browse the signed-in person's files instead of searching them. With no " +
    'arguments, lists the top level of their own OneDrive; pass folder_item_id ' +
    "(plus drive_id for a SharePoint or shared drive) to list that folder's " +
    'contents. Entries carry the same drive_id + item_id pair as a search result, ' +
    'and folders report isFolder + child_count so you can walk down into them. ' +
    'Use graph_files_search to find a file by its words instead. Acts as the ' +
    'current signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      folder_item_id: {
        type: 'string',
        description:
          'driveItem id of the folder to list. Omit for the top level of the ' +
          "person's own OneDrive.",
      },
      drive_id: {
        type: 'string',
        description: "Drive holding that folder. Omit for the person's own OneDrive.",
      },
      limit: {
        type: 'integer',
        description: 'How many entries to return, 1-50 (default 20).',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }): Promise<GraphFileListResult> => {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
    const folderId = typeof args.folder_item_id === 'string' ? args.folder_item_id.trim() : ''
    const driveId = typeof args.drive_id === 'string' ? args.drive_id.trim() || null : null

    const location: GraphFileListResult['location'] = folderId ? 'folder' : 'onedrive-root'

    const base = folderId
      ? // Same encoded path builder as the ingest tool, so a crafted id can't
        // escape its segment and address an unrelated resource.
        `${driveItemPath(folderId, driveId)}/children`
      : '/me/drive/root/children'

    // No `$orderby`: children come back name-ordered already, and it is not
    // supported on every drive type — a 400 here would break browsing outright.
    const raw = await graphFetch(
      userId,
      `${base}?$select=${DRIVE_ITEM_LIST_SELECT}&$top=${limit}`,
      { scopes: FILE_SCOPES },
    )
    return { location, items: shapeFileEntries(raw) }
  },
})

// ----------------------------------------------------------------------------
// Recent files (Office Graph insights)
// ----------------------------------------------------------------------------

/** One recently-used item as the model sees it. */
export interface GraphRecentFile {
  name: string | null
  /** Human word from insights ("Word", "Excel", "Whiteboard", …) — not a MIME. */
  type: string | null
  /** When the item was last changed / last opened by this user. */
  modified: string | null
  accessed: string | null
  /** Handoff pair, parsed from the insight's resourceReference; null when the
   *  insight didn't point at an addressable driveItem. */
  drive_id: string | null
  item_id: string | null
  webUrl: string | null
}

export interface GraphRecentFilesResult {
  items: GraphRecentFile[]
  /** Present when insights were unavailable (tenant policy) — tells the model
   *  where to go instead rather than failing the run. */
  note?: string
}

/** Shape one /me/insights/used row; null when it isn't a driveItem. */
export function shapeUsedInsight(raw: unknown): GraphRecentFile | null {
  const it = (raw ?? {}) as Record<string, unknown>
  const ref = (it.resourceReference ?? {}) as Record<string, unknown>
  if (ref.type !== 'microsoft.graph.driveItem') return null
  const vis = (it.resourceVisualization ?? {}) as Record<string, unknown>
  const used = (it.lastUsed ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  // resourceReference.id is "drives/{driveId}/items/{itemId}" — the same
  // handoff pair search hits carry. An unparseable id keeps the row (name and
  // dates still inform) with null ids.
  const ids = /^drives\/([^/]+)\/items\/(.+)$/.exec(str(ref.id) ?? '')
  return {
    name: str(vis.title),
    type: str(vis.type),
    modified: str(used.lastModifiedDateTime),
    accessed: str(used.lastAccessedDateTime),
    drive_id: ids ? ids[1] : null,
    item_id: ids ? ids[2] : null,
    webUrl: str(ref.webUrl),
  }
}

registerAppTool({
  name: 'graph_files_recent',
  namespace: 'graph',
  description:
    'List the files the signed-in person recently used — opened or edited — ' +
    "newest first, from Microsoft 365's insights. No query needed; this is the " +
    'right tool for "my recent files" or "what did I work on lately". Each ' +
    'item carries the drive_id + item_id pair the other file tools accept. Use ' +
    'graph_files_search (optionally with sort="newest") to find files by ' +
    'words or by other people. Acts as the current signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'How many files to return, 1-25 (default 10).',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }): Promise<GraphRecentFilesResult> => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    let raw: unknown
    try {
      // `$top` applies BEFORE our driveItem filter and insights mixes in
      // non-file rows (sites, …), so the request is inflated and the shaped
      // list sliced back down to `limit`.
      raw = await graphFetch(userId, `/me/insights/used?$top=${Math.min(limit * 2, 50)}`, {
        scopes: ['Sites.Read.All'],
      })
    } catch (err) {
      // A 403 here is almost always itemInsights disabled by tenant policy —
      // not a sign-in problem, so a re-auth prompt would be wrong AND the
      // agent can still answer via search. Degrade to a successful, steerable
      // result. 401/acquisition failures keep the sign-in path.
      if (err instanceof GraphAuthRequiredError && err.status === 403) {
        return {
          items: [],
          note:
            'Item insights are disabled by tenant policy (or this account lacks ' +
            'consent for them) — use graph_files_search with sort="newest" instead.',
        }
      }
      throw err
    }
    const rows = ((raw as { value?: unknown[] })?.value ?? [])
      .map(shapeUsedInsight)
      .filter((r): r is GraphRecentFile => r !== null)
      .slice(0, limit)
    return { items: rows }
  },
})

// ----------------------------------------------------------------------------
// Shared with me (Office Graph insights)
// ----------------------------------------------------------------------------

/** One thing shared with the signed-in user. */
export interface GraphSharedFile {
  name: string | null
  /** "file" (a driveItem — carries the handoff pair) or "attachment" (an email
   *  attachment — lives in a mailbox, so there are no drive ids to hand on). */
  kind: 'file' | 'attachment'
  shared_by: string | null
  shared_when: string | null
  /** How it was shared: "Link", "Attachment", "Direct" (from Graph). */
  how: string | null
  drive_id: string | null
  item_id: string | null
  webUrl: string | null
}

export interface GraphSharedFilesResult {
  items: GraphSharedFile[]
  /** Present when insights were unavailable (tenant policy) or when a
   *  shared_by filter matched nothing — steers instead of failing. */
  note?: string
}

/**
 * Shape one /me/insights/shared row; null for rows that aren't shareable
 * content (bare `entity` references arrive with no title and no address —
 * noise a model would only trip on).
 *
 * INBOUND ONLY, by construction of the Office Graph: sharing is recorded on
 * the RECIPIENT's insights (measured: 50 rows, 15 distinct sharers, zero
 * shared by the signed-in user). "What did I share with X" is X's question to
 * ask; this tool answers "what was shared with me" and "what did X share with
 * me".
 */
export function shapeSharedInsight(raw: unknown): GraphSharedFile | null {
  const it = (raw ?? {}) as Record<string, unknown>
  const ref = (it.resourceReference ?? {}) as Record<string, unknown>
  const kind =
    ref.type === 'microsoft.graph.driveItem'
      ? ('file' as const)
      : ref.type === 'microsoft.graph.fileAttachment'
        ? ('attachment' as const)
        : null
  if (!kind) return null
  const vis = (it.resourceVisualization ?? {}) as Record<string, unknown>
  const last = (it.lastShared ?? {}) as Record<string, unknown>
  const by = (last.sharedBy ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const ids = kind === 'file' ? /^drives\/([^/]+)\/items\/(.+)$/.exec(str(ref.id) ?? '') : null
  return {
    name: str(vis.title),
    kind,
    shared_by: str(by.displayName),
    shared_when: str(last.sharedDateTime),
    how: str(last.sharingType),
    drive_id: ids ? ids[1] : null,
    item_id: ids ? ids[2] : null,
    webUrl: str(ref.webUrl),
  }
}

registerAppTool({
  name: 'graph_files_shared',
  namespace: 'graph',
  description:
    'List what was recently shared WITH the signed-in person — OneDrive/' +
    'SharePoint links and email attachments — newest first, with who shared it, ' +
    "when and how. Filter to one sharer with shared_by (a person's name). This " +
    'answers "what was shared with me" and "what did X share with me"; it ' +
    'CANNOT list what the signed-in person shared with others (that is recorded ' +
    "on the recipient's side). Files carry the drive_id + item_id pair the other " +
    'file tools accept; email attachments do not (they live in the mailbox). ' +
    'Acts as the current signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      shared_by: {
        type: 'string',
        description: 'Only items shared by this person, e.g. "Thibault" or "Thibault Draye".',
      },
      limit: {
        type: 'integer',
        description: 'How many items to return, 1-25 (default 10).',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }): Promise<GraphSharedFilesResult> => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    const sharedBy = typeof args.shared_by === 'string' ? args.shared_by.trim() : ''
    // Same inflation rationale as graph_files_recent ($top precedes our row
    // filter), amplified when a sharer filter will discard most rows.
    const top = sharedBy ? 50 : Math.min(limit * 2, 50)
    let raw: unknown
    try {
      raw = await graphFetch(userId, `/me/insights/shared?$top=${top}`, {
        scopes: ['Sites.Read.All'],
      })
    } catch (err) {
      if (err instanceof GraphAuthRequiredError && err.status === 403) {
        return {
          items: [],
          note:
            'Item insights are disabled by tenant policy (or this account lacks ' +
            'consent for them) — use graph_files_search with sort="newest" instead.',
        }
      }
      throw err
    }
    const needle = sharedBy.toLowerCase()
    const rows = ((raw as { value?: unknown[] })?.value ?? [])
      .map(shapeSharedInsight)
      .filter((r): r is GraphSharedFile => r !== null)
      .filter((r) => !needle || (r.shared_by ?? '').toLowerCase().includes(needle))
      .slice(0, limit)
    if (rows.length === 0 && sharedBy) {
      return {
        items: [],
        note:
          `Nothing in the recent sharing activity was shared by "${sharedBy}". ` +
          'The window covers recent items only — try graph_files_search with ' +
          'author for older files.',
      }
    }
    return { items: rows }
  },
})

// ----------------------------------------------------------------------------
// Mail with attachments (sent or received)
// ----------------------------------------------------------------------------

/** One attachment on a message — name/size/type only, never content bytes. */
export interface GraphMailAttachment {
  name: string | null
  size: number | null
  contentType: string | null
}

export interface GraphMailAttachmentMessage {
  subject: string | null
  /** The other side of the exchange: recipients for sent mail, sender for
   *  received mail. */
  with: string[]
  date: string | null
  attachments: GraphMailAttachment[]
  webLink: string | null
}

export interface GraphMailAttachmentsResult {
  direction: 'sent' | 'received'
  messages: GraphMailAttachmentMessage[]
}

/** Case-insensitive person match against a display name or address. */
function personMatches(needle: string, name: unknown, address: unknown): boolean {
  const n = needle.toLowerCase()
  return (
    (typeof name === 'string' && name.toLowerCase().includes(n)) ||
    (typeof address === 'string' && address.toLowerCase().includes(n))
  )
}

/** Shape one message row from the attachments query. */
export function shapeAttachmentMessage(
  raw: unknown,
  direction: 'sent' | 'received',
): GraphMailAttachmentMessage {
  const m = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const recips = (Array.isArray(m.toRecipients) ? m.toRecipients : []) as Array<
    Record<string, unknown>
  >
  const from = ((m.from ?? {}) as Record<string, unknown>).emailAddress as
    Record<string, unknown> | undefined
  const withNames =
    direction === 'sent'
      ? recips
          .map((r) => str((r.emailAddress as Record<string, unknown> | undefined)?.name))
          .filter((n): n is string => n !== null)
      : [str(from?.name)].filter((n): n is string => n !== null)
  const atts = (Array.isArray(m.attachments) ? m.attachments : []) as Array<Record<string, unknown>>
  return {
    subject: str(m.subject),
    with: withNames,
    date: str(m.sentDateTime) ?? str(m.receivedDateTime),
    attachments: atts.map((a) => ({
      name: str(a.name),
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : null,
      contentType: str(a.contentType),
    })),
    webLink: str(m.webLink),
  }
}

registerAppTool({
  name: 'graph_mail_attachments',
  namespace: 'graph',
  description:
    "List the signed-in person's emails that carry file attachments — what was " +
    'SENT (default) or RECEIVED, newest first, with the attachment names. ' +
    'Filter to one person and/or a start date. Useful for "what files did I ' +
    'send X" — but note it only sees files that travelled through email: ' +
    'OneDrive/SharePoint shares made from the Share dialog do not appear in ' +
    'sent mail. Returns attachment names and sizes, not their contents. Acts ' +
    'as the current signed-in person.',
  inputSchema: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description:
          'Only exchanges with this person (name or email), e.g. "Thibault". ' +
          'Matches recipients for sent mail, the sender for received mail.',
      },
      direction: {
        type: 'string',
        enum: ['sent', 'received'],
        description: 'Look in sent mail (default) or received mail.',
      },
      since: {
        type: 'string',
        description: 'Only messages on/after this date, e.g. 2026-07-01.',
      },
      limit: {
        type: 'integer',
        description: 'How many messages to return, 1-25 (default 10).',
      },
    },
    additionalProperties: false,
  },
  execute: async (args, { userId }): Promise<GraphMailAttachmentsResult> => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    const direction = args.direction === 'received' ? ('received' as const) : ('sent' as const)
    const person = typeof args.person === 'string' ? args.person.trim() : ''

    // Same reject-don't-drop rule as the search date args: a silently ignored
    // `since` is a silently wrong answer.
    let sinceClause = ''
    if (typeof args.since === 'string' && args.since.trim()) {
      const d = new Date(args.since.trim())
      if (Number.isNaN(d.getTime())) {
        throw new Error(`since must be a date like 2026-07-01 (got "${args.since}").`)
      }
      sinceClause = ` and receivedDateTime ge ${d.toISOString().slice(0, 10)}T00:00:00Z`
    }

    const folder = direction === 'sent' ? 'sentitems' : 'inbox'
    // The person filter runs app-side (recipient matching in OData is awkward
    // and unindexed), so the request is inflated and sliced after filtering.
    const top = person ? 50 : Math.min(limit * 2, 50)
    // No $orderby: combined with $filter Graph requires the sort property to
    // lead the filter, and the default order is already newest-first.
    // Attachments are expanded WITHOUT contentBytes — names and sizes only.
    const raw = await graphFetch(
      userId,
      `/me/mailFolders/${folder}/messages` +
        `?$filter=hasAttachments eq true${sinceClause}` +
        `&$select=subject,toRecipients,from,sentDateTime,receivedDateTime,webLink` +
        `&$expand=attachments($select=name,size,contentType)` +
        `&$top=${top}`,
      { scopes: ['Mail.Read'] },
    )

    const messages = ((raw as { value?: unknown[] })?.value ?? [])
      .map((m) => ({ raw: m, shaped: shapeAttachmentMessage(m, direction) }))
      .filter(({ raw: m }) => {
        if (!person) return true
        const msg = (m ?? {}) as Record<string, unknown>
        if (direction === 'received') {
          const from = ((msg.from ?? {}) as Record<string, unknown>).emailAddress as
            Record<string, unknown> | undefined
          return personMatches(person, from?.name, from?.address)
        }
        const recips = (Array.isArray(msg.toRecipients) ? msg.toRecipients : []) as Array<
          Record<string, unknown>
        >
        return recips.some((r) => {
          const ea = (r.emailAddress ?? {}) as Record<string, unknown>
          return personMatches(person, ea.name, ea.address)
        })
      })
      .map(({ shaped }) => shaped)
      // Real attachments only: inline images and signature logos also set
      // hasAttachments, but arrive with isInline — Graph still lists them, so
      // an empty attachments array can slip through for filtered $selects.
      .filter((m) => m.attachments.length > 0)
      .slice(0, limit)

    return { direction, messages }
  },
})

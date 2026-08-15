# Microsoft Graph — API field notes

What Graph actually returns, as opposed to what it looks like it returns. Written
while building the nine `graph` tools (#110) and extended every time a response
surprised us.

This is **not** the architecture doc. How the app acquires a per-user token,
dispatches a tool call and isolates users lives in
[`MICROSOFT_GRAPH.md`](MICROSOFT_GRAPH.md); tenant provisioning and consent live
in [`deploy/entra-setup.md`](deploy/entra-setup.md). This file is for the moment
you have a Graph response on screen and it does not say what you expected.

> **See also:** [`MICROSOFT_GRAPH.md`](MICROSOFT_GRAPH.md) for why we made each
> call the way we did — the decisions cite the facts recorded here.

---

## How to read this

Almost nothing below comes from Microsoft's documentation. It comes from calling
the API and looking, against **one tenant and mostly one mailbox**, so:

- Every empirical claim carries a **date** and an **N**. "23 of 25 rows
  (2026-08-03)" is a measurement; "Microsoft documents" is a citation; anything
  with neither is a guess and belongs in [Not verified](#not-verified).
- Where a code comment quotes the same number, **this file owns the provenance**
  and the comment keeps the bare figure. Numbers may live in two places;
  the date, method and sample composition live in exactly one.
- The measurement corpus is not in the repo. Harness exports under
  `.harness-logs/` are gitignored and the test fixtures are hand-built, so if a
  number here is wrong there is no artifact to re-derive it from — re-measure
  instead of reasoning about it.

Sample used most often below: one `GET /me/insights/shared?$top=25` against the
DTSC tenant on **2026-08-03**, N=25 rows (10 driveItems, 15 mailbox attachments,
9 distinct source messages, 15 distinct sharers across a wider 50-row pull).

---

## Endpoint map

| Endpoint | What it actually returns | Scope | State |
|---|---|---|---|
| `POST /search/query` | KQL search over `driveItem`/`listItem`/`site`, hits nested three deep | `Files.Read.All` + `Sites.Read.All` | live |
| `GET /me/drive/root/children` | own OneDrive top level, name-ordered, **including shortcut stubs** | `Files.Read.All` | live |
| `GET /drives/{d}/items/{id}/children` | one folder in any reachable drive | `Files.Read.All` | live |
| `GET /me/insights/used` | files this person touched lately, **mixed with non-file rows** | `Sites.Read.All` | live, tenant-disableable |
| `GET /me/insights/shared` | things shared **with** this person; inbound only in every sample | `Sites.Read.All` | live, tenant-disableable |
| `GET /me/messages?$expand=attachments(...)` | messages + attachment metadata, no bytes | `Mail.Read` | live |
| `GET /me/calendarView` | events with recurrences already expanded | `Calendars.ReadWrite` | live |
| `GET /drives/{d}/items/{id}/content` | **302** to a pre-authenticated CDN URL | `Files.Read.All` | live |
| `GET /me/drive/recent` | — | — | deprecated, data stops **Nov 2026** |
| `GET /me/drive/sharedWithMe` | clamped to ~1 result by a live Microsoft mitigation | — | deprecated, data stops **Nov 2026** |
| `POST /me/translateExchangeIds` | EWS ↔ REST id conversion | `Mail.Read` | **not needed** — see [Identifier formats](#identifier-formats) |

The two deprecated rows are why "files shared with me" and "files I touched
lately" both sit on the insights surface instead of the obvious endpoint. Neither
deprecated endpoint has a replacement, so the insights rows below are the whole
story, warts included.

---

## Identifier formats

The single highest-value table here: most Graph debugging is working out what a
150-character string is.

| String | Shape | Notes |
|---|---|---|
| insights `resourceReference.id` | `drives/{driveId}/items/{itemId}` | Split it to get the same handoff pair search hits carry. Present only on `driveItem` rows. |
| driveItem `id` | `01ABCDEF…` (26+ chars, upper-case base32-ish) | The item. **`parentReference.id` is the folder** — using it as the item id silently addresses the wrong thing. |
| `siteId` | `contoso.sharepoint.com,{siteGuid},{webGuid}` | A comma **triple**, hostname first. Split on `,` for a usable host. |
| `parentReference.path` | `/drive/root:/Reports/Q3%20Plans` | Strip the `root:` prefix and decode. A **search hit never carries this** — derive the folder from `webUrl` instead. |
| message `id` | `AAMkA…` base64, contains `/` and `=` | **Not** base64url. Do not infer "EWS id" from that alphabet — see below. |
| OWA attachment popout | `?viewmodel=IAttachmentViewModelPopoutFactory&AttachmentId=…&ItemId=…&AttachmentName=…` | What insights hands you for a mailbox attachment. `ItemId` is the **message**; `AttachmentId` is that id plus a discriminator suffix. |
| OWA read-message link | `?ItemID=…&exvsurl=1&viewmodel=ReadMessageItem` | What Graph itself puts in `message.webLink`. Note `ItemID` — different capitalization from the popout's `ItemId`. |
| Office handler URL | `…/_layouts/15/Doc.aspx?sourcedoc={GUID}&file=name.pptx` | A viewer link, not a path. Carries no folder information. |
| Loop page | `loop.cloud.microsoft/p/<base64>` | Not a driveItem URL; folder derivation must return null rather than guess. |

**The insights `ItemId` is an ordinary Graph message id.** Verified 2026-08-04,
N=1: the `ItemId` from an insights attachment row and `id` from
`/me/messages` for the same message matched character for character. The
standard-base64 alphabet is *not* evidence of an EWS id — we inferred that and
were wrong. Consequence: `/me/messages/{ItemId}` works directly and
`translateExchangeIds` is unnecessary.

**Host varies.** Insights emits `outlook.office.com`; Graph's own `webLink`
emits `outlook.office365.com`; sovereign and GCC clouds emit others again. Carry
the origin and pathname over from whatever you were given rather than
hard-coding one (`parseOwaAttachmentUrl` does this).

---

## Response envelopes

Search buries the resource three levels deep, and a `hitId` is not an item id:

```
{ value: [ { hitsContainers: [ { hits: [ { hitId, rank, summary,
                                          resource: { …driveItem… } } ],
                                 total } ] } ] }
```

An insights row is flat but indirect — the resource is referenced, not embedded:

```
{ value: [ { id,
             resourceReference:     { id, type, webUrl },
             resourceVisualization: { title, type, mediaType,
                                      containerDisplayName, containerType },
             lastShared: { sharedDateTime, sharingType,
                           sharedBy: { displayName, address } } } ] }
```

`resourceReference.type` is the row's discriminator: `microsoft.graph.driveItem`,
`microsoft.graph.fileAttachment`, or something else (bare `entity` rows arrive
with no usable title or address — drop them).

Decorations that are not data: `<c0>term</c0>` and `<ddd/>` in a search
`summary` are Microsoft's hit-highlight markup; `total` is **omitted entirely**
for some result sets rather than returned as zero.

---

## Field reliability

| Field | Looks like | Actually is |
|---|---|---|
| `lastShared.sharingType` | how something was shared | Nearly constant. **23 of 25 rows said `"Attachment"`, 2 said `"Link"`** (2026-08-03), with email attachments, Teams chat pastes and drive files sent as links all collapsed into the one label. Use it only for the `Link` signal; classify from `resourceReference.type` plus the URL shape instead (`deriveVia`). |
| `resourceVisualization.title` | the filename | Extension-stripped on **14 of 15** mailbox-attachment rows (2026-08-03) — `20260802-07346747` for a `.pdf`. The OWA URL's `AttachmentName` parameter has the real name. |
| `lastShared.sharedDateTime` | when it was shared | Second precision, no milliseconds. In the one case cross-checked (2026-08-04) it matched the message's `sentDateTime`, not `receivedDateTime`. Rows from one multi-attachment email therefore share an identical timestamp — which is the field's precision, **not** evidence they are the same email. Group on the message id for that. |
| insights row order | newest first | Newest-first in every sample, but no `$orderby` is accepted-and-verified on this surface, so nothing contracts it. Sort locally if you intend to promise it. |
| `lastShared.sharedBy` | the person who shared it *with you* | The **actor** of the share, which is sometimes **you**. 3 of 25 rows named the signed-in user (2026-08-03), two of them files in their own OneDrive. A row's presence says the item was involved in recent sharing activity, not that it came inbound. |
| `parentReference.path` | always present | Absent on every `/search/query` hit — those carry only `driveId`/`id`/`siteId`. |
| `/me/drive/root/children` rows | the person's files | Include "Add shortcut to My files" **stub** driveItems whose real identity sits in `remoteItem`; the stub's own ids address the shortcut, not the file. |
| `total` (search) | a count | Sometimes missing. Microsoft's own number, and it can exceed what paging will actually yield. |
| "Edited by" | who edited it | Really "authored by" in the fields we can read. |

---

## Query-language traps

Graph's rules, not ours. (For *why we sanitize* what we send, see
[`MICROSOFT_GRAPH.md`](MICROSOFT_GRAPH.md#the-app-owns-the-query-language).)

- **`$top` applies before your own row filter.** On insights, non-matching rows
  consume the page, so inflate the request (`limit × 2`, capped at 50) and slice
  the shaped list back down. Widen to the full 50 whenever a filter will discard
  most rows, or you will report "none" for items that were merely outside the
  page.
- **Two KQL restrictions on the same property are silently ignored.**
  `LastModifiedTime>=a LastModifiedTime<=b` returns unfiltered results — no
  error. Use the range form `LastModifiedTime:a..b`. Verified live 2026-07-30.
- **There is no `site:` operator** in Graph KQL (that is Purview eDiscovery).
  `path:` is the documented way to scope to a site.
- **`isDescending` is the string `"true"`**, not a boolean. Shape verified live.
- **`fields` replaces the returned resource properties**, unlike `$select` which
  projects them — omitting `fields` is usually what you want.
- **`$filter` + `$orderby` on messages requires the sort property to lead the
  filter.** The default order is already newest-first, so the cheap fix is to
  send no `$orderby`.
- **Recipient matching in OData is awkward and unindexed** — filter recipients
  app-side after fetching.
- `driveItem`, `listItem` and `site` combine freely in one `entityTypes`
  request.

---

## Errors and what they really mean

| Status | Graph says | Actually | Does re-auth help? |
|---|---|---|---|
| 403 on a `driveItem` | consent-shaped message | The item lives where delegated tokens cannot reach — a SharePoint Embedded container (Loop pages, Copilot pages). **22 of this tenant's 25 `.loop` items**, measured during #137. | **No.** App-only guest access is the tracked fix (#137). |
| 403 on `/me/insights/*` | consent-shaped message | Item insights disabled by tenant policy, or no consent for them. | No — degrade to a successful empty result with a steer. |
| 401 | token rejected | Genuinely expired or revoked. | Yes. |
| no status | — | Token *acquisition* failed before any HTTP call (MSAL `InteractionRequired`). | Yes. |

The trap is that Graph's 403 message reads like missing consent in all three
cases, so a naive handler sends the user back through sign-in for something
sign-in cannot fix. Distinguish on **what was requested**, not on the message.

---

## Transport-level behaviour

**`/content` answers 302 to a pre-authenticated CDN URL** (`*.sharepoint.com`,
`*.files.1drv.com`). Verified on this runtime (Node 22.21 / undici 6.22):
`fetch` follows the redirect and **strips `Authorization` cross-origin** — which
is correct, because the CDN URL is already authenticated and forwarding a bearer
token to it would leak the token. `Accept` *is* forwarded, so content
negotiation survives the hop.

**Calendar times need `Prefer: outlook.timezone`.** Without it Graph answers in
UTC and a "today" window computed in local time silently straddles two days.
Send naive-local ISO bounds (no `Z`) together with the header. Prefer
`/me/calendarView` over `/me/events`: only the former expands recurrences.

---

## Deprecation calendar

| What | When | Provenance |
|---|---|---|
| `/me/drive/recent` stops returning data | November 2026 | Microsoft deprecation notice, recorded in this repo during #110 — **unsourced here; re-check before relying on the date** |
| `/me/drive/sharedWithMe` stops returning data | November 2026 | same |
| `sharedWithMe` already clamped to ~1 result | in effect now | described as a live Microsoft mitigation; **not independently measured by us** |

**Re-check by 2026-10-01.** If either endpoint is still live, or a replacement
has shipped, the "why there is no `recent` mode" argument in
[`MICROSOFT_GRAPH.md`](MICROSOFT_GRAPH.md#why-there-is-no-recent-mode) needs
revisiting — the insights surface is a workaround, not a preference.

---

## Not verified

Recorded so nothing here launders a guess into a fact.

- **Which direction `/me/insights/shared` actually covers.** Two samples of the
  same mailbox disagree: one 50-row pull recorded during #110 was read as zero
  rows shared *by* the signed-in user, while 2026-08-03 (N=25) had **3** — a
  file they had made a share Link for and two they had sent as attachments. So
  `lastShared.sharedBy` is the actor, not a guarantee of direction, and the feed
  is predominantly-but-not-exclusively inbound. Unknown: whether the earlier
  reading was simply wrong, whether the two windows differ in kind, and above
  all **what fraction of outbound shares appear at all** — which is what decides
  whether "what did I share with X" is answerable or merely sometimes-lucky.
  Settling it needs a deliberate share followed immediately by a re-pull.
- **`AttachmentId` = message id + discriminator.** Inferred from the string
  shape in one mailbox. Untested whether it round-trips to
  `/me/messages/{id}/attachments/{id}`.
- **How many mechanisms hide behind `sharingType: "Attachment"`.** Three
  distinct URL shapes were observed; attributing them to *specific* user actions
  (Share dialog vs Teams paste vs mail attachment) is reconstruction from those
  shapes, not observation of the act. Settling it means performing each action
  and re-exporting.
- **Teams chat folder localization.** N=1, French, one tenant. The safe
  corollary is "never build a folder-name allowlist", not a rule about how
  Microsoft localizes.
- **Whether `resourceVisualization.containerDisplayName` holds the message
  subject** for `fileAttachment` rows. Would make attachment rows readable for
  free; needs one raw-payload capture to check.
- **Whether insights accepts `$filter` on `lastShared/sharedDateTime`.**
  Documented by Microsoft for insights; unverified here. Would let
  "shared with me in the last 3 days" be answered by the API instead of by
  post-filtering a truncated window.

---

## Relationships

| Fact | Encoded in | Measured by |
|---|---|---|
| insights row shaping, `via` classification, OWA rewrite | `lib/app-tools/graph.server.ts` — `shapeSharedInsight`, `deriveVia`, `parseOwaAttachmentUrl` | `__tests__/lib/app-tools/graph-files-shared.test.ts` |
| insights inflation + local recency sort | `graph.server.ts` — `graph_files_shared`, `graph_files_recent` executors | same, plus `graph-files-recent.test.ts` |
| KQL composition and its traps | `graph.server.ts` — `composeFileQuery`, `kqlModifiedRange` | `graph-files.test.ts` |
| search-hit flattening, folder derivation | `graph.server.ts` — `shapeSearchHits`, `drivePath`, `webUrlFolderPath` | `graph-files.test.ts` |
| shortcut-stub unwrapping | `graph.server.ts` — `unwrapRemote` | `graph-files.test.ts` |
| 403 → SharePoint Embedded translation | `graph.server.ts` — `translateIngestDenial` | `graph-file-ingest.test.ts` |
| `/content` redirect handling | `lib/auth/graph-token.server.ts` — `graphFetch` | `graph-file-ingest.test.ts` |
| scope set requested at sign-in | `lib/auth/entra-config.server.ts` — `DEFAULT_GRAPH_SCOPES` | `token-isolation.test.ts` |

Open issues touching this surface: **#137** (SharePoint Embedded / Loop access),
**#110** (per-user Graph, closed — the connectors themselves).

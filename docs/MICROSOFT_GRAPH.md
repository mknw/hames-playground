# Per-user Microsoft Graph access (Pattern C)

How the app calls Microsoft Graph **as the signed-in user**, so Entra enforces
each request's scope instead of an org token guarded by app code. This is
Pattern C of the identity model in #107; issue #110.

For tenant setup (app registration, scopes, consent, env vars) see
[`deploy/entra-setup.md`](deploy/entra-setup.md). For the sign-in/session
machinery see [UI_ARCHITECTURE.md §3](UI_ARCHITECTURE.md).

---

## What it can do today

The **Microsoft 365** agent (`lib/harness-client/examples/microsoft-365.server.ts`)
exposes four tools. All of them only ever **read** from Microsoft 365:

| Tool | Reads | Scope used |
|------|-------|-----------|
| `graph_me` | own profile (name, UPN, job title, office) | `User.Read` |
| `graph_calendar_today` | own calendar for a given day (`day_offset`) | `Calendars.ReadWrite` |
| `graph_mail_recent` | own inbox, newest first, optional `unread_only` | `Mail.Read` |
| `graph_file_ingest` | one own OneDrive/SharePoint file → the Data Stash | `Files.Read.All` |

Enough for "what does my day look like?" — the agent's loop calls several tools
in one turn and the synthesizer writes the briefing — plus "pull that
spreadsheet in and chart it", which is [the file bridge](#files--the-data-stash).

**Consented scopes exceed implemented tools.** The sign-in request also carries
`Mail.Send` and `Sites.Read.All` (see the setup doc for why consent is taken up
front). No tool exposes them, so the model cannot use them: a granted scope is
not a capability — capability comes from a registered tool.

**Writes.** None yet. Adding one is the same shape as a read tool, but it should
carry a confirmation gate: creating an event emails real invitations, and
`Mail.Send` sends real mail. The ready-made `withApproval` pattern was removed
in #125, so a write tool wires its own pause using the surviving primitives
(`pauseContext()` → `status='paused'`, `resumeHarness()`, and the
`approveAction`/`rejectAction` server actions already bound to the UI).

---

## Architecture

A tool is a plain in-process function; everything security-relevant lives in the
layers beneath it, so the tool body only knows a Graph path.

```
model emits tool_call graph_calendar_today {day_offset: 0}
        │
callTool(name, args)                    ← harness-patterns/mcp-client.server.ts
   ├─ sandbox owns it?  → in-VM transport
   ├─ hasAppTool(name)? → runAppTool     ← THIS path
   └─ else              → MCP gateway
        │
runAppTool                              ← app-tools/registry.server.ts
   ├─ userId    = getRequestUserId()     ← AsyncLocalStorage, not args
   ├─ sessionId = getRequestSessionId()  ← idem; null off the request path
   └─ def.execute(args, ctx) → {success, data} | {success:false, error}
        │
tool definition                          ← app-tools/graph.server.ts
   └─ graphFetch(userId, '/me/calendarView?…', {scopes, headers})
        │
graphFetch                               ← auth/graph-token.server.ts
   ├─ getUserGraphToken(userId, scopes)
   │     ├─ loadUserTokenCache(userId)   ← user_tokens, AES-256-GCM
   │     ├─ cache.deserialize → acquireTokenSilent
   │     └─ saveUserTokenCache (refresh-token rotation)
   └─ fetch(GRAPH_BASE + path, Authorization: Bearer …)
```

| Module | Sole responsibility |
|--------|--------------------|
| `harness-patterns/mcp-client.server.ts` | dispatch: which transport owns this tool name |
| `lib/harness-client/request-user.server.ts` | the ambient `{userId, sessionId}` of a run |
| `lib/app-tools/registry.server.ts` | resolve identity, execute, never throw |
| `lib/app-tools/graph.server.ts` | Graph paths, `$select`, response shaping |
| `lib/auth/graph-token.server.ts` | token acquisition, rotation, attach credential |
| `lib/auth/user-tokens.server.ts` | encrypted per-user cache, keyed by `oid` |
| `lib/auth/secret-crypto.server.ts` | AES-256-GCM envelope for stored secrets |

### Why in-process rather than an MCP server

The MCP gateway is a single shared-identity credential boundary: every user's
calls execute as one principal, and the static-secret model cannot inject
per-user credentials (#107). Routing Graph through it would forfeit delegated
per-user scope — the entire point of Pattern C. So app tools are a **third
transport** beside the gateway and the sandbox, dispatched in `callTool` after
the sandbox branch and before the gateway.

### Why `acquireTokenSilent`, not the On-Behalf-Of grant

Despite "OBO" in the issue title, the OBO grant is not what this uses. OBO
serves a **middle-tier API**: a separate client signs in, receives a token
scoped to *our* API, calls us, and we exchange that user assertion downstream.
Since #119 this app is itself the confidential OIDC client — the browser holds
an opaque session cookie, not a token — so there is no assertion to exchange,
and we already hold the user's refresh token from sign-in. `acquireTokenSilent`
produces the same delegated per-user token with less machinery, and needs no
`api://…/access_as_user` scope or "Expose an API" configuration.

`acquireTokenOnBehalfOf` becomes necessary only if a distinct client
authenticates to Entra itself and then calls our API — e.g. giving the iOS
Shortcut its own client id instead of the shared bearer secret it uses today
(see [AGENT_TRIGGER.md](AGENT_TRIGGER.md)). The token-cache plumbing here is the
seam for that.

### Advertisement

`listTools()` appends `appToolDescriptions()` to the gateway's list, and
`inferServer()` reads each tool's declared `namespace`, so they group as
`tools.graph`. Consequences:

- The `microsoft-365` agent picks up new graph tools with **no agent change**.
- App tools stay available when the **gateway is down** — they run in-process.

---

## Identity and isolation

Three invariants shape the design:

1. **Tokens resolve from the request, never from arguments.** No advertised
   schema has a user or token field, so the model cannot ask for another
   person's data — a caller-supplied `userId` argument is ignored in favour of
   `getRequestUserId()`.
2. **The credential is attached inside `graphFetch`** and never returned, so no
   tool body, log line, tool result or event can carry it.
3. **The destination resolves the same way as the identity.** A tool that
   *writes* somewhere per-conversation (only `graph_file_ingest` today) takes its
   `sessionId` from `getRequestSessionId()`, not from args — otherwise the model
   could name another conversation's stash. Same reasoning as (1): anything the
   model can name, it can point elsewhere.

Five mechanisms keep concurrent users apart:

| Layer | Mechanism |
|-------|-----------|
| Identity | `getRequestUserId()` reads AsyncLocalStorage — per-request context |
| Destination | `getRequestSessionId()` from the same store — stash writes can't cross conversations |
| MSAL client | constructed per call; only that user's cache is deserialized into it |
| Token store | `user_tokens.user_id` is the primary key; every query is `WHERE user_id = $1` |
| Provenance | no server action accepts a `userId`; all derive it from `requireUser()` → session cookie |

`__tests__/lib/app-tools/{user,token}-isolation.test.ts` assert this under
deliberately interleaved concurrent calls, and were mutation-checked: hoisting
the MSAL client to a module-level singleton fails them.

**Fail-closed:** a tool called outside any request scope is refused rather than
guessing an identity, and a stash-writing tool with no `sessionId` in scope is
refused rather than guessing a conversation. All three entry points establish the
scope via `runWithRequestContext({userId, sessionId}, …)` — `runTurn` and
`resolveApproval` (interactive) and `runAgentInBackground` (async, where the
run id *is* the session id). The older `runWithUserId(userId, …)` survives as a
thin wrapper that sets `sessionId: null`, which is exactly right for callers with
no conversation: session-dependent tools then refuse instead of picking one.

**Accepted limit:** one encryption key protects every stored cache. Users cannot
reach each other's tokens, but a leaked key plus database access would expose
all of them — which is why the key belongs in a secret store in production.

---

## Token lifecycle

| | |
|---|---|
| Store | `user_tokens`, keyed by the Entra `oid` |
| Contents | MSAL's serialized cache — **includes the refresh token** |
| At rest | AES-256-GCM, versioned envelope (`v1.<iv>.<tag>.<ciphertext>`) |
| Lifetime | survives logout and session expiry, deliberately |
| Rotation | re-written after every silent acquisition (Entra rotates refresh tokens) |

**Why per-user and not per-session:** background runs
(`POST /api/agents/:id` → `runAgentInBackground`) have no live session, only a
`userId`. A session-scoped cache — which is what #119 originally shipped — would
leave those runs with no credential at all.

**When it can't produce a token** (no stored cache, unusable refresh token, an
unconsented scope, or Graph answering 401/403) the layer raises
`GraphAuthRequiredError`, which surfaces as a "sign in again" tool result rather
than failing the run.

> Schema note: databases created by #119 may still carry a plaintext
> `auth_sessions.token_cache` column. It is no longer written; dropping it is
> post-merge cleanup, deliberately not done from a feature branch because code
> deployed from `main` still writes it.

---

## Files → the Data Stash

`graph_file_ingest` is the one tool that doesn't hand its result to the model. It
copies a file the person already owns into **this conversation's** Data Stash, so
the machinery that already exists for uploads — retriever search, the sandbox
`/work` sync, the file viewer, chat citations — works on Microsoft 365 content
with no second pipeline. See [DATA_STASH.md](DATA_STASH.md) for that side.

```
graph_file_ingest {item_id, drive_id?, filename?}
  │  sessionId = getRequestSessionId()      ← refuse if null (never guess a stash)
  ├─ GET  {base}?$select=name,file,size,webUrl     ← metadata FIRST
  │     ├─ no `file` facet        → refuse (it's a folder)
  │     └─ size > MAX_CONTENT_BYTES → refuse *before* downloading
  ├─ GET  {base}/content   (responseType: 'base64')
  ├─ storeDocument({sessionId, filename, mimeType, content, encoding?})
  └─ void ingestStashDocument(sessionId, doc.id)   ← fire-and-forget
        → {documentId, filename, mimeType, size, ingesting, webUrl}
```

`{base}` is `/me/drive/items/{id}` or `/drives/{drive}/items/{id}`; both id
segments are URL-encoded so a crafted id cannot escape into another path.

**Why metadata is a separate call.** It is the only way to know the size before
the bytes are in this process's heap — a 4 GB video would otherwise be downloaded
and base64'd purely to be rejected. It also supplies the true filename and MIME
type. A missing `size` (Graph reports one for every file in practice) is not
treated as oversized; `storeDocument` re-checks the limit on the decoded bytes.

**Text vs. binary** mirrors the upload route's intake decision, and matters more
than it looks: a base64 document that isn't convertible is marked
`ingestStatus: 'failed'` by the ingest layer. So `isTextMime` types are decoded
to UTF-8 and stored as text (the chunker reads `content` directly); everything
else keeps its exact bytes as base64. The background ingest is fired only when
the result can become text — text, or a convertible binary with
`STASH_CONVERT_DOCS=1`.

Unlike `POST /api/stash/upload`, it does **not** additionally require the
session's agent to compose a redis retriever: calling this tool is an explicit
request to make the file usable, and a retriever added later reads an
already-indexed corpus.

### The `/content` redirect and the bearer token

`/content` answers **302** to a pre-authenticated CDN URL
(`*.sharepoint.com`, `*.files.1drv.com`) carrying its own short-lived token in
the query string. Sending our delegated bearer token to that host would be a
credential leak to a third party, so this was checked rather than assumed:

> Verified on this runtime (Node 22.21 / undici 6.22): `fetch` follows the
> redirect and **strips `Authorization` cross-origin**, per the Fetch standard.
> Same-origin (Graph → Graph) redirects keep it. `Accept` *is* forwarded — hence
> `Accept: */*` in binary mode rather than asking a blob endpoint for JSON.

So the default `redirect: 'follow'` is safe and `redirect: 'manual'` plus a bare
second fetch would add moving parts for no gain. If a future runtime changes that
behaviour, the fix belongs in `graphFetch` (one place), not in tool bodies.

---

## Adding a read connector

1. Ensure the delegated scope is consented **and** in the sign-in request — see
   [`deploy/entra-setup.md`](deploy/entra-setup.md). No re-consent is needed for
   a scope already in that set.
2. Register the tool:

```ts
registerAppTool({
  name: "graph_files_recent",
  namespace: "graph",
  description: "…acts as the current user; no user or token argument.",
  inputSchema: { type: "object", properties: { … }, additionalProperties: false },
  execute: async (args, { userId }) =>
    shape(await graphFetch(userId, "/me/drive/recent?$top=10", {
      scopes: ["Files.Read.All"],
    })),
});
```

That's the whole change — no auth, dispatch or agent wiring to touch. Guidelines
that keep turns small and safe:

- Always `$select` explicit fields; never hand a raw Graph payload to the model.
- Shape and truncate (e.g. mail previews are capped at 300 chars).
- Pass the **narrowest** scope the call needs, not the whole consented set.
- Keep the schema free of any user/credential field.

### Calendar time zones

Event times come back in the zone named by the `Prefer: outlook.timezone`
header, defaulting to the server's own zone (override with `GRAPH_TIMEZONE`).
Day windows are therefore built as **naive local** ISO strings: sending UTC
instants would shift the day boundary and silently drop early or late meetings.
`graph_calendar_today` also uses `/me/calendarView` rather than `/me/events` so
recurring series expand into the day's occurrences.

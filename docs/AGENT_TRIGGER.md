# Agent Trigger Endpoint — Async POST → Action

`POST /api/agents/:id` fires a **fixed agent** asynchronously and persists the run
as an **action** in the `conversations` table — fully observable, resumable, and
**promotable to a regular conversation** on user interaction. Built for an iOS
Shortcut that records audio, transcribes it, and POSTs a multipart form.

```
iOS Shortcut ─▶ POST /api/agents/:id (multipart)
                  │  Bearer secret → userId (configs/action-tokens.yaml)
                  │  store recording ─▶ Data Stash (base64, keyed by run_id)
                  │  seed row (kind=action, source=post, status=running)
                  └─ 202 { run_id }         # returns immediately
                        │
                        └─(fire-and-forget)─▶ harness run ─▶ save (status=done|error)
```

Agents are **fixed per endpoint** — intent-routing belongs _inside_ a general
harness, never at this layer. As harnesses mature, more general ones can expose
more routes.

## Endpoint contract

```
POST /api/agents/:id
  :id           → resolve via getAgent(id); 404 if unknown
  Authorization: Bearer <shared-secret>   → resolves to a userId; 401 if unknown
  Body: multipart/form-data
    transcribed_command  (text, required) → harness input; 400 if missing
    short_description     (text)          → sticky conversation title
    original_recording    (file)          → stored in the Data Stash (provenance + playback)
→ 202 { run_id }     # run_id == sessionId == conversation row id
```

Error precedence: unknown agent (404) → bad/missing secret (401) → missing
`transcribed_command` (400) → `202`. Recording storage is **best-effort**: a
failure (e.g. Redis down) is logged and the run still proceeds.

## Modules

| Module                                       | Role                                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/api/agents/[id].ts`                  | The route: auth, multipart parse, recording store, seed row, fire-and-forget, `202`                                                                                                                                                                      |
| `lib/auth/action-tokens.server.ts`           | Parse `configs/action-tokens.yaml` → `secret → userId` map (cached); `bearerSecret()` header extraction                                                                                                                                                  |
| `lib/harness-client/action-runner.server.ts` | `seedActionRow` (observable `running` row) + `runAgentInBackground` (fresh harness run, off the request path). **Server-only, deliberately NOT `"use server"`** — it takes a `userId`, so exposing it as a client RPC would let a caller run as any user |
| `lib/harness-client/turn.server.ts`           | `runTurnAndPersist` — the one implementation of run-a-turn-and-persist, shared with the interactive path (#226 C5). `runAgentInBackground` is this in `triggered` mode |
| `lib/harness-client/actions.server.ts`       | `promoteAction()` server action (flip `kind`); `ConversationSummary` carries `kind`/`source`/`status`                                                                                                                                                    |
| `lib/db/conversations.server.ts`             | `kind`/`source`/`status` columns; `promoteConversation`, `setConversationStatus`; `saveConversation` keeps `kind`/`source` immutable on update                                                                                                           |

## Execution model — in-process fire-and-forget (v1)

1. The route authenticates, parses the multipart body, and stores the recording.
2. `seedActionRow` inserts the row with a minimal seeded `UnifiedContext` (just
   the command as the first `user_message` + `data.trigger`) so the action is
   observable — with a `running` spinner — the instant `202` returns.
3. `runAgentInBackground` runs the turn to completion **without being awaited**,
   through the shared `runTurnAndPersist` in `triggered` mode: a fresh
   `harness(...)` run, _not_ `continueSession` — it never re-appends to the
   seeded placeholder. The turn opens the request scope (so pattern closures
   resolve the owner) and a settings scope holding `DEFAULT_SETTINGS` (there is
   no request-scoped settings payload off the request path). On completion
   `saveSession` overwrites the blob and lifts `status`, then `compactBulkData`
   summarizes the turn's tool results and re-persists them — the same tail the
   interactive path has always had, and which this path silently skipped until
   #226 C5. On an unexpected throw the row is flipped to `error`.

Precedent: `routes/api/events.ts` already fires post-response async work
(title-gen, tool-result summaries).

**Caveat (be honest):** a process restart mid-run orphans a `running` row
(detectable as stale). Crash-recovery / retries are an upgrade path — a
Postgres-polling worker. Assumes a **persistent node server** (not serverless).

## Data model — ONE table (`conversations`)

An action and a conversation share the same shape (a full `UnifiedContext`), so a
second table would force a copy on every promotion. One table → **promotion is a
field flip**. Three columns added via idempotent `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` (so existing DBs pick them up; the `CREATE` only runs when the table is
absent):

| Column   | Values                                     | Notes                                                                                                                   |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `kind`   | `conversation` \| `action`                 | Mutable — **promotion flips it**. Immutable through `saveConversation`'s upsert (only `promoteConversation` changes it) |
| `source` | `chat` \| `post` \| `routine`              | Immutable provenance. `saveConversation` never updates it                                                               |
| `status` | `running` \| `paused` \| `done` \| `error` | Lifted copy of `UnifiedContext.status`, refreshed on every save, for cheap list filtering + the sidebar badge           |

Existing chat flow → `kind='conversation'`, `source='chat'` (defaults; backfilled
on existing rows). POST trigger → `kind='action'`, `source='post'`. A routine
firing on its trigger → `kind='action'`, `source='routine'` (#131) — the same
`seedActionRow` + `runAgentInBackground` path described here, differing only in
the `source` it seeds; see [ROUTINES.md](ROUTINES.md).

Trigger provenance lives at `ctx.data.trigger`
(`{ transcribedCommand, shortDescription, recordingDocId, recordingFilename,
recordingMimeType, routine }`). `short_description` also lands in the sticky
`title` column (the route's insert sets it; the background run's `saveSession`
can't clobber it via the `COALESCE`-sticky rule). `routine` is set only on
routine-triggered runs and carries `{ id, trigger }` — which routine fired, and
on what kind of trigger.

### Status lifecycle — a harness quirk

The harness **never flips a successful run to `done`**: `runChain` leaves
`ctx.status === 'running'` and the compactExecution emits the final `assistant_message`
directly (`harness.server.ts`'s `status === 'done'` push is effectively dead).
Since `saveSession` only runs _after_ the harness returns, a persisted `running`
means "completed, never flipped" → `extractStatusFromContext`
(`session.server.ts`) maps `running → done` on save (`paused`/`error` preserved).
The genuine in-flight `running` badge therefore comes **only** from
`seedActionRow`, which writes the column directly. Do **not** "fix" this in the
harness core by calling `setDone` before the assistant_message push — that would
emit a duplicate message.

## Authentication — `configs/action-tokens.yaml`

Per-user secret map (git-ignored, mirrors `configs/mcp-config.yaml`). Copy
`configs/template.action-tokens.yaml` and fill in real secrets:

```yaml
tokens:
  - label: "iphone" # bookkeeping only, never used at runtime
    secret: "<long-random-secret>"
    userId: "<entra-oid>" # caller's Entra object id (#119)
```

Parsed once and cached (`resolveActionUser`). A missing file rejects every
request (401) with a warning. **Dev:** map a secret to `dev-bypass-user` so
triggered actions appear in the dev UI (which runs as `BYPASS_USER` when
`VITE_DEV_BYPASS_AUTH=true`).

## Recording storage & playback — via the Data Stash

The `original_recording` is stored as a **Data Stash document keyed by `run_id`**
(`storeDocument({ sessionId: run_id, encoding: 'base64', … })`), so it surfaces
in that conversation's **"Your Uploads"** and is playable — _not_ the searchable
ingestion pipeline (binary is skipped by ingest). See [DATA_STASH.md](DATA_STASH.md).

- `upload-service.server.ts` maps audio extensions (`m4a`/`mp3`/`wav`/`aac`/`ogg`/…)
  so a recording is classified binary → base64 (audio/* already fails `isTextMime`).
- `DataStashPanel.tsx` gives audio docs a microphone icon + a **Play** action that
  renders an inline `<audio controls>` pointed at
  `GET /api/stash/document/:id?sessionId=&download`. Media elements ignore the
  `Content-Disposition: attachment` header, so the same route serves both download
  and playback — no new endpoint.
- That route is scoped to the session's owner ([DATA_STASH.md](DATA_STASH.md#session-ownership)),
  which for a triggered run is the token's `userId`: `seedActionRow` writes the
  conversation row for that user inside the same request that stores the
  recording, so playback resolves through it with no extra bookkeeping.

## UI — left sidebar & promotion (`ChatSidebar.tsx`, `ChatInterface.tsx`, `routes/index.tsx`)

- **Segmented filter: All / Chats / Actions** (queries `kind`).
- **Status badge** on action rows: spinner (`running`), red (`error`), amber
  (`paused`), subtle bolt (`done`).
- **Promotion gate:** opening an action and sending a message prompts _"Turn this
  action into a conversation?"_. **Confirm** → `promoteAction()` flips `kind`, then
  the message sends. **Cancel** → the send is aborted entirely (hard gate — the
  draft is dropped; the row stays an action). Once promoted it never gates again.
- Background completion has no browser channel, so the route **polls
  `listConversations()` every 5s while any action is `running`** to surface the
  `running → done` flip.

## Out of scope (follow-ups)

- Completion email / push notification (per-agent settings).
- A dedicated observability view for agent runs (the Actions filter is the interim surface).
- Durable queue / crash-recovery worker (the fire-and-forget orphan caveat above).

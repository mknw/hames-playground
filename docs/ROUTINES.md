# Routines — Trigger-Driven Harness Runs

A **routine** is a persisted "run agent X with input Y when Z happens". It is a
_scheduling layer_ over the agent-trigger path (`POST /api/agents/:id`, see
[AGENT_TRIGGER.md](AGENT_TRIGGER.md)) — not a second way to run a harness. A
routine run is an ordinary `kind='action'` conversation row, emits ordinary
harness events, and shows up under the sidebar's **Actions** filter with the
usual status badge. The only thing that marks it out is `source='routine'`.

```
                    ┌── interval scheduler (unref'd timer, armed at boot)
trigger fires ──────┤
                    └── session_start / session_end (auth routes)
        │
        └─▶ claimRoutineRun (compare-and-set on last_run_at)
              └─▶ seedActionRow(…, source='routine')   ← the SAME functions the
                    └─(fire-and-forget)─▶ runAgentInBackground   POST endpoint uses
                          └─▶ saveSession (status done|error)
```

Closes #131.

## The trigger registry

Triggers are a discriminated union declared **once**, in
[`app/src/lib/routines/triggers.ts`](../app/src/lib/routines/triggers.ts).
Nothing downstream switches on the kind — the store, the scheduler, the hooks
and the API routes all dispatch through the registry. Adding `webhook` or
`threshold` is one entry there plus whatever fires it.

| Kind            | Fires      | Config                             | Meaning                                                                            |
| --------------- | ---------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `interval`      | `schedule` | `{ intervalSeconds }` (min **60**) | Every N seconds, measured from the last run — or from creation if it has never run |
| `session_start` | `event`    | —                                  | The owner signed in (an `auth_sessions` row was minted)                            |
| `session_end`   | `event`    | —                                  | The owner signed out (their `auth_sessions` row was deleted)                       |

Each spec supplies `parse` / `serialize` (the `trigger_config` blob) and
`nextDueAt(trigger, since)`. `'schedule'` kinds return a timestamp and are
swept by the tick; `'event'` kinds return `null` and are never touched by it.
That is what keeps the tick kind-agnostic: a future `cron` kind is scheduled by
the existing loop with no edit to the scheduler.

## Data model — `routines`

Its own table, bootstrapped idempotently on first use (mirrors
`auth/session-store.server.ts` rather than the shared conversations DDL).

| Column                      | Notes                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`, `user_id`, `agent_id` | The routine runs **as its owner**; `agent_id` is resolved through `getAgent()` at fire time    |
| `trigger_kind`              | Plain `TEXT`, deliberately **not** an enum/CHECK — a new kind must not need a migration        |
| `trigger_config`            | `JSONB`, the kind-specific parameters                                                          |
| `input`                     | The harness input sent on every run                                                            |
| `label`                     | Optional; becomes the run's sticky conversation title (falls back to `[kind] truncated-input`) |
| `enabled`                   | The toggle                                                                                     |
| `last_run_at`               | Both the interval clock and the concurrency claim (below)                                      |

A row whose `trigger_kind` this build doesn't know (written by a newer deploy)
is **skipped and logged** on read, never fatal.

## Trigger evaluation

**Interval** — `lib/routines/scheduler.server.ts`. One process-wide `setInterval`
(30s), `unref()`'d so it never keeps the process alive, armed from
`app/src/middleware.ts` — SolidStart imports that module once when the server
handler graph loads, i.e. at boot, before the first request. Arming is
idempotent and the handle is parked on a `globalThis` symbol, so a Vite HMR
re-evaluation can't stack a second timer (a module-scoped `let` would be lost
on every save). Shape follows the #82 sandbox sweep and the #97 startup reaper.

Each tick lists enabled routines, asks the registry `nextDueAt()`, and fires
what's due. One bad routine is logged and skipped; the sweep continues.

**Session lifecycle** — `onSessionStart` / `onSessionEnd` in
`lib/routines/dispatch.server.ts`, called from `routes/api/auth/callback.ts`
(right after `createSession`) and `routes/api/auth/logout.ts`. Both are
synchronous fire-and-forget: the sign-in redirect never waits on a harness, and
a routine failure never costs the user their session. Logout resolves the owner
from the session row **before** deleting it — afterwards the opaque cookie maps
to nobody.

> **Dev note:** with `VITE_DEV_BYPASS_AUTH=true` there is no sign-in/sign-out
> flow at all, so the session hooks never fire. Exercise them against a real
> Entra session, or call `fireRoutinesForEvent()` directly.

### No double-firing

`claimRoutineRun(id, lastRunAt)` is a compare-and-set (`last_run_at IS NOT
DISTINCT FROM $2`, gated on `enabled`) taken immediately before the run. An
overlapping tick, a second app instance, or an HMR re-arm all lose the CAS and
skip. Missed ticks are **not** backfilled: a process that was down for an hour
fires an hourly routine once on the way back up, not sixty times.

Same persistent-node-server assumption as the agent-trigger endpoint: a restart
mid-run orphans a `running` row (see AGENT_TRIGGER.md's caveat).

## Execution

`fireRoutine()` resolves the agent (an unknown `agent_id` is a loud no-op, not
an action row that can never complete), claims, then calls the _existing_
`seedActionRow` + `runAgentInBackground`. `seedActionRow` gained one optional
`source` parameter — that is the entire change to the agent-trigger path.

`ConversationSource` is now `'chat' | 'post' | 'routine'`. Provenance rides on
`ctx.data.trigger.routine = { id, trigger }` alongside the existing
`transcribedCommand` (which carries the routine's input verbatim — the field is
named for the endpoint that introduced it, and reusing it means replay, titles
and the UI need no second shape).

## Management API

Minimal by design (the issue scopes UI polish out). Authenticated as the
current Entra user (or the dev bypass); every store query is scoped by
`user_id`, so another user's id is a 404, never a mutation.

```
GET    /api/routines        → { routines: RoutineDto[], triggers: [{kind,label,fires}] }
POST   /api/routines        → 201 { routine }
         { agentId, trigger, triggerConfig?, input, label?, enabled? }
PATCH  /api/routines/:id    → { routine }      # any of enabled/input/label/trigger
DELETE /api/routines/:id    → { deleted: true }
```

`triggers` in the `GET` response is derived from the registry, so a client can
build its form without hardcoding the union. Changing a routine's trigger
resets `last_run_at`, so a new schedule takes effect from now rather than
firing retroactively for the window that elapsed under the old one.

```bash
# 15-minute digest
curl -X POST localhost:3444/api/routines -H 'Content-Type: application/json' \
  -d '{"agentId":"default","trigger":"interval","triggerConfig":{"intervalSeconds":900},
       "input":"summarise what changed in the graph","label":"Graph digest"}'

# pause it
curl -X PATCH localhost:3444/api/routines/<id> -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```

## Modules

| Module                             | Role                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/routines/triggers.ts`         | The union + registry. Dependency-free, so routes, store and any future client form share it                                                                                                                          |
| `lib/db/routines.server.ts`        | The `routines` table: CRUD, the trigger-evaluation queries, `claimRoutineRun`                                                                                                                                        |
| `lib/routines/dispatch.server.ts`  | Claim → run through the agent-trigger path; `fireRoutinesForEvent` + the session hooks. **Server-only, deliberately NOT `"use server"`** — it takes a `userId`, so an RPC surface would let a caller run as any user |
| `lib/routines/scheduler.server.ts` | The armed tick + `isDue`                                                                                                                                                                                             |
| `lib/routines/dto.ts`              | Wire shape for the API                                                                                                                                                                                               |
| `src/middleware.ts`                | The server-boot hook that arms the scheduler                                                                                                                                                                         |
| `routes/api/routines/*`            | Management API                                                                                                                                                                                                       |

## Out of scope (follow-ups)

- A settings-panel UI for routines (the API is the interim surface).
- Per-routine run history / "last outcome" — today you read the Actions filter.
- A "run now" endpoint for smoke-testing a routine without waiting.
- Durable queue / crash recovery — inherited from the agent-trigger caveat.
- Future trigger kinds (`webhook`, `threshold`): one registry entry each.

# Sandbox debugging

Quick reference for observing what's happening inside the compute sandbox
([#79](https://github.com/mknw/harness-playground/issues/79)) at runtime:
what containers exist, what's running inside them, how to peek, and how to
clean up. Pairs with the design spec at [`docs/plan/sandbox.md`](../plan/sandbox.md).

For the runtime data flow — attachment lifecycle, `/work` ⇄ Data Stash sync, and
tool dispatch / topology — see the Mermaid diagrams in
[`docs/data-flow.md`](../data-flow.md).

## How to identify sandbox containers

Every sandbox container carries two labels (set in
[`ui/src/lib/sandbox/docker-backend.server.ts`](../../ui/src/lib/sandbox/docker-backend.server.ts)):

| Label                    | Value                       | Purpose                                          |
|--------------------------|-----------------------------|--------------------------------------------------|
| `kg-sandbox=1`           | always `1`                  | The family label — use for filters and reaping.  |
| `kg-sandbox-id=<sbx-…>`  | the harness's sandbox id    | Same string as the Docker container name.        |

The container name (`sbx-XXXXXXXX`) is the harness's stable id. For id-keyed
attachments (`withSandbox({ id: sessionId })`), this id stays the same across
the conversation's turns — the container *underneath* may change after a
warm-pool `reset`, but the id you see in the UI's terminal prompt is stable.

## See what's running

```sh
# Snapshot: name, status, age
docker ps --filter label=kg-sandbox=1 --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'

# Live-updating (refreshes every 2s; Ctrl-C to exit)
watch -n 2 'docker ps --filter label=kg-sandbox=1 --format "table {{.Names}}\t{{.Status}}"'

# Resource usage (CPU, memory, I/O) — live
docker stats --filter label=kg-sandbox=1

# Include stopped ones too (useful when debugging crashes; --rm normally
# cleans up on stop, but a fast-crashing one may still be listed briefly)
docker ps -a --filter label=kg-sandbox=1
```

## Peek inside one

```sh
# Replace sbx-xxxx with a name from `docker ps` above.
docker exec -it sbx-xxxx bash      # interactive shell — same thing the UI's
                                    # Terminal tab → Shell gives you, just from
                                    # the host CLI.
docker exec sbx-xxxx ls -la /work  # inspect the agent's workspace
docker exec sbx-xxxx ps -ef        # processes inside the VM
docker logs sbx-xxxx               # mostly empty (idle host); useful only if
                                    # mcp-shell or init.sh wrote to stderr.
```

The `/work` directory is the agent's workspace — files written via
`sandbox_write` / `sandbox_edit` land here, the shell's `cwd` defaults here.
Inspecting it is the fastest way to confirm "did the agent actually write
what it claimed to write?".

### Durable workspace (`syncWorkspace`, [#89](https://github.com/mknw/harness-playground/issues/89))

For agents that opt in (e.g. **Sandbox · Session**), `/work` has a convention:

| Path | Meaning |
|------|---------|
| `/work/in`  | Uploads + prior deliverables, restored from the DataStash on first boot. |
| `/work/out` | Files the agent wants kept — promoted to the DataStash on each turn exit. |
| `/work/*`   | Scratch, lost when the container recycles. |

```sh
docker exec sbx-xxxx ls -la /work/in /work/out   # what was restored / will persist
```

The durable copy lives in Redis, not the container. Inspect it via the MCP
gateway (keys `stash:doc:<sessionId>:*`, index `stash:docs:<sessionId>`) or the
DataStash side panel. Binary deliverables (xlsx, pdf, images) are stored
base64-encoded (`encoding: 'base64'`) and downloadable from the panel; a
`GET /api/stash/document/:id?sessionId=…&download` streams the decoded bytes.
A promoted file lists in the DataStash panel alongside uploads (same
`GET /api/stash/upload?sessionId=` document list) — it is a stored document,
not a synthetic `tool_result`. See [`docs/DATA_STASH.md`](../DATA_STASH.md).

## Reap leftovers

The harness calls `--rm` so a stop auto-removes, and on graceful shutdown the
warm pool destroys everything. **Crashes or kill -9 can leave orphans** — the
in-memory `AttachmentTable` + `WarmPool` that would have torn the `--rm`
containers down die with the process, so idle containers keep running and pile
up against `globalCap`.

**Automatic reap on startup ([#97](https://github.com/mknw/harness-playground/issues/97)
Gap 1):** the next process clears the previous generation itself. The first
time the default sandbox singletons are built (`getDefaultBackend` in
[`with-sandbox.server.ts`](../../ui/src/lib/sandbox/with-sandbox.server.ts)),
`DockerBackend.reapOrphans()` runs once — fire-and-forget, before any sandbox
is allocated — and logs `[sandbox] reaped N orphaned container(s) …` when it
removes anything. So a normal dev-server restart already cleans up after a
prior crash; you rarely need the manual command below.

> **Caveat:** the auto-reap removes **all** `kg-sandbox=1` containers, including
> ones a *concurrent* harness process on the same Docker host might own. That's
> correct for single-process dev (the v0 shape); a multi-process deployment
> would need to gate it behind a setting / grace window (noted on #97).

Manual reap (same scope, e.g. to clean up without restarting):

```sh
# Nuke every sandbox container (running or stopped):
docker ps -a --filter label=kg-sandbox=1 -q | xargs -r docker rm -f
```

Safe by construction — only touches `kg-sandbox=1`-labelled containers, never
anything else. Same command is in
[`ui/src/lib/sandbox/scripts/README.md`](../../ui/src/lib/sandbox/scripts/README.md).

## What you'll see in practice

| Pattern                           | Container shape                                                       |
|-----------------------------------|-----------------------------------------------------------------------|
| `withSandbox({})` (anonymous)     | Boots a VM for the turn, releases back to the warm pool (cap `base:1`). |
| `withSandbox({ id })` (session)   | Boots a VM for the chat, parked under the id between turns.           |
| Interactive Shell (Terminal tab)  | No extra container — attaches to the *session's* VM via `docker exec -it`. |
| `withSandbox({ fresh: true })`    | One-shot private VM, destroyed on exit (skips pool).                  |

After light use you'll typically see **0 or 1 anonymous warm-pool VM** plus
**one VM per active session id**. The lazy idle sweep destroys parked entries
~1 h after last use (the `idleEvictMs` warm-cache horizon; was 5 min before
[#89](https://github.com/mknw/harness-playground/issues/89)), but only fires on
the next sandbox action — see issue
[#82](https://github.com/mknw/harness-playground/issues/82) for the
timer-driven follow-up if dormant accumulation becomes an issue.

Losing the VM no longer loses the work: agents that opt into durable workspaces
(`syncWorkspace: true`, e.g. **Sandbox · Session**) restore prior files into
`/work/in` on the next boot and promote `/work/out` deliverables to the
DataStash each turn — see below.

## Inspecting an agent run after the fact

Per-conversation context logs land under `.harness-logs/`:

```
.harness-logs/context-<sessionId>-<date>.json
```

Each is the full `UnifiedContext` for one turn — `events[]` is the timeline
(user_message, controller_action, tool_call, tool_result, critic_result,
pattern_enter/exit, error, assistant_message). Replay it with `jq` for a
compact trace:

```sh
LOG=.harness-logs/context-XXXX.json
jq -r '.events[] | [.ts, .type, .patternId, (.data.action.tool_name // .data.tool // "")] | @tsv' "$LOG"
```

Useful follow-up filters:

```sh
# Just the tool calls and what was sent / returned
jq -r '.events[] | select(.type=="tool_call" or .type=="tool_result")' "$LOG"

# Critic feedback (why the loop didn't accept)
jq -r '.events[] | select(.type=="critic_result") | .data.result.explanation' "$LOG"

# Errors only
jq -r '.events[] | select(.type=="error") | .data.error' "$LOG"
```

## What's *not* observable today

- **No in-UI fleet view.** The Terminal tab shows the *current session's*
  activity and shell — there's no harness-wide "which sandboxes are running"
  panel. Use the `docker ps` snippets above.
- **No per-VM stdout history outside the agent's view.** The interactive
  Shell has a 64KB scrollback while it's open; once disposed, the bytes are
  gone. The agent's `tool_result` events are persisted in the conversation log
  and survive process restart.
- **`docker logs <sbx-…>` is usually empty.** Sandboxes are idle hosts; the
  in-VM MCP servers and the shell stream their stdio over `docker exec`, not
  over the container's main stdout.

## Related docs

- [`docs/plan/sandbox.md`](../plan/sandbox.md) — full design spec (process
  topology, attachment model, MCP-in-VM architecture, ALS dispatch, backend
  interface, build order).
- [`rootfs/README.md`](../../rootfs/README.md) — how the `kg-sandbox:base`
  image is built and what's inside.
- [`ui/src/lib/sandbox/scripts/README.md`](../../ui/src/lib/sandbox/scripts/README.md)
  — LLM-free and real-LLM live-container smoke scripts (`smoke-scripted.ts`,
  `smoke-llm.ts`).
- [`ui/src/lib/harness-patterns/README.md`](../../ui/src/lib/harness-patterns/README.md)
  — harness patterns overview (event types, EventView, trackEvent).

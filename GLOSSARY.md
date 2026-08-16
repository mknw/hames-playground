# Glossary

The house vocabulary — the words this codebase speaks in commit messages, issue
titles, prompts and docs. **Terms only, never implementation.** Each entry says
what a word means here, so that a reader who then opens the code recognises what
they are looking at; none of them says how the thing works. The authoritative
description of any mechanism is the doc or module named at the end of its entry.

Skills read this file (`codebase-design`'s design-it-twice brief and
`diagnosing-bugs`' exploration step both name it), which is a second reason to
keep it vocabulary: a glossary that restates implementation goes stale silently
and takes the skills' output with it.

---

## The agent harness

**Harness** — the composed, callable agent: `harness(...patterns)` runs its
patterns in order over one `UnifiedContext` and returns a response plus a
serialised context for the next turn. "The harness" without qualification also
means the framework as a whole, `app/src/lib/harness-patterns/`, which replaced
the older `baml-agent` module (ADR-0005). See
[`app/src/lib/harness-patterns/README.md`](app/src/lib/harness-patterns/README.md).

**Pattern** — one composable step inside a harness: a named function that runs in
its own isolated scope and commits its events back to the shared context when it
finishes. `simpleLoop`, `actorCritic`, `router`, `routes`, `synthesizer`,
`retriever`, `parallel`, `judge`, `guardrail` and `hook` are all patterns; a
pattern is identified by its `patternId`, which is also how its events are tagged
and later queried.

**Controller** — the LLM function that drives a `simpleLoop`: given the current
context it returns a `ControllerAction` naming the next tool to call, and the
loop ends when it chooses the `Return` tool. "Controller" always means this
decision-making role, never a web controller or a UI controller.

**Actor** — the generating half of `actorCritic`: it proposes the next script or
tool call each turn. It is a controller by shape (it returns the same
`ControllerAction`), but it deliberately **cannot end the loop** — its `Return`
is ignored and its `is_final` is advisory only.

**Critic** — the evaluating half of `actorCritic`, and the loop's sole exit
authority: it judges whether the actor's result is sufficient and returns
`is_sufficient` plus an explanation and an optional suggested approach. The loop
exits when the critic is satisfied or the retry budget runs out — never because
the actor said so.

**ContextEvent** — one entry in a session's append-only event stream, carrying a
type (`user_message`, `tool_call`, `tool_result`, `controller_action`,
`critic_result`, `pattern_enter`/`pattern_exit`, `error`, and a few more), a
timestamp, the `patternId` that produced it, and a typed payload. The event
stream **is** the session state: everything the UI renders and everything an LLM
prompt is built from is a projection of it.

**EventView** — the fluent read API over that stream: select events by pattern,
by type, by recency or by turn, then `get()` them as objects or `serialize()`
them to the XML shape that goes into a prompt. A pattern never reads the raw
event array; it reads a view, which is what makes "which events does this prompt
see" a configuration decision rather than a code change.

**Tool namespace** — the group an MCP tool belongs to, inferred from its name and
used to hand a pattern a scoped tool set: `neo4j`, `web`, `context7`,
`filesystem`, `github`, `memory`, `redis`, `database`, `code` — plus `all`, which
is every tool. Namespaces are a grouping over the tools a single MCP gateway
exposes, not a security boundary.

## Storage and runtime

**Data Stash** — the document side of a session: user-uploaded files stored in
Redis, chunked, embedded and indexed so the agent can search them, and the same
store that holds agent-produced artifacts and trigger-endpoint recordings. The
term also covers the tool-result side — the hide/archive/summarise controls that
keep an oversized tool result out of the LLM's context without deleting it. See
[`docs/DATA_STASH.md`](docs/DATA_STASH.md).

**Stash session** — the `sessionId`-scoped namespace a stashed document lives in.
Documents, the session's document index, its chunk vectors and its recorded
embedding space are all keyed by it, so a stash session is the unit that
expires, is searched, and is isolated from every other session's corpus. It is
the same id as the conversation's.

**Sandbox flavour** — one of the purpose-built container rootfs images the
sandbox can run: `base` plus `image-processing`, `data` and `office`, each
layered on `base` and carrying the tooling its name implies. Choosing a flavour
is choosing what the actor can do without network access; see
[`docs/sandbox-flavours.md`](docs/sandbox-flavours.md).

**Action** — a harness run that nobody is sitting in front of. It is persisted as
a conversation row marked `kind='action'` with a `source` recording what started
it, it is fully observable and resumable like any conversation, and it is
promoted to a regular conversation the moment a user interacts with it. See
[`docs/AGENT_TRIGGER.md`](docs/AGENT_TRIGGER.md).

**Routine** — a persisted "run agent X with input Y when Z happens". It is a
scheduling layer over the action path rather than a second way to run an agent:
when a routine's trigger fires, its run lands as an ordinary action row marked
`source='routine'`. See [`docs/ROUTINES.md`](docs/ROUTINES.md).

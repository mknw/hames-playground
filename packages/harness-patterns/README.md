<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hames_light-text-on-transparent-bg.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/hames_dark-text-on-transparent-bg.png">
  <img src="assets/hames_dark-text-on-transparent-bg.png" alt="hames" width="340">
</picture>

### Functional, composable primitives for agentic tool execution.

[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat)](./LICENSE)

**[Read the full API reference and design spec →](./SPEC.md)**

</div>

---

## Why build a harness out of these

An agent is its history. `hames` makes that literal: one append-only event log
per session — the **unified context** — is the only state there is. Every
primitive here, whether it is a loop, a router, a planner, a guard or a
synthesizer, reads that log and appends to it, so primitives compose without
knowing about one another and any one of them can be swapped without disturbing
the rest. A pattern writes into an isolated scope and commits only when it
finishes, so a step that throws leaves nothing behind — and because a session
_is_ its serialized log, continuing a conversation and resuming after an approval
gate are two arguments to the same mechanism rather than two subsystems.

What that buys you is control over the thing that usually rots first: what each
model call actually sees. **Views** query the log — by pattern, by event type, by
the last N user turns — and a pattern's **scope** declares its slice once, up
front, instead of at every call site. A synthesizer gets the tool results of the
route that just ran; a router gets a few turns of messages and nothing else;
older results degrade to compact pointers that a controller can expand on demand.
Context is budgeted by construction, not by remembering to prune.

The LLM leaf of each primitive is a [BAML](https://docs.boundaryml.com) function,
and that is the deliberate part. Prompts live in version-controlled `.baml` files
with declared input and output types, so a controller hands back a validated
action rather than a string you hope parses, model fallback chains sit next to
the prompt they serve, and a parse failure arrives as a typed error event in the
same log as everything else. Prompts as code. BAML sits at the leaf and not in
the core: adapter factories are the only place that knows which provider you use,
which is what keeps the primitives portable.

## The anatomy of a harness

Patterns are values, so composing one is ordinary TypeScript — classify, dispatch
to a guarded loop, synthesize. The one thing you bring is the controller callable
(the LLM seam — adapter factories live in the harness-baml companion module;
core ships no LLM defaults by design), so this example scripts one to keep the
composition the star:

```typescript
import {
  Tools,
  simpleLoop,
  router,
  routes,
  withInjectionGuard,
  compactExecution,
  harness,
} from "@hames/harness-patterns";
import type {
  ConfiguredPattern,
  ControllerFn,
  RouteFn,
  RouterData,
  SimpleLoopData,
  SynthesisFn,
  CompactExecutionData,
} from "@hames/harness-patterns";
import type { HarnessData } from "@hames/harness-patterns/harness.server";

// One data type across the composition — extends the pieces it rides and
// carries an index signature (what `harness()`'s generic requires):
interface AgentData
  extends HarnessData, RouterData, SimpleLoopData, CompactExecutionData {
  [key: string]: unknown;
}

// Yours to bring — the adapter factories in the harness-baml companion wrap
// BAML functions into these shapes (core ships no LLM defaults by design, so
// every seam is REQUIRED config). Scripted ones keep the example honest:
const controller: ControllerFn = async (input) => ({
  action: { reasoning: "", tool_name: "", tool_args: "", is_final: true },
});

const route: RouteFn = async (message, history, routes) => ({
  intent: routes?.[0]?.name ?? "user",
  tool_call_needed: false,
  tool_name: null,
  response_text: message,
});

const synthesize: SynthesisFn = async (input) => ({
  value: input.userMessage,
});

const tools = await Tools({
  namespaces: (name) => (name.startsWith("web_") ? "web" : undefined),
});

const search = simpleLoop<AgentData>(controller, tools.web ?? [], {
  patternId: "web-search",
});

const patterns: ConfiguredPattern<AgentData>[] = [
  router<AgentData>(
    { web_search: "Web lookups and information retrieval" },
    { route },
  ),
  routes<AgentData>({
    web_search: withInjectionGuard({ namespaces: ["web"], catalog: tools.all })(
      search,
    ),
  }),
  compactExecution<AgentData>({
    mode: "thread",
    patternId: "response-synth",
    synthesize,
  }),
];
const agent = harness(...patterns);

const result = await agent("What shipped in TypeScript 5.7?", "session-123");
```

Nothing in that chain hands state to the next step by hand: each pattern finds
what it needs in the log, and leaves its own events there for whatever runs next.

**[The developer guide →](./GUIDE.md)** — the composition model, writing your
own pattern, tool transports, the error surface, and how to consume the
package, in buildable prose with every snippet typecheck-pinned.

## The pieces

|                       |                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Loops**             | `simpleLoop` — ReAct-style tool loop · `actorCritic` — generate, then evaluate before it can finish                                |
| **Planning, routing** | `planner` decomposes up front · `router` classifies · `routes` dispatches · `parallel` fans out                                    |
| **Context**           | The unified context is an append-only event log; patterns commit into it from isolated scopes, and a serialized log is a session   |
| **Views & scopes**    | A view queries the log (by pattern, type, recency); a pattern's scope declares its slice once, so old detail expires by itself     |
| **Carrying data**     | `withReferences` hands a pattern the relevant results of earlier turns, expandable on demand · `retriever` searches a vector store |
| **Compaction**        | `compactExecution` turns the accumulated events into the answer · `compactIntent` rewrites the request into a brief                |
| **Guards**            | `withInjectionGuard` neutralizes untrusted tool output before a controller reads it · `guardrail` · `hook`                         |
| **Composition**       | `chain` · `harness` · `continueSession` · `resumeHarness`                                                                          |
| **Leaves**            | BAML adapter factories for controllers, critics and synthesizers · MCP tools via `Tools()` and `callTool`                          |

Each of these has a section in the [spec](./SPEC.md), with the signatures,
configuration and per-pattern semantics that belong there rather than here.

## Status and licence

This package — and only this package — is [MIT](./LICENSE) (Copyright (c) 2026
Michael Accetto). It is the `hames` library: a pnpm workspace package today
(consumed via `workspace:*`, not yet published to npm — see the guide's
"Consuming the package" for exactly where that stands).

It lives inside the
[hames playground](https://github.com/mknw/hames-playground#readme), which is both
its consumer and its proving ground: the ready-made agents are what put these
primitives under load. The playground around this package is
licensed separately, under PolyForm Noncommercial 1.0.0.

The library boundary rules that keep extraction cheap — and everything else about
how this is built — are in the [spec](./SPEC.md).

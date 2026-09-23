# @hames-ai/harness-baml

## What this is

The model calls for
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme),
ready to import. The core library's patterns take every model call as a
function you pass in; this package provides those functions — the _controller_
that decides which tool a loop calls next, a _critic_ that checks a result
before a loop may finish, a router, a planner, a _synthesizer_ that writes the
final answer, and the rest — each with its prompt
already written and its output parsed into a TypeScript type. The prompts are
written in [BAML](https://docs.boundaryml.com), a language for declaring LLM
calls as typed functions; the TypeScript client BAML generates from them ships
pre-built, so you never run BAML's tooling yourself. Calls go to Anthropic
models by default, and can be pointed at an OpenAI-compatible endpoint of your
own.

### Install

```bash
pnpm add @hames-ai/harness-baml @hames-ai/harness-patterns
export ANTHROPIC_API_KEY=sk-ant-…   # read by every Anthropic client in baml_src/clients.baml
```

`@hames-ai/harness-patterns` is a peer dependency, so you add it yourself.
`ANTHROPIC_API_KEY` is the only credential the default setup needs.

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                                             | Use                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners                                     | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written, on Anthropic or your own model provider             | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                                                      | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or the Neo4j graph database from an agent, or sort an MCP gateway's tools into namespaces | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                                       | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

## See it running

The [hames app](https://github.com/mknw/hames-playground) is the reference
host for all five packages: a self-hosted agent workspace whose agents are
built from them, with every step of every run visible in its UI. Its
[Quickstart](https://github.com/mknw/hames-playground#quickstart) runs it
locally with Docker and pnpm.

## How the model calls plug in

A pattern in `@hames-ai/harness-patterns` never calls a model itself; it is handed a function
of the shape `(input) => Promise<LLMResult<T>>`, where `LLMResult` carries the value plus an
`LLMCallRecord` with usage, timing and the raw output. The two loop patterns take their
controller (and critic) as the **first argument**; the other functions (`synthesize`,
`selector`, `route`, `describe`, `describeBatch`, `compactIntent`, `retrieveQuery`) arrive as
**required config**. (`selector` picks which earlier results a step carries forward;
`describe` and `describeBatch` summarize tool results; `compactIntent` rewrites a follow-up
into a self-contained request; `retrieveQuery` rewrites a question into a search query.) The
core library has no defaults for any of them — this package is where they come from, and one
import wires them:

```typescript
import { bamlPatterns, createLoopControllerAdapter } from '@hames-ai/harness-baml'
import { simpleLoop } from '@hames-ai/harness-patterns/patterns/simpleLoop.server'

const patterns = bamlPatterns()
const controller = createLoopControllerAdapter()
const loop = simpleLoop(controller, ['search', 'Return'], {
  patternId: 'my-loop',
  ...patterns,
})
```

The tool list is the loop's allowlist; `'Return'` is the loop's built-in name for "I have the
answer, stop". `createLoopControllerAdapter()` is one of this package's _adapter factories_ —
the next section.

## Adapter factories

An adapter factory returns a function with exactly the type a pattern expects, wrapping one of
the generated BAML functions. It handles what the raw generated function does not: argument
order, recording token usage and timing for each call, and detecting an answer cut off at the
model's output limit, with one corrective retry:

```typescript
import { createActorControllerAdapter, createCriticAdapter } from '@hames-ai/harness-baml'

declare const tools: string[]

const actor = createActorControllerAdapter(tools)
const critic = createCriticAdapter()
```

`bamlPatterns()` returns what patterns take as config in one object — `router`, `synthesize`,
`selector`, `describe`, `describeBatch`, `compactIntent` and `retrieveQuery`, plus `planner`,
which is a factory you call with the planner's tool list (`baml.planner(tools.all)`) — so the
wiring stays one line however many of them a pattern needs. The loop controllers and the critic
come from their own factories, as above.

## Choosing which model each call uses

You can skip this section if Anthropic is all you need: every call already goes there.

Every call has a _role_ — `controller`, `planner`, `critic`, `compactExecution`, `router`,
`describe` or `screen` — and each role resolves to a BAML _client_, a named model configuration
(provider, model, limits, fallbacks).

- A _tier_ is which set of models a run uses: `anthropic` (the default) or `verda` (an optional
  self-hosted model, off unless your application configures it). Your application picks the tier
  per run, for example per conversation; you care because it decides where your prompts are sent.
- A _run frame_ is the bundle of settings one run carries from start to finish — its tier, its
  budgets, its live-event listener. Your application opens it with `withRunFrame` from
  `@hames-ai/harness-patterns` (or `harness()` opens one for you), and every model call made
  inside that run reads its settings from it.

Three functions answer "which model does this role use right now": `clientOverrideFor(role)`
builds the per-call options a call spreads into its BAML options; `resolveClientForRole(role)`
names the client; `limitsFor(role)` returns that model's context window and output cap, so
patterns size their prompts for the right model. `assertInferenceTier(tier)` checks that a tier
can actually be reached — it throws for `verda` when no self-hosted endpoint is configured —
and your application calls it before putting a tier in a run frame:

```typescript
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  assertInferenceTier,
  clientOverrideFor,
  limitsFor,
} from '@hames-ai/harness-baml/clients.server'

assertInferenceTier('anthropic')
await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
  const opts = { ...clientOverrideFor('controller') } // undefined on the anthropic tier
  const limits = limitsFor('controller')
})
```

## Clients that ship

The shipped `baml_src/` declares two client families, and nothing else:

- **Anthropic chains** — the default. Every function names an Anthropic chain
  (`ControllerAnthropic`, `ActorAnthropic`, `PlannerAnthropic`, `CriticAnthropic`,
  `SynthesizerAnthropic`, `RouterAnthropic`, `DescribeAnthropic`); the `client X` line on each
  function is what routes a call.
- **Custom endpoint** — `VerdaQwen`, the client behind the optional self-hosted `verda` tier
  (off by default; an `openai-generic` client, so any OpenAI-compatible server works), and
  `LocalQwenSmall`, a second one for a small summarizer model on that tier.

### Pointing a custom-endpoint client at your model

The custom-endpoint clients take their endpoint and key from the environment at call time — set
the variables and the client reaches your deployment; nothing in the package changes:

```bash
# the OpenAI-compatible base URL, including the /v1 suffix — BAML hands it to
# openai-generic verbatim, so a root URL 404s every call on <root>/chat/completions
export VERDA_INFERENCE_ENDPOINT=https://your-deployment.example.com/v1
export VERDA_INFERENCE_API_KEY=your-key

# the small summarizer endpoint (the model that summarizes tool results on this tier)
export SMALL_LLM_BASE_URL=https://your-summarizer.example.com/v1
```

> Choosing a tier per conversation, and deciding when the self-hosted tier is reachable, is
> your application's policy, registered at startup. The hames app's version is in this
> repository under `app/src/lib/inference/`.

## Bring your own provider or model

A consumer can supply its own LLM clients — a different provider, a self-hosted endpoint —
without touching prompts: define runtime clients through a BAML `ClientRegistry`, map the
roles you want off the built-in chains, and your clients take over **exactly the mapped roles**
on top of the built-in tier (unmapped roles change nothing, and the injection guard's `screen`
role moves only when you map it by name). One function type serves both wiring paths:

```typescript
import {
  defineInferenceClients,
  activateConsumerClients,
} from '@hames-ai/harness-baml/consumer-clients.server'

const plug = defineInferenceClients({
  clients: [
    {
      name: 'MyEndpoint',
      provider: 'openai-generic',
      options: {
        model: 'my-model-7b',
        base_url: 'https://llm.internal.example.com/v1',
        api_key: '…',
      },
    },
  ],
  byRole: { router: 'MyEndpoint', describe: 'MyEndpoint' },
})
activateConsumerClients(plug) // adapter call sites honour the layer from here on
```

If you use `@hames-ai/agents`, hand `plug` to `AgentDeps.clientOverride` as well — the type is the same `ClientOverride` —
for the package-side call sites outside the adapters (the title generator). Definition-time
validation throws on a malformed config (empty name/provider, `byRole` naming an undefined
client), naming the role and the client — never on turn one. Full walkthrough, including
what happens to unmapped roles and to prompt budgeting:
**[docs/tutorials/own-provider-or-model.md](../../docs/tutorials/own-provider-or-model.md)**.

## Requirements: a TypeScript bundler

Like every `@hames-ai` package, this one **ships TypeScript source**: `main`
and every code target in `exports` is a `.ts` file (`baml_client/` included: it is committed, generated TypeScript), and there is no
`dist/`. Run it through something that compiles TypeScript — Vite, esbuild,
tsx, Bun. **Not** `node --experimental-strip-types`, which refuses to strip
types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and
not a plain `node dist/index.js`.

## Regenerating the client (contributors)

`baml_client/` is pre-generated and committed, so as a consumer you never run BAML's CLI. If you
edit a `.baml` file in this package, regenerate and commit the result with the source change:

```bash
pnpm baml-generate   # from packages/harness-baml; requires @boundaryml/baml (a dependency)
```

## Licence

MIT

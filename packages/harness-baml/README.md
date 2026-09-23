# @hames-ai/harness-baml

## What this is

The model calls for
[`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme),
ready to import. The core library's patterns take every model call as a
function you pass in; this package provides those functions — the _controller_
that decides which tool a loop calls next, a critic, a router, a planner, a
synthesizer that writes the final answer, and the rest — each with its prompt
already written and its output parsed into a TypeScript type. The prompts are
written in [BAML](https://docs.boundaryml.com), a language for declaring LLM
calls as typed functions; the TypeScript client BAML generates from them ships
pre-built, so you never run BAML's tooling yourself. Calls go to Anthropic
models by default, and can be pointed at an OpenAI-compatible endpoint of your
own.

## Which package do you need?

Five packages that work together. The first is the foundation; add the others
for what they do.

| If you want to…                                                                      | Use                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| build an agent out of composable pieces — tool loops, routers, planners              | [`@hames-ai/harness-patterns`](https://github.com/mknw/hames-playground/tree/main/packages/harness-patterns#readme) |
| get typed model calls with the prompts already written                               | [`@hames-ai/harness-baml`](https://github.com/mknw/hames-playground/tree/main/packages/harness-baml#readme)         |
| use a ready-made agent                                                               | [`@hames-ai/agents`](https://github.com/mknw/hames-playground/tree/main/packages/agents#readme)                     |
| use Microsoft 365 or Neo4j from an agent, or a ready tool catalog for an MCP gateway | [`@hames-ai/connectors`](https://github.com/mknw/hames-playground/tree/main/packages/connectors#readme)             |
| run agent-written code in a container                                                | [`@hames-ai/sandbox`](https://github.com/mknw/hames-playground/tree/main/packages/sandbox#readme)                   |

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
**required config**. The core library has no defaults for any of them — this package is where
they come from, and one import wires them:

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

`createLoopControllerAdapter()` is one of this package's _adapter factories_ — the next section.

## Adapter factories

An adapter factory returns a function with exactly the type a pattern expects, wrapping one of
the generated BAML functions. It handles what the raw generated function does not: argument
order, usage accounting through BAML's collectors, and detecting an answer cut off at the
model's output limit, with one corrective retry:

```typescript
import { createActorControllerAdapter, createCriticAdapter } from '@hames-ai/harness-baml'

declare const tools: string[]

const actor = createActorControllerAdapter(tools)
const critic = createCriticAdapter()
```

`bamlPatterns()` returns the functions patterns take as config in one object — `planner`,
`router`, `synthesize`, `selector`, `describe`, `describeBatch`, `compactIntent` and
`retrieveQuery` — so the wiring stays one line however many of them a pattern needs. The loop
controllers and the critic come from their own factories, as above.

## Choosing which model each call uses

Every call has a _role_ — `controller`, `planner`, `critic`, `compactExecution`, `router`,
`describe` or `screen` — and each role resolves to a BAML _client_, a named model configuration
(provider, model, limits, fallbacks). Which client wins depends on the _tier_ the run is on: a
string naming a set of clients, such as `anthropic`. A run carries its tier in its _run frame_,
the per-run scope that `withRunFrame` from `@hames-ai/harness-patterns` opens. This package owns
the role → client resolution: `clientOverrideFor(role)` builds the per-call
options bag a call site spreads into its BAML options; `resolveClientForRole(role)` names the
client a call takes (or is budgeted against); `limitsFor(role)` returns the resolved model's
context window and output cap so patterns trim and batch against the right model. All three read
the active tier from the RUN FRAME core opens — `@hames-ai/harness-patterns`'s `inference` slot,
whose `tier` is an opaque string core never interprets. Provider vocabulary lives here, in the
companion, which is why the narrowing and the fail-closed reachability check
(`assertInferenceTier`, which your application calls before it puts a tier in a frame) are this package's:

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

- **Anthropic chains** — the default posture. Every function names an Anthropic chain
  (`ControllerAnthropic`, `ActorAnthropic`, `PlannerAnthropic`, `CriticAnthropic`,
  `SynthesizerAnthropic`, `RouterAnthropic`, `DescribeAnthropic`); the `client X` line on each
  function is what routes a call.
- **Custom endpoint** — a generic `openai-generic` client (`VerdaQwen`) for a self-hosted model,
  and a second one (`LocalQwenSmall`) for a small summarizer endpoint.

### Pointing a custom-endpoint client at your model

The custom-endpoint clients take their endpoint and key from the environment at call time — set
the variables and the client reaches your deployment; nothing in the package changes:

```bash
# the OpenAI-compatible base URL, including the /v1 suffix — BAML hands it to
# openai-generic verbatim, so a root URL 404s every call on <root>/chat/completions
export VERDA_INFERENCE_ENDPOINT=https://your-deployment.example.com/v1
export VERDA_INFERENCE_API_KEY=your-key

# the small summarizer endpoint (the describe-role client on the custom tier)
export SMALL_LLM_BASE_URL=https://your-summarizer.example.com/v1
```

> The hames app layers its own policy on top of this — which tier each conversation uses, waking
> a GPU endpoint that scales to zero, pricing each call — through configuration it registers at
> startup. That is application code (`app/src/lib/inference/` in this repository), not part of
> this package.

## Bring your own provider or model

A consumer can supply its own LLM clients — a different provider, a self-hosted endpoint —
without touching prompts: define runtime clients through a BAML `ClientRegistry`, map the
roles you want off the built-in chains, and the layer composes **on top of** the built-in
tier for exactly the mapped roles (`clientOverrideFor`'s seam; unmapped roles change
nothing, and the injection guard's `screen` role moves only when mapped by its own key). One function type serves
both wiring paths:

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

## No build step

Like every `@hames-ai` package, this one **ships TypeScript source**: `main` and every code target in
`exports` is a `.ts` file — `baml_client/` included, it is committed, generated TypeScript
(`./package.json` is the one non-code entry) — there is no `dist/`, and `pnpm pack` is the whole
publish pipeline. Consumers are **TS-bundler consumers** — a project whose bundler or runtime
compiles TypeScript: Vite/vinxi, esbuild, tsx, Bun. **Not** `node --experimental-strip-types`, which
refuses to strip types under `node_modules` — exactly where an installed package lives
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on Node v22.21.1). A plain
`node dist/index.js` consumer is not supported either, deliberately: a build step would make the
published artefact different from the source every test in this repo runs against.

## Regenerating the client

`baml_client/` is pre-generated and committed, so neither a consumer nor this repo's own app ever
runs BAML's CLI — this package's `baml_src/` is the ONE corpus in the repo, and nothing regenerates
it implicitly (no `predev` hook, no CI step, no docker build step). If you edit a `.baml` file here,
regenerate and commit the result with the source change:

```bash
pnpm baml-generate   # from packages/harness-baml; requires @boundaryml/baml (a dependency)
```

## License

MIT

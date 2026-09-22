# @hames/harness-baml

The BAML companion for [@hames/harness-patterns](../harness-patterns/README.md) — the LLM seam's reference
implementation. Patterns in core take their LLM functions as injected config; this package supplies
them, backed by [BAML](https://boundaryml.com) prompts it declares in its own `baml_src/` and ships
**pre-generated** in `baml_client/` — a consumer never runs `baml-generate`.

## The LLM seam

Every pattern-facing call is an injected function: `(input) => Promise<LLMResult<T>>`, where
`LLMResult` carries the value plus an `LLMCallRecord` with usage, timing and the raw output. The
two loop patterns take their controller (and critic) as the **first argument**; the other
injected functions (`synthesize`, `selector`, `route`, `describe`, `describeBatch`, `compactIntent`,
`retrieveQuery`) arrive as **required config**. There are no defaults inside core — a consumer wires
them in one line through `bamlPatterns()`:

```typescript
import { bamlPatterns, createLoopControllerAdapter } from '@hames/harness-baml'
import { simpleLoop } from '@hames/harness-patterns/patterns/simpleLoop.server'

const patterns = bamlPatterns()
const controller = createLoopControllerAdapter()
const loop = simpleLoop(controller, ['search', 'Return'], {
  patternId: 'my-loop',
  ...patterns,
})
```

`simpleLoop`'s controller is itself an adapter from this package — the other factories below.

## Adapter factories

The factories adapt the raw generated BAML functions to the pattern contracts (call-order,
collectors, usage accounting, cap-hit detection with one corrective retry):

```typescript
import { createActorControllerAdapter, createCriticAdapter } from '@hames/harness-baml'

declare const tools: string[]

const actor = createActorControllerAdapter(tools)
const critic = createCriticAdapter()
```

`bamlPatterns()` assembles all of them (plus `synthesize`, `selector`, `route`, `describe`,
`describeBatch`, `compactIntent`, `retrieveQuery`) into the config object the patterns accept, so
the wiring above stays one line however many functions a pattern needs.

## The role → client seam

This package owns the role → client resolution: `clientOverrideFor(role)` builds the per-call
options bag a call site spreads into its BAML options; `resolveClientForRole(role)` names the
client a call takes (or is budgeted against); `limitsFor(role)` returns the resolved model's
context window and output cap so patterns trim and batch against the right model. All three read
the active tier from the RUN FRAME core opens — `@hames/harness-patterns`'s `inference` slot,
whose `tier` is an opaque string core never interprets. Provider vocabulary lives here, in the
companion, which is why the narrowing and the fail-closed reachability check
(`assertInferenceTier`, called by the host before it puts a tier in a frame) are this package's:

```typescript
import { withRunFrame } from '@hames/harness-patterns/run-frame.server'
import {
  assertInferenceTier,
  clientOverrideFor,
  limitsFor,
} from '@hames/harness-baml/clients.server'

assertInferenceTier('anthropic')
await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
  const opts = { ...clientOverrideFor('controller') } // undefined on the anthropic tier
  const limits = limitsFor('controller')
})
```

## v1 client scope

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

> The host application (kg-agent) layers its own tier policy — env flags, per-user scopes, wake
> hooks, cost pricing — on top of this package through configuration it registers at its
> composition root. That is application configuration, not package surface; see the app's
> `lib/inference/` for the shape.

## Bring your own provider or model

A consumer can supply its own LLM clients — a different provider, a self-hosted endpoint —
without touching prompts: define runtime clients through a BAML `ClientRegistry`, map the
roles you want off the built-in chains, and the layer composes **on top of** the built-in
tier for exactly the mapped roles (`clientOverrideFor`'s seam; unmapped roles change
nothing, and the `screen` role moves only by its own key — SA-M5). One function type serves
both wiring paths:

```typescript
import {
  defineInferenceClients,
  activateConsumerClients,
} from '@hames/harness-baml/consumer-clients.server'

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

Hand `plug` to `AgentDeps.clientOverride` as well — the type is the same `ClientOverride` —
for the package-side call sites outside the adapters (the title generator). Definition-time
validation throws on a malformed config (empty name/provider, `byRole` naming an undefined
client), naming the role and the client — never on turn one. Full walkthrough, including
what happens to unmapped roles and to prompt budgeting:
**[docs/tutorials/own-provider-or-model.md](../../docs/tutorials/own-provider-or-model.md)**.

## No build step

Like every `@hames` package, this one **ships TypeScript source**: `main` and every `exports` target
is a `.ts` file (`baml_client/` included — it is committed, generated TypeScript), there is no
`dist/`, and `pnpm pack` is the whole publish pipeline. Consumers are **TS-bundler consumers** — a
project whose bundler or runtime compiles TypeScript (Vite/vinxi, esbuild, tsx, Bun,
`--experimental-strip-types`). A plain `node dist/index.js` consumer is not supported, deliberately:
a build step would make the published artefact different from the source every test in this repo
runs against.

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

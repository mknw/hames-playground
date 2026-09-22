# Bring your own provider or model

**Audience:** a consumer of `@hames/harness-patterns` + `@hames/harness-baml` who wants the
agents to call a model they supply — a different provider, a self-hosted endpoint — without
touching prompts.

**What V1 is:** _own provider or model, same prompts_ (owner ruling 2026-09-22). You supply
CLIENTS — which model each role's calls go to. You cannot supply prompts, and no accessor to
the generated client ships. The BAML functions, their templates and their output schemas are
exactly the ones the package declares.

---

## 1. Define your clients and map the roles

The whole plug lives in one module, `@hames/harness-baml/consumer-clients.server`:

```typescript
import {
  defineInferenceClients,
  activateConsumerClients,
} from "@hames/harness-baml/consumer-clients.server";

const plug = defineInferenceClients({
  clients: [
    {
      name: "MyEndpoint", // any name; it becomes the registry primary
      provider: "openai-generic", // any BAML provider name
      options: {
        model: "my-model-7b",
        base_url: "https://llm.internal.example.com/v1", // include the /v1 suffix
        api_key: process.env.MY_ENDPOINT_API_KEY,
      },
    },
  ],
  byRole: {
    router: "MyEndpoint",
    describe: "MyEndpoint",
  },
});
```

`defineInferenceClients` validates at **definition time**, never on turn one:

- an empty client name or provider throws, naming the entry;
- a `byRole` key naming a client that is not in `clients` throws, naming **the role and the
  client** — the same mistake made late would surface as BAML's `client 'X' not found` in the
  middle of a live call instead.

The return value is a function `(role) => { clientRegistry, client } | undefined`. It routes
nothing until it is wired in (steps 2–3).

## 2. Hand it to the agent deps

`AgentDeps.clientOverride` takes exactly this function type — the plug drops in with no cast:

```typescript
import type { AgentDeps } from "@hames/agents/types";
import type { ClientOverride } from "@hames/harness-baml/consumer-clients.server";

declare const plug: ClientOverride; // from step 1
declare const yourOtherDeps: AgentDeps;

const deps: AgentDeps = {
  ...yourOtherDeps,
  clientOverride: plug,
};
```

## 3. Activate the layer at the composition root

The agents-deps path covers the package-side call sites outside the adapters (the title
generator). The adapter call sites — controller, actor, critic, planner, describe, the
injection screen — all route through one seam, `clientOverrideFor(role)`, and the consumer
layer is composed **inside that seam**, on top of the built-in tier:

```typescript
import {
  activateConsumerClients,
  type ClientOverride,
} from "@hames/harness-baml/consumer-clients.server";

declare const plug: ClientOverride; // from step 1

activateConsumerClients(plug); // once, at your composition root; `undefined` clears it
```

## What happens to unmapped roles — and to the built-in tier

The composition rule (pinned by the package's own test):

- **A role you map takes your client**, over the built-in tier — whatever tier scope is active.
- **A role you do not map changes nothing.** It runs on the client its BAML function declares
  (the Anthropic chain), or — under a Verda-tier scope — on the built-in private tier.
- With no layer registered, `clientOverrideFor` behaves exactly as it did before the layer
  existed.

## The `screen` role (SA-M5)

The injection screen's client can only ever change **by its own key**. `byRole` is keyed by
role, so mapping `describe` never moves `screen` — the same role separation that keeps a
cheap-summarizer re-pointing from silently carrying prompt-injection screening onto a model
that is worst at exactly what a screener needs (reporting despite the content it reviews;
copying spans verbatim). If you map `screen`, you have made that decision explicitly; if you
do not, nothing about the screen changes.

## Prompt budgeting

`resolveClientForRole` (and therefore `limitsFor`, the trim windows and the describe batch
sizes) reports your client's name for mapped roles. Your client names are not in the host's
model tables until the host adds them, and unknown names fall back **safely**: a 16 384-token
window and the fixed batch ceiling — over-trimming, never overflowing. If your model's real
window and output cap matter (long contexts, big batches), have the host feed your client
names into its `configureModelTables` tables.

## Complete example

A consumer running the ready-made agents against a non-Anthropic OpenAI-compatible endpoint,
keeping the critic on the built-in chain:

```typescript
import {
  defineInferenceClients,
  activateConsumerClients,
} from "@hames/harness-baml/consumer-clients.server";
import { bamlPatterns, createLoopControllerAdapter } from "@hames/harness-baml";
import { simpleLoop } from "@hames/harness-patterns/patterns/simpleLoop.server";
import { searchAgent } from "@hames/agents/agents";
import type { AgentDeps } from "@hames/agents/types";

const plug = defineInferenceClients({
  clients: [
    {
      name: "Llama27B",
      provider: "openai-generic",
      options: {
        model: "meta-llama/Llama-3.3-27B",
        base_url: "https://llm.internal.example.com/v1",
        api_key: process.env.LLM_ENDPOINT_API_KEY,
        max_tokens: 8192,
      },
    },
  ],
  // The critic is deliberately absent: critique stays on the built-in chain.
  byRole: {
    controller: "Llama27B",
    router: "Llama27B",
    describe: "Llama27B",
  },
});

activateConsumerClients(plug);

const deps: AgentDeps = {
  toolNamespaces: (toolName) => undefined, // your catalog, as AgentDeps requires
  clientOverride: plug,
};

// `searchAgent.createPatterns(sessionId, deps)` now builds a chain whose
// controller, router and describe calls go to Llama27B — same prompts, same
// adapters — while its critic runs on the declared Anthropic chain.
```

To verify a render offline (no socket), the package ships `b.request.<Fn>(...)`:

```typescript
import type {
  RouteOption,
  Message,
} from "@hames/harness-baml/baml_client/types";
import type { ClientOverride } from "@hames/harness-baml/consumer-clients.server";

declare const plug: ClientOverride; // from step 1
declare const routes: RouteOption[];
declare const history: Message[];

const { b } = await import("@hames/harness-baml/baml_client");
const render = await b.request.Router("q", routes, history, plug("router")!);
render.body.json().model; // → 'meta-llama/Llama-3.3-27B'
```

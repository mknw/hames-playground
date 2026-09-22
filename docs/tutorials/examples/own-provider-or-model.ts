// docs/tutorials/examples/own-provider-or-model.ts
//
// The worked example for `docs/tutorials/own-provider-or-model.md`. Every line of
// code below is lifted VERBATIM from that page's own TypeScript fences —
// nothing here is a paraphrase, and the pin
// `app/src/__tests__/docs/tutorials-examples-pins.test.ts` re-extracts those
// fences on every CI run and fails if this file and the page disagree by a
// byte. Outside them the file may carry only comments and `console.log`
// echoes, so the wiring you read here is the page's wiring.
//
// Taken:     #4, the page's own "Complete example".
// Not taken: #1 §1, #2 §2, #3 §3 — the step-by-step build-up the complete
//            example supersedes, and #2/#3 restate step 1's `plug` as a
//            `declare const`; #5, the offline-render fence, restates it the
//            same way and would redeclare the real one.
//
// RUNS OFFLINE, and makes no network call: `defineInferenceClients` validates
// at definition time and `activateConsumerClients` only registers the layer.
// Pointing it at a real endpoint is the reader's step, not this file's.

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

---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
"@hames-ai/agents": minor
---

`general-next` answers "what can you do?", "help" and "how do I start?" from a capability guide. `Synthesize` gains a trailing optional `guide`, rendered in its leading system block; a null guide leaves the request byte-identical. `@hames-ai/harness-baml` exports `createSynthesizer({ guide })`, a `compactExecution` synthesizer that carries it. `@hames-ai/agents` exports `capabilityGuide()`, which builds the guide from the tools a composition holds, so a deployment without a tool is never told it has one. `AgentDeps` gains `examplesPage: { href, label }`, the host's page of example questions, which the answer links; the reference app passes its `/use-cases` page. The guide rides only a turn that ran no route: `compactExecution`'s `thread` input gains `stepsThisTurn` (`@hames-ai/harness-patterns`), the number of steps the current turn authored, and `general-next` passes the guide only when it is 0.

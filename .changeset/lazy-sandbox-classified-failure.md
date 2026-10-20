---
"@hames-ai/sandbox": minor
"@hames-ai/agents": patch
---

Add `withSandbox({ lazy: true })`: the sandbox starts on the first `sandbox_*` call rather than at the turn's entry, so a turn that only reads Microsoft 365 data needs no container engine. A sandbox that cannot start now fails the call with a fixed, classified sentence (`classifySandboxFailure`); the engine's own error goes to the server log only and never reaches the model. The general-next office route opts in.

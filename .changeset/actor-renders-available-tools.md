---
"@hames-ai/harness-baml": patch
"@hames-ai/agents": patch
---

`createActorControllerAdapter` now renders `input.availableTools` together with its own `toolNames`, so an actor pattern's allowlist no longer has to be declared twice. `general-next` drops its duplicate `toolNames`.

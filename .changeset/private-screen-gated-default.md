---
'@hames-ai/agents': patch
---

The general-next agent now uses `gated` as the self-deployed injection screen default. The gate's answer controls whether eligible content reaches the model screen; an explicit `shadow` mode still records the answer and runs the screen. The Anthropic default remains `always`.

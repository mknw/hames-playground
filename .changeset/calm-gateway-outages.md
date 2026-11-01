---
"@hames-ai/harness-patterns": minor
---

Preserve an unavailable MCP gateway signal across decision-loop routes so a turn that needed gateway data reports the outage instead of synthesizing an unsupported answer. `ErrorEventData.kind` gains `gateway_unavailable`.

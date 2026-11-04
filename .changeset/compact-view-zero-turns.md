---
"@hames-ai/harness-patterns": patch
---

`EventView.serializeCompact({ recentTurns })` no longer throws on a `recentTurns` of 0 or a fraction (#499). Zero or fewer recent turns means no turn is recent, so every older `tool_result` renders as a compact pointer; a fractional count is floored first.

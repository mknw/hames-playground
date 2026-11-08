---
"@hames-ai/harness-patterns": patch
"@hames-ai/harness-baml": patch
---

An LLM call record carries `promptChars`, the character count of the rendered prompt its selected request sent (the text of its messages and a top-level `system`, not the JSON around them). It is a count, never content, so `redactCall` keeps it: a redacted record (the synthesizer's on the saved `assistant_message`) still says how big the prompt was. The general-next eval reads it to report the answer writer's input size per turn (#1032). Nothing routes or renders on it.

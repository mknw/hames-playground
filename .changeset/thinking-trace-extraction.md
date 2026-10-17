---
"@hames-ai/harness-baml": minor
---

Add `@hames-ai/harness-baml/thinking-trace` (#625 S1): `thinkingFrom(call)` reads a model's thinking trace from a BAML collector call's raw response body (OpenAI-compatible `reasoning_content` or `reasoning`; Anthropic `thinking` blocks) and returns it verbatim or as a typed absence, and `splitAtLastThinkClose(raw)` cuts a no-parser response at its last `</think>`. Nothing calls either yet; no routing, BAML or client change.

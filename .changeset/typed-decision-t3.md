---
'@hames-ai/harness-baml': minor
---

Add `createDecideAdapter()` and the `decide` role with recorded clients per tier: `JevDecide` on the Anthropic tier and `PrivateSystemOne` on the private tier. Private decisions require the full `SMALL_LLM_DECISIONS_URL` ending in `/v1/systemone`, reuse `SMALL_LLM_API_KEY`, and refuse an unset URL without a public fallback. Price `PrivateSystemOne` by measured call duration at `SMALL_LLM_EUR_PER_HOUR`.

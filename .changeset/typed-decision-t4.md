---
'@hames-ai/harness-baml': minor
'@hames-ai/harness-patterns': patch
---

Add the systemone transport with single-question and one-request set adapters, supporting choice, score and noul questions with endpoint probabilities passed through untouched. The Anthropic-tier `JevDecide` client uses `JEV_DECISIONS_URL` and `JEV_DECISIONS_API_KEY`; failed requests never retry on another provider. Record usage and the serving client; add the `provider` cost basis for reported USD cost converted once to EUR, with absent cost remaining unknown.

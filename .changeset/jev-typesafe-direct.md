---
'@hames-ai/harness-baml': patch
---

Support a directly configured systemone endpoint with its native model ID and request shape. Require an explicit `JEV_DECISIONS_URL` and separate `JEV_DECISIONS_API_KEY` on the Anthropic tier; refuse missing configuration, redirects and answers outside the asked set. The private tier uses its separate endpoint and shared small-model key, with no public fallback.

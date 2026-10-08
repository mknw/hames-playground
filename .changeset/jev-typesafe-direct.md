---
"@hames-ai/harness-baml": patch
---

Support TypeSafe's direct Jev API with its pinned native model ID and no OpenRouter-only fields. Require an explicit `JEV_DECISIONS_URL`: unset, decisions abstain before the key is read, with the TypeSafe default switch pre-built behind a disabled owner gate. Explicit configuration can use TypeSafe now with a non-enterprise key, under standard retention. Keep OpenRouter as an explicit alternative with zero-retention and data-collection-denied preferences, preserve separate credentials and the private-tier lock, refuse redirects and labels outside the asked set, and bind calibration fingerprints to the configured route's model through the transport's shared endpoint lookup, including the gated default when enabled.

---
'@hames-ai/harness-baml': minor
'@hames-ai/agents': patch
---

Refuse thinking leaves selected through registry chains for functions without a designated thinking counterpart, retaining usage accounting and preventing corrective retries on the unsupported leaf.

Behaviour change for custom controllers: `accountBamlCall`, `withUsageAccounting`, `extractLLMCallData` and `extractFailureLLMCallData` now throw a non-recoverable `LLMCallError` after accounting when the selected leaf or rendered request enables thinking for an undesignated function. `THINKING_FUNCTIONS_BY_CLIENT` is a new public export listing designated counterparts.

Client overrides carrying `collector` are refused by both routing lookups; adapters and the title agent retain their own accounting collector.

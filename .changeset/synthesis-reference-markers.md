---
"@hames-ai/harness-baml": minor
"@hames-ai/harness-patterns": patch
---

Make Synthesize request numbered citations for supplied document locators and list their sources in a Sources legend. The default synthesizer derives a citation-only projection from retained retriever results and complete read-documents locator records, verifying multi-call producers against the call roster. Custom route ids do not receive text-derived citations; typed locator metadata on core records remains a separate owner API decision. The harness-patterns SPEC input table documents the companion's optional slots. Low-level Synthesize callers must pass the new optional references slot after memory_context and before the BAML options bag; pass null when no references exist. Requests without references retain their previous prompt text.

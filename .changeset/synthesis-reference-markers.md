---
"@hames-ai/harness-baml": minor
---

Make Synthesize request numbered citations matching supplied document locators or exact reference URLs. The default synthesizer derives a citation-only projection from retained sanitized retriever results and decision-loop locator lines. Low-level Synthesize callers must pass the new optional references slot after memory_context and before the BAML options bag; pass null when no references exist. Requests without references retain their previous prompt text.

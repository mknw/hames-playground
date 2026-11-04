---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

Add the organizational-knowledge hook: `settleOrgKnowledge` (a post-reply proposal over a Decide gate, a read-only draft loop and the ontology validator; it never writes), `applyOrgProposal`, `createOrgDraftLoop`, `parseOrgDraft`, the `orgKnowledge.confirm` request and payload parser, and `withOrgKnowledge` with the `harnessUsesOrgKnowledge` probe. `@hames-ai/harness-baml` gains the `orgDraft` role (the small box on the private tier, the controller chain on the Anthropic tier), `createLoopControllerAdapter`'s `role` option, and a private-only check that accepts the private client of any role listing the called function.

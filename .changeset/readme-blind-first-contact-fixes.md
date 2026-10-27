---
"@hames-ai/harness-patterns": patch
"@hames-ai/harness-baml": patch
"@hames-ai/agents": patch
"@hames-ai/connectors": patch
"@hames-ai/sandbox": patch
---

docs: README fixes from the blind first-contact read before the 0.4.0 cut (#818). The stale "These packages are at 0.1" note is restated truthfully at 0.4.0 in all five READMEs. `@hames-ai/agents`: one agent count everywhere (five verified against the source barrel, including the package description); `guards` and `egressRoster` join the `AgentDeps` excerpt; the four `GUARD_*` operator switches the prose promised "below" are now listed with their values; the `general` → `general-next` migration and the internal shorthand in the general-next paragraph are behind absolute links. `@hames-ai/harness-baml`: the Systemone section now says what the decisions endpoint is, that it is optional and how to configure one, explains `noul`, and links the preview runbook section absolutely. `@hames-ai/connectors`: the graph-edit write ops get a one-paragraph example and a statement of how they coexist with the agents' read-only guarantee, and the shipped `./document` subpath is named in the exports table.

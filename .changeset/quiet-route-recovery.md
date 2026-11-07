---
"@hames-ai/harness-patterns": patch
"@hames-ai/agents": patch
---

Record which exhausted route a successful authorized budget retry replaces.
Exclude that obsolete failure from synthesis and replayed transcript warnings
while preserving the historical events and unrelated failures.

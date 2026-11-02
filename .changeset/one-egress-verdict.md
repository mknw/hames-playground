---
"@hames-ai/harness-patterns": patch
---

Replace the egress gate's five answer shapes with one discriminated verdict union (refuse, hold, batch-hold, batch-pass, audit, void), write the phase-legality table once beside the type, and return the step-1 refusal rule as data, removing the text-to-rule reverse map. No behaviour change: every refusal keeps its fixed text and fail-closed stays fail-closed.

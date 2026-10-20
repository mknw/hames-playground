---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": patch
---

Add the planner-only `screenOutput: false` decision-loop route option and use it on general-next's think route. Model-authored plans keep deterministic sanitization, findings and provenance fences while skipping the model second opinion; tool results and other routes retain their existing screening.

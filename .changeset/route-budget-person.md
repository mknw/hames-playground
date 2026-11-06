---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

general-next asks the person when a bounded route exhausts its attempts. The existing HITL dialog offers an answer from partial results or one fresh dispatch with three more attempts, clamped to the runtime ceiling. The summary explains that a fresh dispatch may repeat sandbox file writes. Unattended runs choose answer immediately and keep their existing control flow.

Routes opt in through `DecisionLoopRoute.withBudget`, which reconstructs the same wrapped route with the new declared budget. Other decisionLoop consumers keep their behavior. A loop-owned post-route continuation preserves completed events across pause/resume without requiring actorCritic or the sandbox to become resumable. The host's hung-turn backstop accounts for the one additional dispatch.

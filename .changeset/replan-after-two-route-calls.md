---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

Re-planning after other route calls, and cross-route hints in `general-next` (#1031).

- `decisionLoop` routes take `minPrePlanningBranchCalls: N` on a planner route: once a plan exists this turn, the planner is offered again only when at least N−1 non-planner route iterations ran since the last planner iteration (succeeded or failed), so a re-plan is at the earliest the Nth call, and only while at least two iterations remain (`iteration <= maxIterations - 2`), so a route and the answer can still follow it. The first plan of a turn is unaffected, the repeat rule still binds, and the newest plan replaces the earlier one. Absent, the planner guard is unchanged. Construction refuses it on a route that is not a planner, together with `allowReplan: true`, and below 2 or not an integer.
- `general-next` sets it to 3 on `think`. Its decisions model (route descriptions and question) and its planner (agent-map capability lines) are told that a file `office-data` copies in with `graph_file_ingest` can then be read by `read-documents` (only where ingest is available), that `info-retrieval`'s knowledge graph can identify people in the organisation before `office-data` searches mail or files involving them, and that a request whose routes feed each other goes to `think` first.

---
"@hames-ai/agents": patch
---

**`general-next`: the office-data route says that the user indexes a saved file, not the agent.** Its description now states that a file saved under `/work/out` is kept in the conversation's documents, that the user can index it for search from the Data Stash, and that the route indexes nothing itself. Asked to index a file, the route saves it and tells the user where to index it. Because the description is part of the route's entry, it reaches the decision model, the planner's map, and the office actor and critic through the route scope.

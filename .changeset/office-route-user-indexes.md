---
"@hames-ai/agents": patch
---

**`general-next`: the office-data route says that the user indexes a saved file, not the agent.** Its description now states that a file saved under `/work/out` is kept in the conversation's documents, that the user can index a text one for search from the Data Stash, and that the route never indexes such a file itself. Asked to index one, the route saves it and tells the user where to index it. A OneDrive or SharePoint copy made with `graph_file_ingest` is still indexed by that tool, as before. Because the description is part of the route's entry, it reaches the decision model, the planner's map, and the office actor and critic through the route scope.

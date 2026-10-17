---
"@hames-ai/agents": patch
---

general-next: the office-data actor's prompt now lists the Graph read tools. They were allowlisted on the route but the actor adapter never received them, so the model was shown only the sandbox tools. `graph_file_ingest` stays withheld by exact name.

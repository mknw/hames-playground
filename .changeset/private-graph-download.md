---
"@hames-ai/connectors": minor
"@hames-ai/agents": patch
---

Require hosts registering Graph tools to supply a per-call `fileIngestAllowed`
predicate. File ingestion refuses before I/O unless that predicate positively
allows the call, and refuses OpenRouter embedding. The app requires both an
explicit private run frame and a private-only deployment until tier-flip release
is implemented. General-next now offers guarded Graph file ingestion in its
office route, preserving original bytes for sandbox analysis and cited retrieval.

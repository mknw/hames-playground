---
"@hames-ai/connectors": minor
"@hames-ai/agents": patch
"@hames-ai/harness-patterns": patch
---

**Breaking for hosts registering Graph tools:** supply a per-call `fileIngestAllowed`
predicate. File ingestion refuses before I/O unless that predicate positively
allows the call, and refuses OpenRouter embedding. The app requires both an
explicit private run frame and a private-only deployment until tier-flip release
is implemented. General-next advertises Graph file ingestion in its
office route only when the host enables the deployment capability, preserving original bytes for sandbox analysis and cited retrieval.

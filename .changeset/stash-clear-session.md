---
'@hames-ai/harness-patterns': minor
---

New `deleteSessionStash(sessionId)` in `stash/document-ingest.server`: removes a session's documents, chunk records, index entry and recorded embedding space, attempting every step and reporting any failure after. Supporting additions: `listSessionDocumentIds` in `stash/document-store.server`, and the `scan_all_keys` verb in the host's direct Redis transport.

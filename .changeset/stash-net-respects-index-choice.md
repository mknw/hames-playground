---
"@hames-ai/harness-patterns": patch
---

**The retriever's ingest safety net respects the per-document "Index for search" choice (#836).** `ensureSessionIngested` indexed a sandbox output whose `ingestStatus` was absent — but a promotion from `/work/out` stores no status precisely because indexing it is the person's choice, so "absent" there means "not chosen", not "the gate never fired". A first search now leaves an unchosen sandbox output unindexed (the Data Stash button is what indexes a **text** output; a binary output is indexable by no path today, #853), while a chosen one — `pending`, `indexed`, or `failed` — is handled exactly as before (`failed` retried). Uploads without the sandbox provenance keep the net's original coverage.

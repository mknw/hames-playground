---
"@hames-ai/harness-patterns": patch
---

Migrate the ingress guard's `exfil-data-url` rewrite path onto the url-seam plus an explicit offset map (`OffsetMap`) that `sanitizeText` maintains across earlier rewrites; no behaviour change.

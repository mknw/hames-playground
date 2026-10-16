---
'@hames-ai/harness-patterns': minor
---

Add the opt-in injection guard option screenDespiteFindings. It screens the
deterministically sanitized projection even after rule hits, preserving their
neutralizations and findings. Nested guards keep this option enabled if either
guard requests it; screen failures remain recorded and non-fatal at this layer.

Screen detections preserve an existing provenance fence instead of nesting a
second one, keeping downstream identity extraction correct.

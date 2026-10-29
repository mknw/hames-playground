---
"@hames-ai/harness-baml": patch
---

The legacy-name fold no longer tells an operator to remove the only copy of a value (#733). `inference-env.server.ts` records the canonical names its own fold wrote on a `globalThis` symbol (the one policy holder's pattern), so a second bundled copy of the module — whose `warned` set is fresh while the fold's copies are already in the environment — reports the legacy names as deprecated, not as `IGNORED because the new name is set; remove it`. A name the operator set before the fold is never recorded, so a genuine legacy-vs-new conflict still reports IGNORED. New export `__resetInferenceEnvFoldForTests` (test isolation for that record; no consumer code change).

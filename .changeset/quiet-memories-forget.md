---
"@hames-ai/harness-patterns": patch
---

Re-check the memory switch under each candidate transaction's owner lock so an in-flight settle cannot write after switch-off. Document M7's switch-before-delete requirement and serialized forget-all semantics.

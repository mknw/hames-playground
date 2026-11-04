---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

The organizational-knowledge draft loop now runs on the private tier's 27B (`orgDraft` maps to `LargeQwen`), and asks for its verdict through a new `returnStyle: 'json'`: the loop's `Return` carries the one JSON object its context specifies, and the prompt no longer tells the model to answer in plain prose. The draft's schema also says a named node the graph does not hold yet is proposed as new unless its class is link-only.

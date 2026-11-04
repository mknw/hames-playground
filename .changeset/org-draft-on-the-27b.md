---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
---

The organizational-knowledge draft loop now runs on the private tier's 27B (`orgDraft` maps to `LargeQwen`), and asks for its verdict through a new `returnStyle: 'json'`: the loop's `Return` carries the one JSON object its context specifies, and the prompt no longer tells the model to answer in plain prose. The draft's schema gains `ORG_NEAR_MATCH_RULE`: before proposing a node as new, search its class for a near-match (case-insensitive `CONTAINS` on the name's distinctive word) and link to a node it finds; only a search that finds nothing makes a node new, unless its class is link-only.

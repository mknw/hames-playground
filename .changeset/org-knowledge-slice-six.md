---
"@hames-ai/connectors": minor
"@hames-ai/harness-patterns": minor
---

Canvas graph edits adhere to the ontology. `@hames-ai/connectors`' `createGraphNode`, `linkGraphNodes` and `setGraphNodeProperty` now take the host's ontology and an actor: they admit only the ontology's labels, relation types and declared properties, merge a repeated name onto one node, refuse member and pillar creation and a second edge of a bounded relation, and stamp `createdBy` / `lastEditedBy`. **Breaking** for callers of the old signatures. `@hames-ai/harness-patterns`' `org-knowledge-ontology` gains `propertyRefusal`, `canvasCreateRefusal`, `canvasCreatableLabels`, `canvasLinkRefusal` and `isIsoDay`, which the validator's V2 now shares.

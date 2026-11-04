---
"@hames-ai/harness-patterns": minor
---

Add the organizational-knowledge ontology seam and its validator: `org-knowledge-ontology` (`defineOntology`, which refuses a malformed declaration at load; `nameKey`; `valueTokens`) and `org-knowledge-validate.server` (`validateOrgDraft`, the pure V1–V10 check every drafted node, property and edge passes before a person sees it, with an assertion cap). Nothing calls the validator yet.

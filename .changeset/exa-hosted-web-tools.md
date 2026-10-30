---
"@hames-ai/agents": minor
"@hames-ai/connectors": minor
---

Expose Exa's hosted `web_search_exa` and `web_fetch_exa` tools through the existing `web` namespace (#874). Search and retrieval routes apply the shared web egress policy and untrusted-result screening, while the connector catalog names both tools for namespace routing.

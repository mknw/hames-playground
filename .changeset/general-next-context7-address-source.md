---
"@hames-ai/agents": patch
---

**`general-next` declares `context7` as an egress address source only when the gateway offers a context7 tool**, as its info guard already did. The egress gate refuses, on every turn, an `addressSources` namespace no catalog tool resolves to, so a gateway without context7 failed every `general-next` turn before any route ran. With no context7 tool there is no context7 result to give an address, so nothing the gate allows changes.

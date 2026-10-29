---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

The injection guard can exempt links a source writes itself from `exfil-data-url` (#784 item 6). `InjectionGuardOptions` gains `sourceLinks: { namespace, field, hosts }`: a string under that key, in a result from that namespace, whose whole value is one `https:` URL on exactly one of `hosts`, skips that rule and no other. `AgentGuards` gains `documentHosts`; `general-next`'s office guard and `microsoft-365`'s guard exempt the Graph tools' `webUrl` on them. The reference app reads them from `GRAPH_DOCUMENT_HOSTS` and refuses boot on an entry that is not a bare hostname.

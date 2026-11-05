---
"@hames-ai/agents": patch
---

`ReplayedMessage` gains an optional `recognisedLinkHosts` field — the server-computed link-review verdicts (#901 slice 1): the recognised hostnames among an assistant message's own http(s) links. Replay itself never fills it; the serving boundaries (history load, the shared transcript) decorate assistant messages with it, and the chat renderer treats every http(s) link without a verdict as unverified, fail-closed.

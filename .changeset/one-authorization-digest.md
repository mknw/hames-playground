---
"@hames-ai/harness-patterns": patch
---

Give the batch authorization digest — the sha256 of a call's canonical tool and arguments that binds an approved checklist row, a durable send claim and a re-entered call to the same call — one exported owner, `authorizationDigest`, beside `canonicalJson` in `hitl.server.ts`, and consume it from every site that computed it by hand: `simpleLoop`'s row digest and resumed-plan revalidation, `withEgressGate`'s re-entry recompute, `mcp-client`'s send claim, and the egress, batch-boundary and asking-the-person tests that re-encoded it. No behaviour change: every join keeps failing closed exactly as before; the digest's spelling just stops being six copies that could drift.

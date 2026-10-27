---
"@hames-ai/harness-patterns": minor
---

**The egress gate and the ingress screen can ask the person (boundary guards slice 10).**

- `withEgressGate({ askPerson: true })`: a Decide refusal and the D5 person cells raise an `egress-release` request (Refuse, Accept, Refuse all similar actions, Interrupt; Refuse the default and the only unattended pick) where the call can pause, instead of refusing. The call is held, not sent; on re-entry the loop dispatches it again under the same call key and the gate answers from the recorded decision. Unattended, inside a batch, or on a path that cannot pause, the cells refuse as before. While on, every outgoing name is a gated name at construction.
- A screen with `askPerson: true`: a finding raises an `ingress-flag` request (Leave it out, Use it without the flagged text, Use it unchanged); the host's `resolve` returns `ingressFlagResolution(choice, payload)`. Unattended the result is left out; attended on a path that cannot pause it is neutralised and says so.
- New: `canPauseHere()`, `recordedHolding()`, `askHumanHolding(request, payload, authorizes?)`, an `EgressCheck` may return `{ held }`, `HeldResult.redispatch`, run-frame slots `continuationRoot` and `batch`, a continuation step's `child`, `EGRESS_RELEASE_KIND` / `EGRESS_RELEASE_OPTIONS` / `EGRESS_HELD_NOTE`, `INGRESS_FLAG_KIND` / `INGRESS_FLAG_OPTIONS` / `INGRESS_TEXTS`. `EgressAuditEventData.probs` is optional (absent when a person released the call).

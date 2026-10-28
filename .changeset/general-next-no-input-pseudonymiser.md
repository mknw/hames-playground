---
"@hames-ai/agents": minor
"@hames-ai/harness-patterns": patch
---

**`general-next` composes no input pseudonymiser: its web route reads earlier results as they are, and the egress gate is the only control on what leaves.**

- `general-next` no longer wraps its info route in `withPseudonymisedInputs`, on any tier and whatever the host's `guards` bag holds. Its controller sees names as written, nothing is withheld for want of a filter, and no route receives `webRosterInput`. Every outgoing call is still judged by `withEgressGate`, on every tier.
- **Breaking (pre-1.0, so a minor bump): `AgentGuards.pseudonymiseForWeb` is removed.** No registered agent read it any more, and a field nothing reads would look like protection to a host that sets it. Migration: drop the field from your `guards` bag; if you want the rewrite, compose `withPseudonymisedInputs({ pseudonymise })` around your own route.
- The `GUARD_PSEUDONYMISE` operator switch is retired with it. The reference host no longer parses it; a still-set value logs one boot warning that it has no effect, whatever the value.
- `@hames-ai/harness-patterns`: no code change. `withPseudonymisedInputs` stays for library users; SPEC and GUIDE now say the reference agent does not compose it.

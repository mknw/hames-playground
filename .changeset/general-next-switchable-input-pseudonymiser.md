---
"@hames-ai/agents": minor
"@hames-ai/harness-patterns": patch
---

**`general-next` composes its input pseudonymiser exactly when the host supplies the filter.**

- With `guards.pseudonymiseForWeb` supplied, the info route is wrapped in `withPseudonymisedInputs` as before. The reference app supplies it by default (`GUARD_PSEUDONYMISE` unset or `on`), and keeps it on until a later release flips that default.
- Without it (`GUARD_PSEUDONYMISE=off`, or a deps bag with no `guards` field at all) the route is composed with no wrapper. **Changed default for library hosts (pre-1.0, so a minor bump):** a bag with no `guards` used to compose the wrapper with no filter, which withheld every earlier result off the Anthropic tier. Earlier results now reach the info controller as written, and the egress gate still judges every outgoing call. To keep names out of that context, supply a filter.
- `@hames-ai/harness-patterns`: no code change. GUIDE's summary row for `withPseudonymisedInputs` no longer says it checks outgoing arguments (the egress gate took that), and SPEC states when `general-next` composes it.

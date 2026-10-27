---
"@hames-ai/harness-patterns": minor
---

Add `isGuardEvent(type, data)` to `observability/projection`: the injection
guard's `content_sanitized`, its screen `model_call` and the `guard.screen`
decision, the egress gate's `guard.egress` decision, `egress_audit`,
`egress_refused` and `egress_check` warnings, and K5's `web_privacy` warning.
`getEventPreview` leads a guard's preview with the guard's name, previews the
egress audit and refusal records (counting matched names, never quoting them)
and K5's warning by its reason and count; `getEventLane` is unchanged. K5's
`web_privacy` warning now carries `detail: { reason, events, fields }`; a host
names the reason by throwing the new `RosterUnavailable`, and no error's
message or name is read. The egress gate records its empty- or
unreadable-directory warning once per turn at the first outgoing check, so a
turn with no outgoing call records none.

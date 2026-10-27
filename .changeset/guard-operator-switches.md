---
"@hames-ai/harness-patterns": patch
"@hames-ai/agents": minor
---

**The guards' operator switches: the host's `GUARD_*` variables reach the agents through one `AgentDeps.guards` field.**

- New on `AgentDeps`: `guards?: AgentGuards` — `{ screenMode?, egressMode?, classifyIngress?, pseudonymiseForWeb? }`, the four fields the guard settings compose under. `screenMode` replaces `general-next`'s screen tier map (`ByTier<ScreenMode>`), `egressMode` sets the egress gate's `mode` (`ByTier<EgressMode>`; absent keeps `'filter'`), `classifyIngress` and `pseudonymiseForWeb` carry what their two old `AgentDeps` fields carried.
- **Breaking (pre-1.0, so a minor bump): `AgentDeps.classifyIngress` and `AgentDeps.pseudonymiseForWeb` are removed** — both move under `guards`, so the screen's gating has one `AgentDeps` path, not two. Hosts pass `guards: { classifyIngress, pseudonymiseForWeb }` instead of the two flat fields. With a `guards` bag present but no `pseudonymiseForWeb`, `general-next` composes its info route WITHOUT `withPseudonymisedInputs` (the `GUARD_PSEUDONYMISE=off` reading: the switch is off, not unconfigured); a bag with no `guards` field at all keeps the old shape — the wrapper is composed with no filter, which withholds inherited content rather than pass it through unfiltered (G14 D3).
- `AgentDeps.egressRoster` stays its own field: it is wiring the gate reads at run time, not a switch, and no `GUARD_*` variable turns the roster on or off.
- `@hames-ai/harness-patterns`: nothing changes — the switches set values its existing `ByTier` settings already take (`ScreenMode` for the screen, `EgressMode` for the gate), and a patch bump records that the package gained no surface in this slice.

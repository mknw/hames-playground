---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

The guard thresholds and the egress tripwire's N are settings (#844). `AgentGuards` gains `gateThreshold` (τi), `egressThreshold` (τe) and `maxOutgoingRetriesPostTripwire` (N); `general-next` passes them to `createGuardGate` and `withEgressGate`, and keeps today's values (0.15, 0.3, 0) when they are absent. `@hames-ai/harness-patterns` exports `GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE` (0), the egress gate's default N. The reference app reads them from `GUARD_GATE_THRESHOLD`, `GUARD_EGRESS_THRESHOLD` and `GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE`: an out-of-range value refuses boot, a looser one warns once.

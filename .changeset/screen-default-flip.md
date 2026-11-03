---
'@hames-ai/agents': patch
'@hames-ai/harness-patterns': patch
---

The general-next agent's injection screen now defaults to `off` on both inference tiers, from one shared per-tier policy value (`SCREEN_POLICY_BY_TIER`) that the composition root's boot validation reads too; the `GUARD_SCREEN` switches narrow to `off | always` per tier (a still-set `gated` or `shadow` refuses boot naming the change), and `GUARD_GATE_THRESHOLD` retires (a still-set value refuses boot naming the replacement).
The SPEC's guard-gate section now records that the reference app retired `GUARD_GATE_THRESHOLD`: a still-set value refuses boot there, and τi is code-owned.

---
"@hames-ai/harness-patterns": minor
"@hames-ai/agents": minor
---

The injection-ingress-guard classification replaces the guard gate (boundary guards revision 6, slice 17). `withInjectionGuard` takes a new `ingressGuard: { run: createIngressGuard(decide), mode }` option: one `choice` question keyed `guard.ingress` (`safe` / `possible-instructions-for-ai` / `instructions-for-ai-detected`) per external payload, at the existing Decide seam, driving presentation only — nothing is withheld. Mode `'off'` (default) / `'shadow'` (records a `decision_made` event, attaches no mark) / `'on'` (attaches an `IngressMark` — label, the safe line's pass, the decision event id — to the result, which the loops copy onto the `tool_result` event as `ingress` and the retriever attaches per hit). The presented label applies `GUARD_INGRESS_SAFE_LINE` (0.7), measured against the private decision box's choice answers before it was set.

Breaking: the guard gate is removed — `createGuardGate`, `GUARD_SCREEN`, `GUARD_GATE_THRESHOLD`, `GUARD_GATE_TIMEOUT_MS`, `guardGateSkipRate`, the `GuardGate` / `GuardGateVerdict` types, `InjectionScreenConfig.gate`, and the screen's `'shadow'` / `'gated'` modes (a screen declaration carrying either now refuses construction; `ScreenMode` is `'off' | 'always'`). `drawFenceNonce`, `renderGuardGateState` and `LINE_BREAK` are now exported from the package root. A screen's `exempt` namespaces are exempt from the classification too.

general-next composes no gate; its office, info and documents guards declare `ingressGuard` (the documents guard without a screen) at `AgentGuards.ingressMode`, default `INGRESS_POLICY_DEFAULT` (`'off'`); `AgentGuards.gateThreshold` is removed. The reference app reads `GUARD_INGRESS=off|shadow|on`, one value for both tiers; an unknown value refuses boot.

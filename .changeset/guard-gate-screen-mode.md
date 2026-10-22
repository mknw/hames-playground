---
"@hames-ai/harness-patterns": minor
"@hames-ai/harness-baml": minor
"@hames-ai/agents": minor
"@hames-ai/connectors": minor
---

**Breaking (pre-1.0, so a minor bump): the injection guard's `screen` option is a config object, and its model screen can sit behind a gate.**

- `screen` takes `{ run, mode?, gate?, onUnavailable?, exempt?, classify? }` instead of a bare `InjectionScreen`. `run` is the screen you passed before.
- `mode` is `'off' | 'shadow' | 'gated' | 'always'`, per tier: a bare value or a `ByTier` map such as `{ default: 'shadow', anthropic: 'always' }`, resolved per call against the registered `effectiveTier()` by the new `resolveByTier()`. Default: `'always'` for a screen alone, `'shadow'` when a `gate` is passed. A mode that asks a gate with none passed refuses construction, and so do a `run` that is not a function, a mode that is not one of the four (on any tier), a per-tier map with no `default` and an `onUnavailable` other than `'pass'` or `'withhold'`. Read per call, an unrecognised mode runs the screen and an unrecognised `onUnavailable` withholds.
- **Removed: `screenDespiteFindings`.** A deterministic finding now forces the screen in every mode but `'off'`, on the sanitized projection and with no gate call. A guard that declared a screen without that option used to skip the screen on any result with a finding; it now screens it, one more model call per such result.
- New: `createGuardGate(decide, settings?)` and `GUARD_SCREEN` (the `guard.screen` noul question), `guardGateSkipRate(events)`, `neutralizeFenceMarkers()` (the screen's fence neutraliser, now shared), `SCREEN_WITHHELD`, `resolveByTier()`, and the `ByTier`, `ScreenMode`, `GuardGate`, `GuardGateVerdict`, `IngressClass`, `IngressClassifier` and `InjectionScreenConfig` types. Each gate answer is a `decision_made` event keyed `guard.screen`.
- `onUnavailable: 'withhold'` replaces a payload whose screen threw with a fixed marker; `'pass'`, the default, keeps today's behaviour.
- `exempt` names declared namespaces neither the gate nor the screen runs on; an undeclared one refuses construction. `classify` is the host's: an `'internal'` payload gets the deterministic layer only, unless it has a finding; without one every payload is external.
- `DecideInput` gains an optional `signal`, which `evaluateDecision` passes through and the systemone transport hands to its fetch, so a caller's deadline aborts the request. `LlmUsageSample` gains `decisionKey` for Decide calls.
- `ScreenUntrustedContent`'s definition of an injection now matches the gate's question word for word (text aimed at the AI reading it, with one behaviour list); its signature is unchanged.
- `@hames-ai/connectors`: `registerGraphConnectorTools` takes an optional `homeDomains` supplier; the mail, calendar, shared-with-me and mail-attachment tools stamp each item and result with a non-enumerable `GRAPH_PROVENANCE` (`'home' | 'external' | 'unknown'`) computed from the raw addresses before shaping, read with `graphProvenance()`. No serialization carries it. Also new from `graph/graph-tools.server`: `isHomeAddress()` (a sender's domain matches only in its canonical spelling, so a spelling IDNA folds onto a home domain is not home), `provenanceOf()` and the `GraphProvenance` type.
- `@hames-ai/agents`: `AgentDeps.classifyIngress` (optional). `general-next`'s office and info guards declare the screen behind the gate, `{ default: 'shadow', anthropic: 'always' }`, with the host's classifier, and the info guard exempts `memory`.

Migration: replace `screen: myScreen` with `screen: { run: myScreen }` (behaviour on clean content is unchanged: `'always'`), and delete `screenDespiteFindings` (its behaviour is now the default). To keep a screen off results that already have a deterministic finding, there is no option: that is the change. A custom `DecideFn` should pass `input.signal` to its request when it has one.

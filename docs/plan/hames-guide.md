# `hames` developer guide (draft)

**Status:** draft skeleton — section stubs only. Owner decision (2026-08-23,
[#225](https://github.com/mknw/harness-playground/issues/225) review, item
L22): this guide is meant to eventually ship **as a skill alongside the
published package**, for developers doing agentic coding against `hames`
(the working name for the extracted core — see
[`docs/plan/harness-npm-lib.md`](harness-npm-lib.md)). Each section below is a
placeholder naming what it must cover and the source material it draws from;
none of it is finished prose yet, and it should not be treated as normative
until filled in.

This guide is app-external by design: it documents the library a consumer
installs, not kg-agent's own usage of it. Where kg-agent does something the
library itself does not (or should not) provide, that belongs in the last
section below, not folded into the rest.

---

## 1. Composition model

Stub. Cover `UnifiedContext` as the one serialisable event stream, per-pattern
isolated scopes that commit on completion, `EventView` as the read seam, and
the shared `ConfiguredPattern → ConfiguredPattern` shape every combinator
(`chain` / `parallel` / `routes` / `guardrail` / `hook` / `withReferences` /
`withInjectionGuard` / `withSandbox`) has in common. Source: the "what is
already right" section of the #225 review, and the in-tree
`harness-patterns/README.md`.

## 2. Writing a pattern

Stub. The "Authoring a pattern" walkthrough #225 (L22, mechanically covered by
L16) calls for: a leaf pattern, a wrapper via the (not-yet-public) `runChild`
helper, and the scope/commit/view discipline stated as invariants rather than
inferred from comments — today five separate pattern files carry a comment
saying they mirror `with-references.server.ts`'s child-scope wrapping, which
is the gap this section closes.

## 3. The LLM seam

Stub. How to plug in something that is not BAML: the injected-function shape
(`ControllerFn`, `CriticFn`, `SynthesisFn`, etc.), each with a BAML-backed
default supplied by the separate `harness-baml` companion rather than baked
into core; `LLMCallSink` as the neutral replacement for BAML's `Collector`.
Cover the v1 client scope shipped in `harness-baml` (Anthropic + a
custom-endpoint client — see `harness-npm-lib.md` §4.4) and how a consumer
points the custom-endpoint client at their own model.

## 4. Tool transports

Stub. The `ToolTransport` interface core owns (`ownsTool`/`callTool`/
`listTools`), `registerTransport`/`withTransport` as the registration and ALS
mechanism, and how a sandbox provider (`sandbox-docker` today; a Firecracker
or k8s-talos variant later) or a consumer's own MCP gateway registers against
it. Source: `harness-npm-lib.md` §1.4.

## 5. Error surface

Stub. The typed `HarnessError` hierarchy shipped by core
(`ToolTransportError` / `LLMCallError` / `PatternConfigError` /
`ToolNotAllowedError`), what `recoverable` means for each, and how a consumer
maps them onto their own UI copy instead of getting a raw exception message
rendered to an end user. Note the raw-LLM-output-on-parse-failure requirement
here too once the in-flight fix lands.

## 6. Things the app does that the library does not ship

Stub. The explicit list of what a consumer must bring themselves, so nobody
mistakes kg-agent's own wiring for part of the package contract:

- `typeof window === 'undefined'` / `.server.ts`-suffix guards — this
  repo's own server/client boundary convention, not a `hames` requirement.
- UnoCSS attributify styling and Ark UI components — the ready-made-harnesses
  package is framework-agnostic (§1.5 of `harness-npm-lib.md`); any SolidJS
  UI is this app's, or an optional adapter, never core.
- `settings-context.server.ts`-style request-scoped settings persistence,
  auth, and the Neo4j/MCP tool catalog (`KNOWN_TOOL_SERVERS`) — all app-side
  configuration a consumer replaces with their own.
- The mixed-provider BAML fallback chains (Groq/OpenRouter/OpenAI) — dev/
  legacy tooling behind `USE_MIXED_CHAINS`, never part of the published
  `harness-baml` package.

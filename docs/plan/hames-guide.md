# `hames` developer guide (draft)

**Status:** draft skeleton — section stubs except §6 (filled at Step 1d with
the dev-mode consumption shape that actually landed). Owner decision
(2026-08-23,
[#225](https://github.com/mknw/harness-playground/issues/225) review, item
L22): this guide is meant to eventually ship **as a skill alongside the
published package**, for developers doing agentic coding against `hames`
(the extracted core — see
[`docs/plan/harness-npm-lib.md`](harness-npm-lib.md)). Each section below is a
placeholder naming what it must cover and the source material it draws from;
only §6 is finished prose, and the rest should not be treated as normative
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
`harness-patterns/SPEC.md`.

## 2. Writing a pattern

Stub. The "Authoring a pattern" walkthrough #225 (L22, mechanically covered by
L16) calls for: a leaf pattern, a wrapper via the (not-yet-public) `runChild`
helper, and the scope/commit/view discipline stated as invariants rather than
inferred from comments — today five separate pattern files carry a comment
saying they mirror `with-references.server.ts`'s child-scope wrapping, which
is the gap this section closes.

## 3. The LLM seam

Stub. How to plug in something that is not BAML: the injected-function shape
landed by Lane A (each call is `(input) => Promise<LLMResult<T>>` with an
`LLMCallRecord` carrying usage, timing and the raw output; `ControllerInput`/
`ActorInput` objects rather than positional tails; per-call `limits()` so an
AsyncLocalStorage tier decision budgets against the right model), with
`simpleLoop`/`actorCritic` taking their controller/critic as the first
argument and the other six functions injected via config (the app supplies
them in one line through `bamlPatterns()` from its `harness-baml/` module —
that module is scheduled to become the `harness-baml` package at Step 3 of
[`harness-npm-lib.md`](harness-npm-lib.md), and ships no defaults inside
core). Cover the v1 client scope the app runs (Anthropic + the self-hosted
custom endpoint — see `harness-npm-lib.md` §4.4) and how a consumer points a
custom-endpoint client at their own model.

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

## 6. Consuming the package — what landed (Step 1b/1c/1d)

This is the one section describing the shape that actually exists on `main`
today; the others are still stubs.

**In this repo (kg-agent development).** `app/package.json` declares
`"@hames/harness-patterns": "workspace:*"`. pnpm resolves that to a symlink:
`app/node_modules/@hames/harness-patterns` → `packages/harness-patterns`, so
from the dev server's point of view editing a file in `packages/` is
indistinguishable from editing `app/src` — the source ships as TypeScript,
vinxi/Vite resolves it directly, and HMR picks the edit up with no build step
and no publish loop (proven in #338, Step 1b). Commands are unchanged:
`pnpm dev` / `pnpm dev:exposed` still run from `app/`, and `pnpm
baml-generate` after any `baml_src/` edit is still the one thing a workspace
does not automate. The docker image consumes the same workspace source —
`packages/` rides in the build context and `workspace:*` resolves inside the
image exactly as it does in dev (#339, Step 1c); production never installs
from a registry (`harness-npm-lib.md` §3).

**Consumption specifiers.** The exports map is `.` (the barrel), `./patterns`
(the pattern factories), `./guard` (the injection guard's deterministic
sanitizer — the one companion subpath), and a `./*` wildcard onto the
package's TypeScript files (how the app deep-imports, e.g.
`@hames/harness-patterns/tool-transport.server`). A consumer of the barrel
gets every pattern, the tool-transport seam and the event types; nothing
needs a build step on the consumer side beyond a bundler or runner that
carries TypeScript source (Vite, vinxi, tsx).

**An external developer, today.** The package is **not yet published** —
Step 2 of [`harness-npm-lib.md`](harness-npm-lib.md) is deliberately blocked
until the Step-1a interim re-points into `app/src` are removed (Lane C and
Step 3; enumerated in that doc's "Landed so far" block). What stands in for a
registry while it is blocked: CI's `packages` job runs
`scripts/pack-smoke.sh`, which `pnpm pack`s the package, installs the tarball
into a throwaway project and asserts every export target exists and the
`./guard` subpath imports and behaves — so the moment publishing unblocks,
the artifact shape is already proven. When it publishes, an external dev
installs the ordinary way (`npm install @hames/harness-patterns`) and brings
their own model adapter for the six config-injected functions — core ships
no defaults for those, by design.

## 7. Things the app does that the library does not ship

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
- The mixed-provider BAML fallback chains (Groq/OpenRouter/OpenAI) — removed
  from the repo entirely on 2026-08-24 (ADR-0001), and never part of the
  published
  `harness-baml` package.

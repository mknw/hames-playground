# `hames` developer guide (pointing)

**Status:** the guide is being **re-homed into the packages it documents**
(owner decision on record: "the guide should later go in each respective npm
module"; planned per-package in the #225 design note, 2026-09-16, §5). The
core-owned sections now live in
[`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md)
— the composition model, writing a pattern, tool transports, the error
surface, and consuming the package, with every code snippet typecheck-pinned
by `app/src/__tests__/lib/harness-patterns/guide-docs-pins.test.ts`. This file
keeps only what has no package home yet: §3 (the LLM seam — waits for the
`harness-baml` package), §6's repo-local half (this workspace's own commands —
not package material), and §7 (the app-only list). When the remaining packages
extract, the rest of this file becomes a pointer and nothing else.

This guide was app-external by design: it documented the library a consumer
installs, not kg-agent's own usage of it. That intent now lives in the package
docs themselves.

---

## 1. Composition model

Re-homed → [`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md) §1
(scopes commit on completion, `EventView` as the read seam, the combinator
family, resume/continue). [SPEC.md](../../packages/harness-patterns/SPEC.md)
remains the full API reference.

## 2. Writing a pattern

Re-homed → [`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md) §2
(the leaf walkthrough, the wrapper discipline mirroring
`with-references.server.ts`, configuration, the index-signature rule).

## 3. The LLM seam

Stub — **NOT yet re-homed; waits for the `harness-baml` package.** How to plug
in something that is not BAML: the injected-function shape landed by Lane A
(each call is `(input) => Promise<LLMResult<T>>` with an `LLMCallRecord`
carrying usage, timing and the raw output; `ControllerInput`/`ActorInput`
objects rather than positional tails; per-call `limits()` so an
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

Re-homed → [`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md) §3
(the `ToolTransport` seam, `withTransport`/`registerTransport` and the
containment invariant, the gateway `Tools()` and its REQUIRED `namespaces`
map).

## 5. Error surface

Re-homed → [`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md) §4
— which documents what actually exists on `main`: `error` events with
per-pattern `errorSeverity`, and `LLMCallError` carrying `rawOutput` on parse
failure. The broader typed `HarnessError` hierarchy this stub once described
was **planned, never landed** — the section no longer claims it.

## 6. Consuming the package — the repo-local half

The consumer-facing half of this section (the exports map, the pack-smoke
stand-in for a registry, what an external developer does today) is re-homed →
[`packages/harness-patterns/GUIDE.md`](../../packages/harness-patterns/GUIDE.md)
§5. What stays here is the repo's own workflow, which is not package material:

`app/package.json` declares `"@hames/harness-patterns": "workspace:*"` (the
symlink/HMR mechanics and the Docker half are the package guide's, not
repeated here). Two command facts are repo-local and stay:

- `pnpm dev` / `pnpm dev:exposed` still run from `app/` — nothing about the
  package changes where commands run.
- `pnpm baml-generate` after any `baml_src/` edit is still the one thing a
  workspace does not automate.

## 7. Things the app does that the library does not ship

Stub — **NOT yet re-homed; feeds the final pointer when the agents/baml
packages exist.** The explicit list of what a consumer must bring themselves,
so nobody mistakes kg-agent's own wiring for part of the package contract:

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

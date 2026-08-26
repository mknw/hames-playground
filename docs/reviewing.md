# Reviewing changes in this repo

A **map** for the globally-installed `/reviewing-changes` skill (two unmerged
axes: Standards and Spec — from [muster-skills](https://github.com/mknw/muster-skills)),
and for any other reviewer: where this repo keeps the facts a review needs.
Pointers only — a fact belongs here directly **only if it is stated nowhere
else**, so this file stays cheap to maintain and safe to read in parallel.

## Conventions (the Standards axis)

- **Hard rules** — a breach is a violation, not a judgement call:
  [`CLAUDE.md`](../CLAUDE.md), whole file; the reviewer-critical ones live under
  _Commands_ (pnpm-only from `app/`, `baml-generate` after any `baml_src/`
  edit), _Design Decisions_ (`.server.ts` boundary, generated `baml_client/`),
  _Harness Patterns_ (`.bind(b)`, prefer the adapter factories), _BAML Clients_
  (`CLIENT_MAX_OUTPUT_TOKENS` ↔ client `max_tokens` sync, the positional-args
  trap), and _Styling_ (UnoCSS attributify only; `i-material-symbols-*` icons).
- **The diff's own area** — a change is also held to the docs local to the
  code it touches, not just the five sections above:
  [`docs/INDEX.md`](INDEX.md) and what it points at, and for any
  `harness-patterns` change,
  [`app/src/lib/harness-patterns/SPEC.md`](../app/src/lib/harness-patterns/SPEC.md)
  (its `multiToolCalls: 'off'` still-serial semantics, `EventView`/
  `ViewConfig` scoping). This is the map naming where area docs live, so the
  generic skill's area-README fallback still applies even with this map
  present — it adds sources, it does not get switched off by one.
- **Commit discipline** — conventional subject lines, **no attribution
  trailers**: the acceptance-criteria block in
  [`docs/agents/AGENT-BRIEF.md`](agents/AGENT-BRIEF.md). Check the commit list,
  not just the diff.
- **`.tsx` under `app/src`** — the `kg-dtalk-ui` skill (attributify rules,
  house recipes, role→colour mapping, a11y + graph checklists). This map
  pointing a generic skill at a `kg-*` one is repo-local config, not the
  generic skill itself calling it — that indirection is what keeps the
  generic set portable (see `CLAUDE.md`'s Agent skills section).
- **Tests** — the `kg-test-pyramid` skill: the four layers and which one a
  given test belongs to, the `*-not-in-ci.test.ts` pins, hermetic-is-the-gate,
  and no-retries. Reach for it when a change adds or moves a test, or when a
  finding is "this was not caught". Same repo-local-config indirection as the
  row above.
- **House vocabulary** — [`GLOSSARY.md`](../GLOSSARY.md); decisions not to
  re-litigate — [`docs/adr/`](adr/README.md).
- **Module boundaries** — the `codebase-design` skill's vocabulary (depth,
  interface, seam, leverage, locality).

## Spec resolution (the Spec axis)

[`docs/agents/issue-tracker.md`](agents/issue-tracker.md) is authoritative:
the resolution order (commit refs → PR body → branch name — the fourth step,
a `docs/plan/` doc, is the generic skill's own default, not this file's), the
note that this repo's PR bodies are a **first-class** spec source, and the
split that the issue body is the spec while the project board
(Status/Priority/MSCW) is scheduling — read-only context, never a finding.

## Gates

- Local: the scripts in `app/package.json`, run from `app/` — typecheck, lint,
  `test:run --coverage` (floors live in `app/vitest.config.ts`; raise by hand,
  never lower), build. `test:e2e`, `test:e2e:browser` and `eval:harness` are
  deliberately **not** gates — see the tests bullet above before filing their
  absence as a finding.
- CI: `.github/workflows/ci.yml` (the same gates plus changed-file prettier and
  the docker image build/boot job).
- Standing acceptance criteria for any dispatched change:
  [`docs/agents/AGENT-BRIEF.md`](agents/AGENT-BRIEF.md).

## Review protocol

Who commissions a review, re-review-until-convergence, reviewer model
escalation, and the PR-comment reporting contract (≤500 visible chars +
collapsed details): the `dispatching-work` skill's _Land the results_ section.

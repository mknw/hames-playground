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
- **Commit discipline** — conventional subject lines, **no attribution
  trailers**: the acceptance-criteria block in
  [`docs/agents/AGENT-BRIEF.md`](agents/AGENT-BRIEF.md). Check the commit list,
  not just the diff.
- **`.tsx` under `app/src`** — the `kg-dtalk-ui` skill (attributify rules,
  house recipes, role→colour mapping, a11y + graph checklists).
- **House vocabulary** — [`GLOSSARY.md`](../GLOSSARY.md); decisions not to
  re-litigate — [`docs/adr/`](adr/README.md).
- **Module boundaries** — the `codebase-design` skill's vocabulary (depth,
  interface, seam, leverage, locality).

## Spec resolution (the Spec axis)

[`docs/agents/issue-tracker.md`](agents/issue-tracker.md) is authoritative:
the resolution order (commit refs → PR body → branch name → `docs/plan/` doc),
the note that this repo's PR bodies are a **first-class** spec source, and the
split that the issue body is the spec while the project board
(Status/Priority/MSCW) is scheduling — read-only context, never a finding.

## Gates

- Local: the scripts in `app/package.json`, run from `app/` — typecheck, lint,
  `test:run --coverage` (floors live in `app/vitest.config.ts`; raise by hand,
  never lower), build.
- CI: `.github/workflows/ci.yml` (the same gates plus changed-file prettier and
  the docker image build/boot job).
- Standing acceptance criteria for any dispatched change:
  [`docs/agents/AGENT-BRIEF.md`](agents/AGENT-BRIEF.md).

## Review protocol

Who commissions a review, re-review-until-convergence, reviewer model
escalation, and the PR-comment reporting contract (≤500 visible chars +
collapsed details): the `dispatching-work` skill's _Land the results_ section.

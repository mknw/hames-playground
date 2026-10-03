# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on
[`mknw/hames-playground`](https://github.com/mknw/hames-playground). Use the
`gh` CLI for every operation — it infers the repo from `git remote -v` when run
inside a clone or a worktree, so no `--repo` flag is needed.

This file is the one place a skill looks up "how do I fetch a ticket here". It is
a **data hook**: generic skills (`/reviewing-changes`' Spec axis, anything that says
"fetch the relevant ticket") name this path and degrade gracefully when it is
absent. Keep it a set of commands and conventions, not a workflow.

## The spec/scheduling split

> **The issue body is the spec. The project board is scheduling.**

A review, a brief, or an implementation checks the work against the **issue body
and its comments** — that is the requirement text and the only thing an axis can
fail against. The
[GitHub project board](https://github.com/users/mknw/projects/5) carries
`Status`, `Priority` and `MSCW` fields; those say _when_ and _how urgently_ a
thing gets done, never _what_ it must do.

So: **read the board, never review against it.** It is read-only context —
useful for "is this still Must-have?" or "was this already marked done?", and
never a finding. A skill that reports "the board says In Progress but the PR is
open" is reporting on scheduling drift, which is not a defect in the code.

Reopening this is cheap if the board ever grows a field that holds requirements.

## Commands

- **Read an issue** (the spec fetch — this is the one skills call):
  ```sh
  gh issue view <number> --comments
  ```
  Add `--json number,title,body,labels,comments` when a skill needs to parse it
  rather than read it.
- **List issues**:
  ```sh
  gh issue list --state open --json number,title,body,labels \
    --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'
  ```
  Filter with `--label <name>` / `--state closed` as needed.
- **Create an issue**: `gh issue create --title "..." --body "..."` — use a
  heredoc for multi-line bodies.
- **Comment**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

**Board fields are not reachable through `gh issue`.** They live on the project
(`gh project item-list 5 --owner mknw`). Treat that command as diagnostic; no
skill in this repo needs it.

## Resolving a bare `#42`

GitHub shares one number space across issues and PRs, so a `#42` in a commit
message may be either. Resolve with `gh pr view 42`, and fall back to
`gh issue view 42`. Both PRs and issues are legitimate spec sources here: this
repo's larger changes carry their narrative in the PR body (see
`docs/plan/skills-adoption.md` §3.2 for why that split exists).

## Labels

### Component labels: which codebase a ticket is for

This is one monorepo that ships five npm packages and the reference app beside
them. **Every issue and PR carries at least one component label**, so a reader
can tell which codebase the work is for without opening it. Add every component
the work changes; a ticket that changes a package and the app carries both.
Where a symptom shows is not on its own a reason to add a label: a wrong sidebar
title whose cause is in `packages/agents/` is `pkg:agents` until the app side
changes too. A PR carries the labels of the code it changes, which is usually
the set on the issue it closes.

A test takes the label of the code it tests, wherever the file lives. Add
`hames-app:testing` as well when the work is about the tests themselves: a
flake, a new suite or harness, a visual baseline, the test databases,
`release:check` or the eval suite.

**`pkg:<name>`** names one published package, after its directory under
`packages/`. It covers the package's source, README, SPEC and published
surface, and its tests, including those under `app/src/__tests__/lib/<package>/`.
A package's own docs take its `pkg:` label, not `hames-app:docs`.
`pkg:sandbox` also covers `rootfs/`, the images the package boots: its README
has consumers build them, and containment work lands on both sides.

| Label                  | Package                      | Covers                                                                                            |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `pkg:harness-patterns` | `@hames-ai/harness-patterns` | Patterns, event views, the run frame, the injection guard, MCP tool transport, the stash pipeline |
| `pkg:harness-baml`     | `@hames-ai/harness-baml`     | The BAML corpus and its committed client, the adapter factories, role-to-client routing           |
| `pkg:agents`           | `@hames-ai/agents`           | Agent definitions and few-shots, the graph and reference extractors, replay helpers               |
| `pkg:connectors`       | `@hames-ai/connectors`       | Microsoft Graph tools, the Neo4j non-agentic layer, the MCP namespace catalog                     |
| `pkg:sandbox`          | `@hames-ai/sandbox`          | `withSandbox`, the Docker backend, egress profiles, the bash guard, workspace sync                |

**`hames-app:<component>`** names a part of everything that is not a package:
the reference app under `app/`, plus the repo's infrastructure, tests, CI and
docs. App paths below are relative to `app/src/`. A path named in a narrower
row takes that row's label; a directory entry is the default for everything
else in it.

| Label                     | Component                     | Where it lives                                                                                                                                               |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hames-app:chat`          | Chat and the turn lifecycle   | `ChatInterface`, `ChatMessages`, `ChatSidebar`, `lib/harness-client/`, `lib/turn-stream.ts`, `routes/api/events.ts`                                          |
| `hames-app:ui`            | The app shell                 | Layout, theme, fonts, icons, `Nav`, `SettingsPanel`, `UserMenu`, the `SupportPanel` frame, mobile layout                                                     |
| `hames-app:graph`         | The Neo4j graph panel         | `GraphVisualization`, `lib/neo4j/`, `lib/org-graph/`, `scripts/*neo4j*`, ontology work                                                                       |
| `hames-app:observability` | Observability                 | `ObservabilityPanel` and `observability/`, `lib/metrics/`, `routes/dashboard.tsx`                                                                            |
| `hames-app:data-stash`    | The Data Stash                | `DataStashPanel`, `lib/stash/`, `routes/api/stash*`, `lib/redis-direct.server.ts`                                                                            |
| `hames-app:sandbox-tab`   | The app side of `pkg:sandbox` | `SandboxPanel`, `InteractiveTerminal`, `routes/api/sandbox/pty/`                                                                                             |
| `hames-app:skills`        | User skills                   | `SkillsPanel`, `lib/skills/`, `lib/db/skills.server.ts`                                                                                                      |
| `hames-app:auth`          | Identity and access           | `lib/auth/`, `routes/auth/`, `routes/api/auth/`, the `'use server'` gates                                                                                    |
| `hames-app:routines`      | Unattended runs               | `lib/routines/`, `routes/api/routines/`, `routes/api/agents/[id].ts`, `lib/harness-client/action-runner.server.ts`, `configs/template.action-tokens.yaml`    |
| `hames-app:db`            | Postgres                      | `lib/db/`: schema, repositories, encryption at rest, migrations                                                                                              |
| `hames-app:inference`     | Inference tiers               | `lib/inference/`, `ConversationTierSwitch`, `lib/cost-rates.server.ts`                                                                                       |
| `hames-app:mcp-gateway`   | The Docker MCP gateway        | `configs/catalog.yaml`, `custom-catalog.yaml`, `mcp-config.yaml`, `template.mcp-config.yaml`, `scripts/render-mcp-config.sh`, the gateway service in compose |
| `hames-app:deployment`    | Build and host tooling        | `app/Dockerfile`, `docker-compose*.yaml`, `configs/Caddyfile`, `scripts/` (by default), `flake.nix`, `Makefile`, env configuration                           |
| `hames-app:testing`       | The test pyramid              | Test setup and the test databases, `app/e2e/`, `app/e2e-browser/`, `release:check`, `app/evals/`                                                             |
| `hames-app:ci`            | CI and releases               | `.github/workflows/`, the format and lint gates, `.changeset/`, `scripts/pack-smoke*`, `scripts/check-changeset-patterns.mjs`                                |
| `hames-app:docs`          | Repo docs                     | `docs/`, the root `README.md`, `CONTRIBUTING.md`, the agent guides                                                                                           |

Each family has one colour (`pkg:` blue `1D76DB`, `hames-app:` purple `5319E7`),
and every label has a one-line description; `gh label list` shows both. When
work keeps landing where no label fits, add a label to the right family with
`gh label create "hames-app:<name>" --color 5319E7 --description "..."` and add
its row here in the same PR. A new package gets its `pkg:` label when its
directory is added under `packages/`.

### Topic labels

The rest of the set is GitHub's defaults plus older topic labels (`tech-debt`,
`investigation`, `refinement`, `low priority`, `preview`, …). A few of them
(`harness-patterns`, `agents`, `ui`, `auth`, `observability`, `mcp`, `infra`)
came before the component labels and overlap them. Use the component label for
new work. Component and topic labels are both **topical, not procedural**: there
is no triage state vocabulary, and no skill should invent one. Anything that
wants to know a ticket's state reads the board.

## When a skill says…

- **"fetch the relevant ticket"** → `gh issue view <number> --comments`.
- **"publish to the issue tracker"** → create a GitHub issue.
- **"find the originating spec"** → issue references in the commit messages
  first (`#123`, `Closes #45`), then the PR body, then the branch name (which
  often carries the number, e.g. `mknw/issue-153-neo4j-prune`).

## PRs as a request surface

**No.** External PRs are not treated as feature requests here — the repo is
single-maintainer and every PR originates from a branch that already has an
issue or a plan doc behind it.

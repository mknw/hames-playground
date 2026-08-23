# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on
[`mknw/harness-playground`](https://github.com/mknw/harness-playground). Use the
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

The label set is GitHub's defaults plus topic labels (`harness-patterns`, `ui`,
`mcp`, `auth`, `code-mode`, `observability`, `tech-debt`, `investigation`,
`refinement`, `low priority`, …). They are **topical, not procedural** — there is
no triage state vocabulary, and no skill should invent one. Anything that wants
to know a ticket's state reads the board.

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

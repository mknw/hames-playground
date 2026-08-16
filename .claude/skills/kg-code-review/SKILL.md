---
name: kg-code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented conventions?) and Spec (does it match what the originating GitHub issue asked for?). Runs both as parallel sub-agents and reports them side by side, never merged. Use before opening a PR, or when the user asks to review a branch, a PR, or work-in-progress "since X".
---

<!-- Derivative work. Structure and the two-axis process are adapted from
     mattpocock/skills (MIT © 2026 Matt Pocock), skills/engineering/code-review/SKILL.md;
     the review discipline it delegates to (`code-reviewer` sub-agent) is from
     affaan-m/ECC (MIT © 2026 Affaan Mustafa), agents/code-reviewer.md. The repo
     standards below are this project's own. Pins + adaptations:
     .claude/skills/PROVENANCE.md · full licenses: .claude/skills/NOTICE.md -->

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code follow this repo's documented conventions?
- **Spec** — does it faithfully implement the originating issue?

Both axes run as **parallel sub-agents** so they cannot pollute each other's
context, then this skill aggregates their findings **without merging them**.

## Relationship to the built-in `/code-review`

They answer different questions and neither replaces the other.

|          | Built-in `/code-review`                                                   | `kg-code-review`                                               |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Question | **Is it wrong?** — correctness bugs, plus reuse/simplification/efficiency | **Is it ours, and is it what was asked for?**                  |
| Axes     | One, effort-scaled                                                        | Two, deliberately unmerged                                     |
| Inputs   | The diff                                                                  | The diff **+ this repo's conventions + the originating issue** |
| Can act  | Yes — `--fix` applies findings, `--comment` posts inline PR comments      | No. It reports                                                 |

**Run the built-in first** — it can fix what it finds — then this skill before
opening the PR, to catch convention drift and scope creep against the issue.
Neither of those is a bug, so neither is in the built-in's remit. If the user
asks for "a review" with no further qualification and the diff has not been
through the built-in yet, say so in one line and carry on; do not do the
built-in's job here.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag,
`main`, `origin/main`, `HEAD~5`. If they did not specify one, default to
`origin/main` and say so.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the
comparison is against the merge-base). Also capture the commit list with
`git log <fixed-point>..HEAD --oneline`.

Before spawning anything, confirm the ref resolves (`git rev-parse
<fixed-point>`) and the diff is non-empty. A bad ref or an empty diff fails
**here**, not inside two parallel sub-agents.

### 2. Identify the spec source

Per `docs/agents/issue-tracker.md`, in this order:

1. **Issue references in the commit messages** — `#123`, `Closes #45`.
2. **The PR body**, if a PR exists for the branch (`gh pr view --json body`).
   This repo carries the narrative of a change in the PR body, so it is a
   first-class spec source, not a fallback.
3. **The branch name**, which often carries the number — `mknw/issue-153-neo4j-prune`.
4. A path the user passed as an argument, or a `docs/plan/` doc matching the
   feature.

Fetch with `gh issue view <n> --comments` (fall back to `gh pr view <n>` — GitHub
shares one number space). If nothing is found, ask the user where the spec is;
if they say there is none, skip the Spec sub-agent and report "no spec available".

**The issue body is the spec. The project board is not.** `Status` / `Priority` /
`MSCW` are scheduling, read-only context — never a finding. See
`docs/agents/issue-tracker.md`.

### 3. Assemble the Standards brief

Three sources, in this order of authority:

**(a) This repo's documented conventions** — the ones below plus anything the
diff's own area documents (`CLAUDE.md`, `docs/INDEX.md` and what it points at,
`app/src/lib/harness-patterns/README.md`). These are **hard** — a breach is a
violation, not a judgement call:

- **UnoCSS attributify only.** `flex="~ col"`, `text="sm gray-600"` — never
  `class=`. The one exception is icons: `class="i-…"` is required syntax (the
  icon preset does not read attributify).
  The bare `color` attribute collides with attributify — `text="xs cyan-400"`,
  not `color="cyan-400"`.
- **`.server.ts` is the server/client boundary.** Server-only modules carry the
  suffix and call `assertServerOnImport()`. A server-only import reaching a
  client module is a violation even if it type-checks.
- **BAML functions are always `.bind(b)`** at the call site.
- **`app/baml_client/` is generated — never hand-edited.** Any `baml_src/` change
  must be followed by `pnpm baml-generate`, and the regenerated client committed.
- **`CLIENT_MAX_OUTPUT_TOKENS`** (`app/src/lib/settings.ts`) stays in sync with the
  BAML clients' `max_tokens`. A diff touching one and not the other is a finding.
- **`pnpm` only, run from `app/`.** Never npm/npx. A script or doc line that says
  otherwise is a violation.
- **Conventional-commit subject lines**, and **no attribution trailers** — no
  `Co-Authored-By`, no "Generated with" footer. Check the commit list from
  step 1, not just the diff.
- **Prefer the adapter factories** (`createNeo4jController`,
  `createActorControllerAdapter`, `createCriticAdapter`) over hand-rolled
  `simpleLoop(b.X.bind(b), …)` calls.

**(b) The deep-module vocabulary.** If the diff introduces or reshapes a module
boundary, call the Skill tool with `codebase-design` and use its vocabulary
(depth, interface, seam, leverage, locality) in the finding rather than
restating design theory here.

**(c) The Fowler smell baseline** below. Two rules bind it: **the repo
overrides** — where a documented standard endorses something the baseline would
flag, suppress it — and **every smell is a judgement call**, a labelled
heuristic ("possible Feature Envy"), never a violation. Skip anything tooling
already enforces (prettier, eslint, `tsc`).

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Both in **one message**, so they actually run concurrently.

**Standards** — dispatch the Agent tool with `subagent_type: code-reviewer`. Do
**not** write an inline reviewer prompt: that agent already carries the
Pre-Report Gate, the HIGH/CRITICAL-require-proof rule, the "a clean review is a
valid review" instruction, and the Common False Positives list. Restating any of
that here would fork it. Pass it:

- the full diff command and the commit list;
- the repo conventions from step 3(a), **pasted in full** — the sub-agent cannot
  see this file;
- the smell baseline from step 3(c), **pasted in full**, with its two binding
  rules;
- the brief: _"Report — per file/hunk — (a) every place the diff breaches a
  documented repo convention: quote the convention and the hunk; and (b) any
  baseline smell you spot: name it and quote the hunk. Convention breaches are
  hard violations; baseline smells are always judgement calls and a documented
  convention overrides the baseline. Skip anything prettier/eslint/tsc enforces.
  Under 400 words."_

**Spec** — a general-purpose sub-agent. Pass it the diff command, the commit
list, and the fetched spec text (not just its number — the sub-agent may not have
`gh` context). The brief:

> Report: (a) requirements the spec asked for that are missing or partial;
> (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements
> that look implemented but where the implementation looks wrong. Quote the spec
> line for each finding. Ignore project-board fields — Status/Priority/MSCW are
> scheduling, not spec. Under 400 words.

If there is no spec, skip this sub-agent and say so in the report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or
lightly cleaned. Do **not** merge, rerank, or deduplicate across them — the two
axes are deliberately separate.

End with one line: findings per axis, and the worst issue _within each axis_.
Do not pick a single winner across axes; that is exactly the reranking the
separation exists to prevent.

**This skill reports. It does not fix.** If the user wants the findings applied,
point them at the built-in `/code-review --fix` or ask them to say so explicitly.

**Zero findings on an axis is a valid result.** Say "no findings" and move on.
Manufactured nits to justify the invocation are the primary failure mode here.

## Why two axes

A change can pass one and fail the other:

- Follows every convention, implements the wrong thing → **Standards pass, Spec fail.**
- Does exactly what the issue asked, breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately is what stops one from masking the other.

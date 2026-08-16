<!-- Vendored from mattpocock/skills (MIT © 2026 Matt Pocock),
     skills/engineering/triage/AGENT-BRIEF.md, and extended for this repo.
     Pin + adaptations: .claude/skills/PROVENANCE.md · full licence:
     .claude/skills/NOTICE.md -->

# Writing Agent Briefs

An agent brief is the authoritative specification an agent works from: the body
of an Orca worker dispatch, or the body of a GitHub issue when that issue is
handed to an agent. Everything around it — the issue thread, the conversation
that led to the dispatch — is context. The brief is the contract.

The brief states **what the agent should do**, which stretches to both surfaces:
for an issue, that's building the change from nothing; for a PR, it's what's
left to do _to the existing diff_ — finish it, close gaps, address review
points. Same principles either way; the PR example below shows the difference.

## Principles

### Durability over precision

The issue may sit unclaimed for days or weeks. The codebase will change in the
meantime. Write the brief so it stays useful even as files are renamed, moved,
or refactored.

- **Do** describe interfaces, types, and behavioral contracts
- **Do** name specific types, function signatures, or config shapes that the
  agent should look for or modify
- **Don't** reference file paths — they go stale
- **Don't** reference line numbers
- **Don't** assume the current implementation structure will remain the same

### Behavioral, not procedural

Describe **what** the system should do, not **how** to implement it. The agent
will explore the codebase fresh and make its own implementation decisions.

- **Good:** "The `SkillConfig` type should accept an optional `schedule` field
  of type `CronExpression`"
- **Bad:** "Open src/types/skill.ts and add a schedule field on line 42"
- **Good:** "When a user runs `/triage` with no arguments, they should see a
  summary of issues needing attention"
- **Bad:** "Add a switch statement in the main handler function"

### Complete acceptance criteria

The agent needs to know when it's done. Every agent brief must have concrete,
testable acceptance criteria. Each criterion should be independently verifiable.

- **Good:** "Running `gh issue list --label needs-triage` returns issues that
  have been through initial classification"
- **Bad:** "Triage should work correctly"

### Explicit scope boundaries

State what is out of scope. This prevents the agent from gold-plating or making
assumptions about adjacent features.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe what happens now. For bugs, this is the broken behavior.
For enhancements, this is the status quo the feature builds on.

**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**

- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Acceptance criteria:**

- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**

- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate
```

The [standing acceptance criteria](#standing-acceptance-criteria) below apply to
every brief in this repo and are appended to the brief's own list. Do not
restate them in the brief.

When a request is too ambiguous or too risky to brief directly, run discovery
first — and write its output **in this template's shape** rather than in a
competing header format of its own.

## Standing acceptance criteria

Append this block to every brief's acceptance criteria. It is the house rules,
so a dispatch never has to restate them:

```markdown
**Standing acceptance criteria** (every brief in this repo):

- [ ] CI green: typecheck · lint · test · build (`.github/workflows/ci.yml`)
- [ ] Coverage floors not regressed — statements 43 / branches 45 /
      functions 30 / lines 47
- [ ] Prettier clean on changed files (`ui/.prettierrc.json`; the CI gate covers
      changed files under `ui/` only — see the caveat below)
- [ ] Conventional-commit subject line
- [ ] **No** `Co-Authored-By` / "Generated with" attribution trailers
- [ ] `pnpm` only, run from `ui/` (never npm/npx)
- [ ] `pnpm baml-generate` re-run if anything under `baml_src/` changed;
      `baml_client/` never hand-edited
```

One caveat that is easy to get wrong, and is the reason the block is worded the
way it is:

- **The CI format check only globs `ui/**`.** It does not cover `docs/**` or
  `.claude/**`, so a docs-only PR can be prettier-dirty and still go green. The
  `.githooks/pre-commit` → lint-staged path does format staged `*.md` anywhere
  in the tree, and it repairs rather than rejects — but it needs `pnpm` on
  `PATH`. Run prettier by hand on docs changes.

## Examples

The briefs below are illustrative — written in this repo's vocabulary to show
the shape, not to describe work that is queued.

### Good agent brief (bug)

```markdown
## Agent Brief

**Category:** bug
**Summary:** The declared client output cap and `CLIENT_MAX_OUTPUT_TOKENS` can drift apart silently

**Current behavior:**
Each Anthropic BAML client declares a `max_tokens`. A parallel
`CLIENT_MAX_OUTPUT_TOKENS` map mirrors those values, and the loop patterns read
it to decide whether a response hit its cap and should get the corrective
retry. Nothing ties the two together. Raise a client's `max_tokens` without
touching the map and cap-hit detection stops firing at the real boundary: a
truncated controller response then surfaces as a bare validation error instead
of a retry.

**Desired behavior:**
A mismatch between a client's declared `max_tokens` and its
`CLIENT_MAX_OUTPUT_TOKENS` entry fails a check that runs in CI, naming the
client and both values. No runtime behaviour changes.

**Key interfaces:**

- The `CLIENT_MAX_OUTPUT_TOKENS` map — keys are client names, values are the cap
  in tokens
- Whatever can recover each client's declared `max_tokens`; parsing the `.baml`
  source is acceptable if the generated client does not expose it

**Acceptance criteria:**

- [ ] The check fails when a client's `max_tokens` and its map entry disagree
- [ ] The failure message names the client and both values
- [ ] A client absent from the map is reported, not silently skipped
- [ ] The check passes on the current tree with no other source changes

**Out of scope:**

- Changing any cap value
- The truncation-recovery retry itself
- Mixed-provider (non-Anthropic) clients
```

### Good agent brief (enhancement)

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Give action rows a terminal status instead of leaving finished runs at `running`

**Current behavior:**
A harness run that completes successfully leaves its context status at
`running` — the framework has no `done` transition. Action rows written by the
async agent-trigger endpoint inherit that, so an action that finished minutes
ago is indistinguishable at rest from one still executing. Every reader — the
sidebar filter, the promotion gate, anything polling the endpoint — has to know
the quirk and re-derive completion from other fields.

**Desired behavior:**
An action row reaches a terminal status when its run ends, set once at the
boundary that owns the row rather than inside the harness. A failed run is
distinguishable from a successful one, and both from one still executing.
Readers can filter on status alone.

**Key interfaces:**

- The action row's `status` field — the values it may hold and which of them are
  terminal
- The trigger endpoint's fire-and-forget completion path, which is where the
  transition belongs; the harness context's own status semantics stay as they are
- Readers that currently compensate for the quirk should stop compensating

**Acceptance criteria:**

- [ ] A run that completes without error leaves its action in a terminal success status
- [ ] A run that throws leaves its action in a terminal failure status carrying the error
- [ ] An action still executing is distinguishable from both
- [ ] Rows written before this change do not break the readers — state the
      migration, or state the gap and why it is tolerated
- [ ] The status vocabulary is documented wherever the endpoint contract is documented

**Out of scope:**

- Changing the harness's own context-status semantics
- Retry or resume of failed actions
- The recording / playback path
```

### Good agent brief (PR)

For a PR, "Current behavior" describes the state of the diff, and the brief asks
the agent to finish or fix it rather than build from scratch.

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Finish the contributor's new example agent so it is reachable and covered

**Current behavior:**
The PR adds an example agent module exporting a well-formed config — id, name,
description, icon, server list, and a `createPatterns` factory wiring a single
tool loop. It is never registered, so nothing can select it. It has no test. And
one of the tool namespaces it declares is not a namespace the tool layer
actually groups, which today surfaces as an empty tool list mid-run rather than
as an error.

**Desired behavior:**
The agent is selectable, runs one turn end to end against the namespaces it
declares, and a namespace that resolves to nothing fails loudly — at
registration, naming the namespace — instead of degrading into an empty tool
list.

**Key interfaces:**

- The agent registry — what adding an entry looks like, and what it validates
- The declared server namespaces vs the namespaces the tool layer groups; reuse
  the existing name-to-namespace lookup rather than adding a second mapping
- `createPatterns` keeps its current signature

**Acceptance criteria:**

- [ ] The agent is selectable and completes one turn against its declared namespaces
- [ ] A declared namespace resolving to no tools raises an explicit error naming it
- [ ] A test covers the registry entry and the empty-namespace error
- [ ] No other agent's behaviour changes

**Out of scope:**

- Adding the missing namespace to the gateway catalog — separate change
- Any change to `createPatterns`' signature or to the pattern framework
- Styling of the picker entry
```

### Bad agent brief

```markdown
## Agent Brief

**Summary:** Fix the retrieval bug

**What to do:**
Retrieval is returning junk. Look at the search module and fix it — the scoring
function around line 210 is the problem.

**Files to change:**

- ui/src/lib/data-stash/search.server.ts (line 210)
- ui/src/lib/settings.ts (line 42)
```

This is bad because:

- No category
- Vague description ("retrieval is returning junk")
- References file paths and line numbers that will go stale
- No acceptance criteria
- No scope boundaries
- No description of current vs desired behavior

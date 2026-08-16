# PROVENANCE

Where every vendored file under `.claude/skills/` and `.claude/agents/` came
from, which upstream commit it was taken at, and what we changed. Full licence
texts: [`NOTICE.md`](NOTICE.md). The programme this implements:
[`docs/plan/skills-adoption.md`](../../docs/plan/skills-adoption.md).

**The pin lives here and nowhere else.** The per-file attribution comment
carries repo, path, author and licence, but no SHA — so bumping a pin is a
one-place edit in the tables below.

## Conventions

- **Bundle** — `generic` means a bare-named, stack-agnostic skill that is a
  candidate for the open-source split; `project` means a `kg-`-prefixed skill
  that encodes something only true of this repo and never ships.
- **Invocation** — `model` (no `disable-model-invocation` key) or `user`
  (`disable-model-invocation: true`). This flag is **preserved from upstream on
  every file**: a `Call the Skill tool with "X"` line fails _silently_ if X is
  user-invoked, so the flag is correctness, not cosmetics.
- **Formatting** — vendored files keep their upstream formatting verbatim.
  Prettier is deliberately **not** run over them; the only differences from
  upstream are the attribution comment and the adaptations listed below, so a
  future `git diff <pin>..HEAD` against the upstream path stays readable.
- Vendored `.sh` files carry the attribution as a `#` comment after the
  shebang rather than as an HTML comment, for the obvious reason.

## Refresh procedure

Pinned commit, manual diff review, no automation, on demand — run it when
there is a reason to (a relevant upstream release note, or a skill
misbehaving), not on a schedule:

```sh
git clone --filter=blob:none https://github.com/<repo> /tmp/<name>
git -C /tmp/<name> diff <pinned-sha>..HEAD -- <upstream-path>
```

Read the diff, re-apply our adaptations by hand on top of anything worth
taking, bump the row. One PR per source repo, so a bad refresh reverts cleanly.

## Sources

| Upstream repo                                                                                     | Licence                       | Pinned commit          |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- |
| [`mattpocock/skills`](https://github.com/mattpocock/skills)                                       | MIT © 2026 Matt Pocock        | `068b6e0` (2026-08-15) |
| [`affaan-m/ECC`](https://github.com/affaan-m/ECC)                                                 | MIT © 2026 Affaan Mustafa     | `50743ce` (2026-08-16) |
| [`nextlevelbuilder/ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT © 2024 Next Level Builder | `a38d04c` (2026-08-14) |
| [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)                           | MIT © 2026 DietrichGebert     | `2ed6c52` (2026-08-08) |

Only sources with rows in a wave section below have material vendored today.

---

## Wave 1 — the generic core

`chore(skills): track .claude/skills + adopt the generic core`

All rows: upstream `mattpocock/skills` @ `068b6e0`, bundle `generic`.

| Our path                                        | Upstream path                                                      | Invocation | Adapted        |
| ----------------------------------------------- | ------------------------------------------------------------------ | ---------- | -------------- |
| `writing-for-agents/SKILL.md`                   | `skills/productivity/writing-for-agents/SKILL.md`                  | model      | no             |
| `writing-for-agents/SKILL-MECHANICS.md`         | `skills/productivity/writing-for-agents/SKILL-MECHANICS.md`        | —          | no             |
| `grilling/SKILL.md`                             | `skills/productivity/grilling/SKILL.md`                            | model      | no             |
| `grill-me/SKILL.md`                             | `skills/productivity/grill-me/SKILL.md`                            | **user**   | no             |
| `diagnosing-bugs/SKILL.md`                      | `skills/engineering/diagnosing-bugs/SKILL.md`                      | model      | **yes** — A, B |
| `diagnosing-bugs/scripts/hitl-loop.template.sh` | `skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh` | —          | no             |
| `codebase-design/SKILL.md`                      | `skills/engineering/codebase-design/SKILL.md`                      | model      | no             |
| `codebase-design/DEEPENING.md`                  | `skills/engineering/codebase-design/DEEPENING.md`                  | —          | no             |
| `codebase-design/DESIGN-IT-TWICE.md`            | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md`            | —          | **yes** — A    |
| `wizard/SKILL.md`                               | `skills/engineering/wizard/SKILL.md`                               | model      | no             |
| `wizard/template.sh`                            | `skills/engineering/wizard/template.sh`                            | —          | no             |
| `resolving-merge-conflicts/SKILL.md`            | `skills/engineering/resolving-merge-conflicts/SKILL.md`            | model      | **yes** — C    |

Every file also carries the two-line attribution comment; that is not counted
as an adaptation.

### Adaptations

**A — `CONTEXT.md` → `GLOSSARY.md`.** Upstream reads a project glossary at
`CONTEXT.md`. This repo's glossary will be `GLOSSARY.md` (user decision,
overriding OQ‑1 in the plan, which proposed `CONTEXT.md`). Both call sites were
retargeted, and both are phrased to **degrade gracefully**: the file does not
exist yet — Wave 2 creates it — so each site tells the agent to name the
missing file and carry on rather than stall or invent a substitute.

- `diagnosing-bugs/SKILL.md`, the exploration line: now points at `GLOSSARY.md`
  and at `docs/adr/` (also a Wave 2 artifact), with "either may not exist yet".
- `codebase-design/DESIGN-IT-TWICE.md` §2: the sub-agent brief now names
  `GLOSSARY.md`, with an explicit fallback to architecture vocabulary alone.

Both are **data hooks**, not skill dependencies — a generic skill naming a
stable project-supplied path — so they survive the open-source split intact.

**B — `diagnosing-bugs` Phase 1 loop menu.** Added one line naming this repo's
tightest feedback loops (`pnpm vitest run <file>`; `pnpm exec tsc --noEmit
--project tsconfig.json`, both from `app/`). A cache of a non-obvious lookup —
the `app/` cwd requirement — so it earns its load.

**C — `resolving-merge-conflicts` step 4.** Sharpened "discover the project's
automated checks" into the named commands, in order, with the `app/` cwd stated.
Same rationale as B.

> B and C are the only stack-specific lines in the Wave 1 set. They name a
> package manager and a test runner, not a framework, so the set stays
> portable — but they are the two lines to re-check at open-source split time.

### Not vendored from these skill directories

Each upstream skill folder also carries an `agents/openai.yaml` (Codex-format
manifest). Not copied: Claude Code does not read it, and it would be a second
copy of the frontmatter to keep in sync.

### Declined from `mattpocock/skills`

Recorded so it is not re-litigated: `code-review` (superseded by the planned
`kg-code-review`), `triage` / `to-tickets` / `to-spec` / `wayfinder` (depend on
a setup scaffold and label vocabulary we are not adopting), `setup-pre-commit`
(`.githooks` + lint-staged + the CI gate already exist), `research` (the
`codebase-researcher` agent), `handoff` / `claude-handoff` (Orca +
`worktree-lanes`), `implement`, `prototype`, `setup-ts-deep-modules`, `tdd`,
`ask-matt`, `migrate-to-shoehorn`, `scaffold-exercises`, and
`git-guardrails-claude-code` (a hooks installer — excluded by the no-hooks
constraint).

`multica-ai/andrej-karpathy-skills` was reviewed and **skipped entirely**: no
LICENSE file at `2c60614`, so all-rights-reserved by default and not vendorable.

---

## Wave 2 — ADR mechanism + seed records

`docs(adr): ADR mechanism + seed records`

**No skill files are vendored in this wave.** What it ships is one derivative
work outside `.claude/`, recorded here because the pin belongs in one place:

| Our path             | Upstream repo       | Upstream path                                      | Pinned commit | Bundle |
| -------------------- | ------------------- | -------------------------------------------------- | ------------- | ------ |
| `docs/adr/README.md` | `mattpocock/skills` | `skills/engineering/domain-modeling/ADR-FORMAT.md` | `068b6e0`     | —      |
| `docs/adr/README.md` | `affaan-m/ECC`      | `skills/architecture-decision-records/SKILL.md`    | `50743ce`     | —      |

It is a **synthesis, not a copy** — the two upstreams disagree, and
[`docs/plan/skills-adoption.md` §3.2](../../docs/plan/skills-adoption.md)
decides between them. What was taken from each:

- **mattpocock — the body format and the write gate.** The 1–3 sentence body,
  the optional-sections list, `NNNN-slug.md` numbering, and the three-condition
  gate (hard to reverse **and** surprising without context **and** the result of
  a real trade-off). ECC's Nygard-style template was **dropped**: it makes every
  ADR a small essay while its own guidance warns that a context section over ten
  lines is too long.
- **ECC — the index, the lifecycle, and the gates around writing.** The
  `| ADR | Title | Status | Date |` index table as the single place statuses are
  aggregated, `proposed → accepted → [deprecated | superseded by ADR-NNNN]`, the
  explicit + implicit detection signals, the confirm-before-write step (present
  the draft; write only on approval; discard silently on decline), and the two
  rules kept verbatim in spirit — _"we just picked it" is not a valid rationale_
  and _never back-fill without marking it_.

Deviations from both, on this repo's own authority:

- **No `template.md`.** ECC's directory layout includes one; a three-line format
  does not need a file to copy, and a template file drifts from its own
  documentation.
- **No `metadata: origin:` and no frontmatter.** ADR files carry ECC's bold
  `**Date**` / `**Status**` lines rather than mattpocock's optional status
  frontmatter, so the file and the index row read the same way.
- **A `## Sources` section** was added to the optional list — it does not appear
  upstream. It exists to make ECC's don't-back-fill-silently rule enforceable
  rather than aspirational, and all five seed records carry one.

The attribution comment sits at the top of `docs/adr/README.md` as an HTML
comment, per the two-part mechanism in the plan's §8. The five ADR files
themselves are entirely this repo's content and carry no attribution.

`GLOSSARY.md` (repo root) and the `docs/INDEX.md` rows are original, with no
vendored material. `GLOSSARY.md` is the file the Wave 1 adaptation **A** call
sites point at; those two data hooks now resolve.

---

## Wave 3 — design + decision procedures

`chore(skills): design + decision procedures`

Five skills, all bundle `generic`, all model-invoked except
`improve-codebase-architecture` — which keeps upstream's
`disable-model-invocation: true` and is therefore reachable only by name.

From `mattpocock/skills` @ `068b6e0`:

| Our path                                       | Upstream path                                                     | Invocation | Adapted           |
| ---------------------------------------------- | ----------------------------------------------------------------- | ---------- | ----------------- |
| `domain-modeling/SKILL.md`                     | `skills/engineering/domain-modeling/SKILL.md`                     | model      | **yes** — D, E, F |
| `domain-modeling/GLOSSARY-FORMAT.md`           | `skills/engineering/domain-modeling/CONTEXT-FORMAT.md`            | —          | **yes** — E, F    |
| `improve-codebase-architecture/SKILL.md`       | `skills/engineering/improve-codebase-architecture/SKILL.md`       | **user**   | **yes** — E       |
| `improve-codebase-architecture/HTML-REPORT.md` | `skills/engineering/improve-codebase-architecture/HTML-REPORT.md` | —          | no                |

From `affaan-m/ECC` @ `50743ce`:

| Our path                             | Upstream path                               | Invocation | Adapted        |
| ------------------------------------ | ------------------------------------------- | ---------- | -------------- |
| `council/SKILL.md`                   | `skills/council/SKILL.md`                   | model      | **yes** — G, H |
| `intent-driven-development/SKILL.md` | `skills/intent-driven-development/SKILL.md` | model      | no — see J     |
| `loop-design-check/SKILL.md`         | `skills/loop-design-check/SKILL.md`         | model      | **yes** — G, I |

Every file also carries the two-line attribution comment; that is not counted
as an adaptation. `HTML-REPORT.md` and `intent-driven-development/SKILL.md`
differ from upstream by that comment and nothing else.

**The cross-skill edges are the reason the invocation column matters here.**
`improve-codebase-architecture` calls three skills through the Skill tool —
`codebase-design` and `grilling` (both Wave 1) and `domain-modeling` (this
wave). All three are model-invoked, which is what makes those calls resolve; a
user-invoked dependency would fail silently, with no error to notice.

### Adaptations

**D — the ADR mechanism is repointed, not vendored.** Upstream
`domain-modeling` carries its own `ADR-FORMAT.md` and links it from the "Offer
ADRs sparingly" step. **That file is not vendored.** Wave 2 already shipped the
reconciled mechanism at `docs/adr/README.md` — mattpocock's body format and
three-condition gate, ECC's index, lifecycle and confirm-before-write step (the
plan's §3.2) — so a second copy inside the skill would be a fork of a document
this repo already owns. What survives in `SKILL.md` is the **three-condition
gate itself**, verbatim, because it is the part that fires _during_ a modelling
session; everything downstream of "yes, write one" is one pointer at
`docs/adr/README.md`.

**E — `CONTEXT.md` → `GLOSSARY.md`** (same user decision as Wave 1's adaptation
A, applied to every call site in both skills — including `domain-modeling`'s
`description`, the one field under permanent context load). The reference file
is renamed with its subject: upstream `CONTEXT-FORMAT.md`
ships here as **`GLOSSARY-FORMAT.md`**, and its `## Structure` example was
rewritten to the shape the repo's `GLOSSARY.md` actually uses (bold term, em
dash, optional `_Avoid_` line, grouped under `##` clusters). A format document
that contradicts the only file it governs is worse than no format document. Its
four upstream rules are kept verbatim; a fifth was added — _point at the
authority, don't restate it_ — which is `GLOSSARY.md`'s own stated discipline
and the reason it stays a glossary rather than drifting into a design doc.

Both skills' glossary and ADR pointers are **data hooks**, not skill
dependencies — a generic skill naming a stable project-supplied path — so they
survive the open-source split. Both are phrased to degrade gracefully even
though both targets now exist.

**F — the multi-context branch is dropped.** Upstream infers a `CONTEXT-MAP.md`
at the repo root and, if it finds one, resolves per-context glossaries and
per-context `docs/adr/` directories. This repo is one `app/` app with one root
glossary, so that branch can never fire — it is pure context load by
`writing-for-agents`' own no-op test. Removed from `SKILL.md`'s file-structure
section and from `GLOSSARY-FORMAT.md`'s "Single vs multi-context repos" section.

**G — the three standing ECC edits** (the plan's §2.2, applied to every ECC
file): `metadata: origin:` dropped from the frontmatter, since provenance lives
in this file; dangling cross-references to unadopted ECC skills deleted; Chinese
trigger strings stripped from `description:`. `intent-driven-development` needed
none of the three — it carries no `metadata:` block, no bilingual triggers, and
its own handoff step already says "do not assume any named skill or tool is
installed."

**H — `council`.**

- **`When NOT to Use` retargeted.** Its four right-column entries all named
  unadopted ECC skills (`santa-method`, `planner`, `architect`, `code-reviewer`).
  Replaced with this set's real alternatives: `grilling`,
  `intent-driven-development`, `codebase-design` /
  `/improve-codebase-architecture`, and the **built-in** `/code-review`. All
  bare names — a generic skill must never point at a `kg-*` one, so the planned
  `kg-code-review` is deliberately absent here.
- **The grilling boundary stated** (the plan's §3.1). One paragraph on _who
  holds the answer_ — the user's own preferences and constraints are grilled,
  never delegated to subagents answering on their behalf — plus the one-way
  composition. The two skills look similar and are not, and the failure mode is
  convening a council when a user was available to ask.
- **Persistence Rule repointed, not deleted.** Upstream sent durable outcomes to
  `knowledge-ops` and `/save-session`, both unadopted. The section's actual
  content — do not invent a shadow notes path; persist only when it changes
  something real — is load-bearing and stack-agnostic, so only its targets
  moved: an ADR via `docs/adr/README.md` for an architectural, hard-to-reverse
  outcome; memory notes for a lesson; the GitHub issue when it changes active
  execution truth. (The plan's §2.2 row proposed deleting the section wholesale;
  keeping the rule and fixing its targets is a strictly smaller change and loses
  nothing.)
- **`Related Skills` deleted wholesale** — all four entries dangled. The one
  that carried real information, `architecture-decision-records`, survives as
  the `docs/adr/README.md` pointer inside the Persistence Rule.
- **The worked example de-branded.** Upstream's question is "should we ship ECC
  2.0 as alpha now" — a dangling product reference here. Two lines changed; the
  four-voice shape it illustrates is untouched.

**I — `loop-design-check`.** The `description` was ~1200 characters of bilingual
trigger lists under permanent context load; rewritten to two sentences naming
the two actions and the trigger. The mechanism-layer pointers to
`autonomous-loops` / `continuous-agent-loop` (twice: the "don't use it for"
list and the closing lineage note) became a statement of the same boundary
without the dangling names — the scope claim is what mattered, not the
referral. `/goal`-style in the loop-type table became "closed loop onto a
target": `/loop` and `/schedule` resolve to real built-ins and are kept, `/goal`
does not exist here. **No repo-specific content was added**, deliberately: this
skill's five failure modes read directly onto `simpleLoop` / `actorCritic` /
routines, and it is more useful staying portable than being annotated with them.

**J — `intent-driven-development` ships verbatim, and one deferral is
recorded.** The plan's §2.2 row 12 also asks for a trimmed `description` and for
the Output Template's Status / Revision / Prepared-for header and Revision Log
to be deleted, as part of reconciling this skill with `docs/agents/AGENT-BRIEF.md`
(§3.4: the brief is the artifact, this skill is the procedure that produces one).
**`AGENT-BRIEF.md` lands in Wave 5.** Deleting the header now would leave the
template with no output shape at all until then, so that surgery moves to Wave 5
where its replacement arrives in the same commit. Nothing else in the file needed
changing — see G.

### Accepted upstream behaviours

Recorded so they are not re-flagged in review:

- **`improve-codebase-architecture` emits a Tailwind-CDN + Mermaid-CDN HTML
  report** (`HTML-REPORT.md` in full, and step 2 of `SKILL.md`). This repo is
  UnoCSS-attributify, so it reads like a violation and is not one: the report is
  written to `$TMPDIR/architecture-review-<timestamp>.html` and opened in a
  browser, it never enters the repo, and no rule we have governs a throwaway
  file. Converting it to UnoCSS would be pure cost. **Left exactly as upstream**
  (user decision, the plan's OQ‑5).

### Not vendored from these skill directories

- `skills/engineering/domain-modeling/ADR-FORMAT.md` — superseded by
  `docs/adr/README.md`; see adaptation D.
- `agents/openai.yaml` in both mattpocock directories — Codex-format manifests
  Claude Code does not read, same as Wave 1.

---

<!-- Later waves append their own `## Wave N` section here. Do not edit the
     sections above; a wave that needs to change an earlier row bumps that row
     in place and says why in its own section. -->
## Wave 4 — the review pipeline

`chore(skills): review pipeline`

All vendored rows: upstream `affaan-m/ECC` @ `50743ce`, bundle `generic`. Every
ECC file is model-invoked upstream (none carries `disable-model-invocation`), and
that is preserved.

| Our path                             | Upstream path                              | Invocation   | Adapted           |
| ------------------------------------ | ------------------------------------------ | ------------ | ----------------- |
| `../agents/code-reviewer.md`         | `agents/code-reviewer.md`                  | **subagent** | **yes** — D, E, F |
| `../agents/silent-failure-hunter.md` | `agents/silent-failure-hunter.md`          | **subagent** | **yes** — E, F    |
| `agent-architecture-audit/SKILL.md`  | `skills/agent-architecture-audit/SKILL.md` | model        | **yes** — G, H, I |
| `living-docs-governance/SKILL.md`    | `skills/living-docs-governance/SKILL.md`   | model        | **yes** — G, J, K |

`agent-architecture-audit`'s own upstream origin is **`oh-my-agent-check`**, not
ECC — its frontmatter carried `metadata: origin: oh-my-agent-check`. ECC is the
repo we took it from and the licence that covers our copy; the earlier origin is
recorded here and in the file's attribution comment, and is the thing to check
first if that skill ever needs a refresh.

This wave also ships two files that are **not** vendored copies:

| Our path                             | Bundle    | Origin                                                                                                                                                                                                                                                                              |
| ------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kg-code-review/SKILL.md`            | `project` | **Derivative work** — see below                                                                                                                                                                                                                                                     |
| `../../docs/agents/issue-tracker.md` | —         | **Hand-written.** Seeded from the _shape_ of `mattpocock/skills` @ `068b6e0` `skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md`, rewritten for this repo. The upstream setup skill is **never run** — it auto-edits `CLAUDE.md`, which this project does by hand |

### `kg-code-review` — derivative work, two sources

Written from scratch, but it carries MIT material from both upstreams, so its
attribution header names both (plan §8):

| Element                                                                                                                                        | Origin                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Two-axis shape, fixed-point discipline, aggregation rule, Fowler smell baseline                                                                | `mattpocock/skills` @ `068b6e0`, `skills/engineering/code-review/SKILL.md`             |
| Review discipline — Pre-Report Gate, HIGH/CRITICAL-require-proof, "a clean review is a valid review", the 12-entry Common False Positives list | `affaan-m/ECC` @ `50743ce`, `agents/code-reviewer.md` — **by delegation, not by copy** |
| Repo standards, the `/code-review` boundary, the spec/scheduling split                                                                         | this project                                                                           |

The ECC material is adopted **exactly once**: the Standards axis dispatches the
vendored `code-reviewer` sub-agent (`subagent_type: code-reviewer`) rather than
inlining a reviewer prompt, so the false-positive list lives in one file. That is
also why `kg-code-review` names a sub-agent, not a skill — the one-direction
composition rule (a `kg-*` skill may call a generic skill, never the reverse) is
untouched, and its only Skill-tool call is to `codebase-design`, which is
model-invoked and therefore reachable.

`mattpocock/skills`' own `code-review` skill is **not** vendored; this supersedes
it. Recorded in Wave 1's declined list.

### Adaptations

**D — `code-reviewer`: React/Next.js block deleted.** The `### React/Next.js
Patterns (HIGH)` section (upstream lines 181–213, its two `tsx` examples
included) is gone. This is a SolidJS repo: `useEffect` dependency arrays, stale
closures, and Server-Component boundaries do not exist here, so the section is
guidance that can only produce false positives. The Node.js/Backend section is
kept — SolidStart server actions and the `.server.ts` layer are real backend
surface. The `v1.8 AI-Generated Code Review Addendum` is also deleted: it is
vendor-flavoured and its cost-tier advice contradicts this repo's standing
"subagents run on Opus" preference.

**E — "Prompt Defense Baseline" preamble deleted** (both agents, 7 lines each).
It fails `writing-for-agents`' no-op test — the model already does all of it —
and it was costing that load on every dispatch.

**F — `model: sonnet` → `model: opus`** (both agents). Standing preference for
sub-agents in this repo. The plan states it for `silent-failure-hunter`; applied
to `code-reviewer` for the same reason, and because `kg-code-review` dispatches
it as its Standards axis.

**G — `metadata: origin:` dropped** from the frontmatter (both skills).
Provenance lives here, in one place.

**H — `agent-architecture-audit`: evidence collection retargeted.** The Phase 2
`rg` recipes pointed at `--type py` and a Chinese-language prompt pattern; both
are dead here. They now scope to `app/src/lib/harness-patterns/` and
`app/baml_src/`, with the source-code bullet naming the actual boundary files
(`baml-adapters.server.ts`, `tools.server.ts`, `context.server.ts`). Every
recipe was run against this tree and returns hits.

**I — `agent-architecture-audit`: dangling references replaced.** The "Related
Skills" section (five ECC skills, none adopted) is replaced by a **12-layer →
this repo** ownership table, which is the lookup that section was standing in
for. The "Do not use for" list now names real alternatives (`diagnosing-bugs`,
the built-in `/code-review` and `/security-review`, the `code-reviewer`
sub-agent) — deliberately **not** `kg-code-review`, which would break the
generic set's portability.

**J — `living-docs-governance`: Chinese trigger list stripped** from
`description:`. Eight bilingual trigger strings under permanent context load for
a single-locale user.

**K — `living-docs-governance`: four roles mapped onto this repo.** The
"Lightweight Adoption Template" generic example table is **replaced** (not
supplemented — that would be the duplication the skill itself warns about) by
the filled map: constitution = `CLAUDE.md`, map = `docs/INDEX.md`, status = the
GitHub project board, history = `docs/adr/` + `docs/plan/` + PR bodies. Two
consequences are spelled out — status is a live board and never a committed file,
and history is tiered by durability — plus a graceful-degradation line for
`docs/adr/`, which Wave 2 creates. The `codebase-onboarding` reference (ECC,
not adopted) is replaced with the instruction it stood for. The two illustrative
tables now use this repo's real examples: the delete-zone row is
`app/src/lib/baml-agent/` → `harness-patterns/`, which is a live "do not recreate
this" rule in `CLAUDE.md`.

> These are **data hooks** by the plan's §1 rule — a generic skill naming stable
> project-supplied paths (`CLAUDE.md`, `docs/INDEX.md`, `docs/adr/`,
> `app/src/lib/harness-patterns/`) and degrading gracefully — not dependencies on
> a project skill, so both skills survive the open-source split. H, I and K are
> the lines to re-check at split time; none names a framework or a vendor.

### Not vendored

- ECC's `agents/openai.yaml`-equivalents and plugin manifest — Claude Code does
  not read them.
- The ECC plugin install itself (~21 k tokens of skill descriptions per
  session), `plankton-code-quality` (ships a hook that blocks `pnpm`),
  `continuous-learning-v2` / `unified-memory` / `plan-canvas` (require a global
  npm install or a background daemon — both excluded by the no-daemons
  constraint, and they would be a second memory system beside our notes and
  h9s), and the ~280 remaining skills.
## Wave 5 — dispatch brief + `CLAUDE.md` pruning

`docs(agents): AGENT-BRIEF template + CLAUDE.md pruning`

Both rows land **outside `.claude/`** — the first is a doc, the second is prose
merged into `CLAUDE.md` — so neither carries the usual per-file comment
placement. `AGENT-BRIEF.md` gets the same two-line attribution comment at the
head of its body; `CLAUDE.md` gets a one-line in-section credit instead, because
a licence header on the project's own constitution would misattribute the file
as a whole.

| Our path                      | Upstream repo             | Upstream path                              | Pinned commit | Invocation | Adapted        | Bundle  |
| ----------------------------- | ------------------------- | ------------------------------------------ | ------------- | ---------- | -------------- | ------- |
| `docs/agents/AGENT-BRIEF.md`  | `mattpocock/skills`       | `skills/engineering/triage/AGENT-BRIEF.md` | `068b6e0`     | — (a doc)  | **yes** — D, E | generic |
| `CLAUDE.md` § Code minimalism | `DietrichGebert/ponytail` | `AGENTS.md`                                | `2ed6c52`     | — (prose)  | **yes** — F    | project |

### Adaptations

**D — `AGENT-BRIEF.md` framing and examples.** Upstream frames a brief as "a
structured comment posted on a GitHub issue when it moves to `ready-for-agent`".
We adopted neither `triage` nor its label vocabulary, so the framing is retargeted
to what we actually dispatch through: an Orca worker dispatch body, or a GitHub
issue body handed to an agent. All four worked examples (three good, one bad) are
replaced with kg-agent ones. The **Principles** section is verbatim, including its
inline `SkillConfig` / `/triage` illustrations — they illustrate the _form_ of a
good criterion, and rewriting them would have been a change for its own sake.

**E — the standing acceptance-criteria block.** New, ours, not upstream: the
house rules a dispatch would otherwise restate every time (CI gate, coverage
floors, prettier on changed files, conventional commits, no attribution
trailers, `pnpm`-only from `app/`, `baml-generate` after `baml_src/` edits), plus
the two caveats that make them honest — the floors are not on `main` until PR
#165 merges, and the CI format check globs `app/**` only, so a docs-only PR can
be prettier-dirty and still go green.

**F — ponytail → `CLAUDE.md` prose.** Not vendored: **rewritten in our own
words**, because the upstream file is a whole-agent persona (`AGENTS.md`,
"you are a lazy senior developer") and we wanted a disposition, not a persona.
What carries over is the 7-rung ladder and the not-lazy-about guardrails. What
does **not**: the persona framing, the `ponytail:` comment convention, the
one-runnable-check rule (this repo has vitest and a CI gate), and the plugin —
it injects its ruleset through SessionStart / SubagentStart / UserPromptSubmit
hooks, excluded by the programme's no-hooks constraint.

One line is **added** and is the reason the section is worth writing down at
all: _Ark UI is the chosen primitive layer; never replace Ark components with
native elements._ Ponytail's own rung 5 ("an already-installed dependency
solves it") protects Ark UI only once the project states that Ark UI _is_ the
chosen layer — its flagship published example replaces Radix Dialog with a
native `<dialog>`, so without that line the ladder argues against our stack.

### Not vendored

`ponytail`'s plugin, hooks, MCP server and commands — see F. From
`mattpocock/skills/engineering/triage/`, only `AGENT-BRIEF.md`: the `triage`
skill itself was declined in Wave 1.
## Wave 6 — `kg-dtalk-ui`

`chore(skills): kg-dtalk-ui styleguide`

`kg-dtalk-ui` is **ours** — a project styleguide of recipes and rules derived by
reading `app/uno.config.ts` and measuring the real duplication in `app/src`.
Bundle `project` (the `kg-` prefix; it never ships with the open-source split).
Invocation: **model**. Two pieces inside it are vendored, which makes the skill a
**derivative work**, and every file carries an attribution comment naming the
source.

All vendored rows: upstream `nextlevelbuilder/ui-ux-pro-max-skill` @ `a38d04c`.

| Our path                        | Upstream path                                                     | Vendored?         | Adapted        |
| ------------------------------- | ----------------------------------------------------------------- | ----------------- | -------------- |
| `kg-dtalk-ui/SKILL.md`          | —                                                                 | no — written here | —              |
| `kg-dtalk-ui/A11Y-CHECKLIST.md` | `.claude/skills/ui-ux-pro-max/references/quick-reference.md` §1–2 | **yes**           | **yes** — D, E |
| `kg-dtalk-ui/GRAPH-VIZ.md`      | `.claude/skills/ui-ux-pro-max/data/charts.csv` row 16             | **yes**           | **yes** — F    |

### Adaptations

**D — WCAG §1–2 rewritten in this stack's syntax.** Upstream ships §1
"Accessibility (CRITICAL)" (25 rules) and §2 "Touch & Interaction (CRITICAL)"
(17 rules) as flat `id` — `prose` bullets. **Rule IDs and WCAG conformance
levels are preserved verbatim**, so `git diff a38d04c..HEAD` against the upstream
path stays readable; the guidance column is rewritten as attributify /
Ark UI / this-repo instructions, with concrete file:line anchors.

**E — the six native-only §2 rules are grouped, not dropped.** `gesture-conflicts`,
`standard-gestures`, `system-gestures`, `haptic-feedback`, `safe-area-awareness`
and `swipe-clarity` cannot fire on a desktop web app. They are kept **by ID** in
a single closing line rather than expanded — the diff-against-upstream property
survives at one line of cost, instead of six rules of dead context.

**F — charts.csv row 16 → prose.** The row's `Data Volume Threshold`,
`Color Guidance`, `Accessibility Risk`, `Accessibility Notes`, `A11y Fallback`
and `Library Recommendation` cells are carried faithfully (≤100 SVG / 101–500
Canvas / >500 clustering-or-LOD; edges `#90A4AE` @60%; highlight `#F59E0B`; the
adjacency view as the accessible source of truth; focus-reveals / Enter-drills /
move-buttons-replace-drag). What is added is the mapping onto Cytoscape.js and
onto this repo's actual graph components, including the current gaps stated as
gaps.

**Formatting exception to the convention above.** Neither vendored file is a
verbatim copy — both are rewrites that preserve upstream's identifiers, not its
prose — so the "keep upstream formatting" rule has nothing to preserve. All
three files are prettier-formatted like any other document we author.
`NOTICE.md` already carried this source's full MIT text from Wave 1; nothing
was added to it.

### Deliberately **not** vendored from this source

Recorded so it is not re-litigated (plan §2.3):

- **The search tool and `--stack uno`.** In that repo `uno` is the .NET **Uno
  Platform** (XAML/WinUI), not UnoCSS. An agent auto-detecting "uno" from
  `package.json` would get C#/XAML guidance.
- **The `--design-system` generator.** It always generates a _fresh_ palette from
  its 192-product database, with no flag to validate against an existing token
  set — it would fight `app/uno.config.ts` rather than serve it.
- The remaining eight `quick-reference.md` categories and the other 15+
  `charts.csv` rows: no consumer here today.

### Not a token cache

Per OQ‑6 (user decision): the skill **points at `app/uno.config.ts`** for the
token list and never restates it. What it carries instead is the part that is
_not_ derivable from the config — the attributify rules and their exceptions,
the four house recipes, and a **proposed** role→token mapping measured from
usage. That table is marked in the skill as awaiting a one-time confirmation and
carries no authority until it gets one.

### CLAUDE.md

Per OQ‑7 (user decision), this wave also fixes `CLAUDE.md`'s stale **Icons**
subsection: `material-symbols` (+ `-light`) is stated as the icon set, and the
`i-mdi-*` guidance is corrected to a warning — `@iconify-json/mdi` is installed
but **not registered** as a collection in `uno.config.ts`, so the 41 surviving
`i-mdi-*` classes emit no CSS. The edit is confined to that subsection.

**No component code is migrated by this wave.** No `i-mdi-*` renames, no
hex→token changes, no `class=` fixes. Those are recorded in the skill as
evidence for its rules; the migration is separate future work.

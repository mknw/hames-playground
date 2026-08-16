# Adopting agent skills — a curated procedure bundle (Plan)

> **Superseded by extraction (2026-08-17).** The generic bundle this plan
> shipped into `.claude/skills/` was later extracted to `~/Code/muster-skills`
> and installed globally via `~/.claude/skills` symlinks; only `kg-*` skills
> and the two sub-agents remain in-repo. This document stays as the record of
> how the set was chosen, adapted and delivered — read it as history.

> **Status: plan only. No `.claude/skills/` files ship in this PR.** This document
> operationalises decisions already taken with the user on 2026-08-16 after a
> three-researcher evaluation of five public skill collections. It does not
> relitigate the adoption set — it answers _how_ the set is structured, adapted,
> licensed, sequenced, and delivered to Orca workers. Everything in
> [Open questions](#open-questions) is addressed to the user with a recommended
> answer; everything else is a decision this plan makes.

A **skill** here is a Claude Code procedure file — `.claude/skills/<name>/SKILL.md`
— that the agent (or the human) invokes _at a moment_ and then executes step by
step. The razor that produced the adoption set:

> Adopt only **invoked-at-a-moment procedures with steps, gates, and an output
> contract.** Dispositions ("prefer X over Y") go in `CLAUDE.md`. History and
> preferences go in memory. Everything else is declined.

Sources reviewed and their disposition:

| Repo                                                                                            | License                                     | Pinned commit          | Disposition                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mattpocock/skills](https://github.com/mattpocock/skills)                                       | MIT © 2026 Matt Pocock                      | `068b6e0` (2026-08-15) | 9 skills + 1 doc + 1 adapted setup output                                                                                                             |
| [affaan-m/ECC](https://github.com/affaan-m/ECC)                                                 | MIT © 2026 Affaan Mustafa                   | `50743ce` (2026-08-16) | 6 skills + 2 subagents                                                                                                                                |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT © 2024 Next Level Builder               | `a38d04c` (2026-08-14) | 2 reference sections + 1 data row, vendored into a project skill                                                                                      |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)                           | MIT © 2026 DietrichGebert                   | `2ed6c52` (2026-08-08) | Prose only → `CLAUDE.md`. No skill, no plugin, no hooks                                                                                               |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)       | **no LICENSE file** (verified at `2c60614`) | `2c60614` (2026-04-20) | **Skipped.** Absent a license, the default is all-rights-reserved — not vendorable. Content was generic behavioural guidance `CLAUDE.md` already owns |

Constraints that hold across the whole programme: **no plugin installs, no hooks,
no daemons, no new runtime dependencies** beyond what a skill itself needs. Every
adopted file is copied and adapted by hand.

---

## 1. Bundle structure — one set or two

### The recommendation

**Two logical sets, one physical directory.** All skills live in
`.claude/skills/`; membership of the generic set vs the project set is carried by
a **naming namespace** plus a single provenance table — as metadata, not as
filesystem topology.

```
.claude/
├── skills/
│   ├── NOTICE.md                     # verbatim MIT texts of all vendored sources
│   ├── PROVENANCE.md                 # the manifest: source, path, pin, bundle
│   ├── writing-for-agents/           # generic  ─┐
│   ├── grilling/                     # generic   │  bare name
│   ├── codebase-design/              # generic   │  = OSS-portable
│   ├── diagnosing-bugs/              # generic   │
│   ├── …                             #          ─┘
│   ├── kg-code-review/               # project ─┐  kg- prefix
│   └── kg-dtalk-ui/                  # project ─┘  = stays here
└── agents/
    ├── code-reviewer.md              # generic (subagent, not a skill)
    └── silent-failure-hunter.md      # generic (subagent, not a skill)
```

### Why not two directories

Claude Code discovers project skills at exactly one path. A second tree (`skills/`
destined for the OSS split, symlinked or copied into `.claude/skills/`) buys
nothing today and costs a real failure mode: symlinks are fragile across
worktrees, and a copy step is a sync bug waiting to happen. The split hasn't
happened yet; encoding it as topology now commits to a shape we would have to
re-derive anyway. Encoding it as metadata is free and reversible.

When the OSS split does land, the split operation is mechanical: **copy every
directory whose name does not start with `kg-`, plus `NOTICE.md` and the generic
rows of `PROVENANCE.md`.**

### The naming convention

- **Bare name** (`grilling`, `codebase-design`, `council`) — stack-agnostic
  procedure. No mention of Neo4j, BAML, SolidStart, UnoCSS, DTSC, or DTalk. Ships
  with the OSS split.
- **`kg-` prefix** (`kg-code-review`, `kg-dtalk-ui`) — encodes something only true
  of this repo. Never ships.

The prefix pays for itself three ways: it is visible in `/`-completion, it is
visible inside other skills' `Call the Skill tool with "…"` lines (so a
portability violation is greppable in review), and it sidesteps the name
collision with the **built-in** `/code-review` skill (see §3.3).

### How the project set extends the generic set

Two rules, one invariant:

1. **Composition, one direction only.** A `kg-*` skill MAY call a generic skill
   via the Skill tool. A generic skill MUST NOT call a `kg-*` skill. This is the
   whole portability guarantee, and it is checkable:
   ```sh
   grep -rn 'Skill tool with "kg-' .claude/skills --include=SKILL.md \
     | grep -v '/kg-'          # must print nothing
   ```
2. **Override by delta, not by fork.** Where the project needs different content,
   the `kg-*` skill owns only the delta and delegates the shared body. Example:
   `kg-code-review` carries this repo's standards and the false-positive
   suppression list, and calls `codebase-design` for the deep-module vocabulary
   rather than restating it.

The one sanctioned coupling in the other direction is a **data hook**: a generic
skill may name a stable project-supplied path (`docs/agents/issue-tracker.md`,
`docs/adr/`) and degrade gracefully with a stated message when it is absent. That
is a pointer to data, not a dependency on a project skill, and it survives the
OSS split intact.

---

## 2. Per-skill adaptation sheet

### 2.0 Invocation model — the constraint that drives everything

Verified from the upstream frontmatter and `mattpocock/.agents/invocation.md` at
`068b6e0`:

- **Model-invoked** (default; no `disable-model-invocation` key) — the agent can
  fire it autonomously, **and other skills can reach it via the Skill tool**. Its
  `description` is permanently loaded context.
- **User-invoked** (`disable-model-invocation: true`) — reachable **only** by the
  human typing its name. Zero context load. **No other skill can call it, ever.**

> **The silent-failure trap.** A `Call the Skill tool with "X"` line inside skill
> A fails silently if X is user-invoked. Preserving the upstream invocation flag on
> every dependency is therefore not cosmetic — it is correctness.

The actual dependency edges in our adoption set, verified by grepping `Skill tool`
across `mattpocock/skills/` at `068b6e0`:

```
grill-me  (user-invoked) ──► grilling          (model-invoked)   [SKILL.md:7]
improve-codebase-         ──► codebase-design   (model-invoked)   [SKILL.md:13]
  architecture            ──► grilling          (model-invoked)   [SKILL.md:64]
  (user-invoked)          ──► domain-modeling   (model-invoked)   [SKILL.md:66]
                          ──► codebase-design   (design-it-twice) [SKILL.md:71]
kg-code-review (new)      ──► agents/code-reviewer.md  (subagent)
```

So **`grilling`, `codebase-design`, and `domain-modeling` must stay model-invoked**
or two skills in the set break without an error message. Nothing else in the set
is a dependency target.

### 2.1 mattpocock/skills → generic set

Source root: `/Users/mknw/.claude/jobs/08af4bca/tmp/skill-review/mattpocock/skills/`

| #   | Skill                           | Source path                                  | Invocation (preserve)                          | Edits needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effort |
| --- | ------------------------------- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `writing-for-agents`            | `productivity/writing-for-agents/`           | **model**                                      | Copy `SKILL.md` (81 ln) **and its sibling `SKILL-MECHANICS.md`** — the body links it at line 8 and it is the only place the invocation mechanics live. No content edits: the doc is stack-free.                                                                                                                                                                                                                                                                                                                                                                             | S      |
| 2   | `grilling`                      | `productivity/grilling/`                     | **model** — dependency target                  | Verbatim (22 ln). Its "dispatch a sub-agent to find facts" line already matches our Agent tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | S      |
| 3   | `grill-me`                      | `productivity/grill-me/`                     | **user** (`disable-model-invocation: true`)    | Verbatim (7 ln). It is a 1-line shim over `grilling`; its only value is the typed trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | S      |
| 4   | `diagnosing-bugs`               | `engineering/diagnosing-bugs/`               | **model**                                      | Copy `SKILL.md` (138 ln) **and `scripts/hitl-loop.template.sh`** — referenced twice as the last-resort loop. Two edits: (a) the "read `CONTEXT.md`… check ADRs" line at the top either resolves against real files or becomes a no-op — settle with OQ‑1/OQ‑2; (b) add one line to the Phase 1 loop menu naming this repo's tightest loops: `pnpm vitest run <file>` and `pnpm exec tsc --noEmit`.                                                                                                                                                                          | M      |
| 5   | `codebase-design`               | `engineering/codebase-design/`               | **model** — dependency target                  | Copy `SKILL.md` + `DEEPENING.md` + `DESIGN-IT-TWICE.md` (195 ln total). Verbatim; the glossary (module/interface/depth/seam/adapter/leverage/locality) is deliberately stack-agnostic. The TS examples already match our language.                                                                                                                                                                                                                                                                                                                                          | S      |
| 6   | `improve-codebase-architecture` | `engineering/improve-codebase-architecture/` | **user**                                       | Copy `SKILL.md` + `HTML-REPORT.md` (194 ln). Keep the Tailwind-CDN report as-is: it is written to `$TMPDIR`, never to the repo, so forcing UnoCSS there is work for no benefit (see OQ‑5). Resolve the `CONTEXT.md` / `docs/adr/` references per OQ‑1/OQ‑2.                                                                                                                                                                                                                                                                                                                 | M      |
| 7   | `domain-modeling`               | `engineering/domain-modeling/`               | **model** — dependency target                  | Copy `SKILL.md` + `CONTEXT-FORMAT.md`; **replace `ADR-FORMAT.md`** with the reconciled format from §3.2. Drop the `CONTEXT-MAP.md` multi-context branch entirely — this repo is one `app/` app, so it is a branch that can never fire (a pure context-load cost by `writing-for-agents`' own no-op test).                                                                                                                                                                                                                                                                    | M      |
| 8   | `wizard`                        | `engineering/wizard/`                        | **model**                                      | Copy `SKILL.md` (44 ln) **and `template.sh` (8.6 KB)** — the skill explicitly forbids hand-editing the library above the `STAGES` marker, so the template is not optional. No content edits. First real use: the manual Entra tenant checklist in `docs/deploy/entra-setup.md` (#119).                                                                                                                                                                                                                                                                                      | S      |
| 9   | `resolving-merge-conflicts`     | `engineering/resolving-merge-conflicts/`     | **model**                                      | Copy verbatim (14 ln), then sharpen step 4 from "discover the project's automated checks" to name them: from `app/`, `pnpm exec tsc --noEmit --project tsconfig.json`, `pnpm test:run`, `pnpm lint`, prettier on changed files. That is a cache of a non-obvious lookup (the `app/` cwd requirement), so it earns its lines.                                                                                                                                                                                                                                                  | S      |
| 10  | `AGENT-BRIEF.md`                | `engineering/triage/AGENT-BRIEF.md`          | **not a skill** → `docs/agents/AGENT-BRIEF.md` | 207 ln. Keep the Principles section verbatim (durability-over-precision, behavioural-not-procedural, complete acceptance criteria, explicit scope). Replace all three worked examples with kg-agent ones. **Add the standing acceptance-criteria block** (§6.2). Drop the "posted as a comment when it moves to `ready-for-agent`" framing — we have no triage label vocabulary.                                                                                                                                                                                            | M      |
| 11  | `setup-matt-pocock-skills`      | `engineering/setup-matt-pocock-skills/`      | **not adopted as a skill**                     | Adopt only its **output**: hand-write `docs/agents/issue-tracker.md`, seeded from `issue-tracker-github.md` (45 ln) and pointed at `gh` + the [project board](https://github.com/users/mknw/projects/5). **Never run the skill** — it auto-edits `CLAUDE.md`, which this project does by hand. **Skip the triage-label section entirely** (`triage` is not adopted, so the labels have no consumer — the skill's own Section B says to skip it in exactly this case). Keep the `wayfinder` operations section only if `wayfinder` is ever adopted; it is not, so delete it. | M      |

**Declined from mattpocock and why** (recorded so it is not re-litigated):
`code-review` (superseded by `kg-code-review`, §2.4), `triage`/`to-tickets`/
`to-spec`/`wayfinder` (all hard-depend on the setup scaffold and a label
vocabulary we are not adopting), `setup-pre-commit` (`.githooks` + lint-staged +
the CI gate already exist), `research` (the `codebase-researcher` agent),
`handoff`/`claude-handoff` (Orca + `worktree-lanes`), `implement` (4 lines;
`CLAUDE.md` covers more), `prototype` (its `UI.md` is Next/React router
examples), `setup-ts-deep-modules` (dependency-cruiser assumes a `packages/*`
monorepo), `tdd`, `ask-matt` (a router over skills we mostly don't have),
`migrate-to-shoehorn`, `scaffold-exercises`, `git-guardrails-claude-code` (a
hooks installer — excluded by the no-hooks constraint).

### 2.2 ECC → generic set

Source root: `/Users/mknw/.claude/jobs/08af4bca/tmp/skill-review/ECC/`

Every ECC skill is model-invoked (none carries `disable-model-invocation`). Three
edits apply to **all** of them and are not repeated per row:

- **Strip the Chinese trigger strings** from `description:` (`living-docs-governance`,
  `loop-design-check`). They are pure always-loaded context load for a single-locale
  user.
- **Delete every dangling cross-reference** to an unadopted ECC skill. Verified list:
  `council` → `santa-method`, `knowledge-ops`, `/save-session`, `planner`,
  `architect`, `code-reviewer`; `living-docs-governance` → `codebase-onboarding`;
  `agent-architecture-audit` → `agent-eval`, `agent-harness-construction`,
  `agent-introspection-debugging`, `autonomous-agent-harness`, `security-review`;
  `loop-design-check` → `autonomous-loops`, `continuous-agent-loop`.
- **Drop `metadata: origin:`** from the frontmatter — provenance moves to
  `PROVENANCE.md` (single source of truth, §4).

| #   | Skill                           | Source path                             | Invocation                                    | Edits needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Effort |
| --- | ------------------------------- | --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 12  | `intent-driven-development`     | `skills/intent-driven-development/`     | model                                         | 17 KB — the largest file in the set. Trim the description to its trigger branches. **Reconcile with `AGENT-BRIEF.md` (§3.4):** keep its Risk Review table and `AC-NNN` criterion shape, delete its Revision Log / Status / Prepared-for header (ceremony with no consumer here).                                                                                                                                                                                                                                                    | L      |
| 13  | `architecture-decision-records` | `skills/architecture-decision-records/` | model                                         | See §3.2 — this skill survives as the **mechanism** (detection signals, index table, lifecycle statuses, the confirm-before-write gate) with its heavyweight ADR body template replaced by mattpocock's.                                                                                                                                                                                                                                                                                                                            | M      |
| 14  | `agent-architecture-audit`      | `skills/agent-architecture-audit/`      | model                                         | 10 KB, 12-layer stack. Note its upstream origin is `oh-my-agent-check`, not ECC — record that in `PROVENANCE.md`. Keep its `tools:` frontmatter. Best-fitting skill in the whole set for this repo: its failure taxonomy (wrapper regression, memory contamination, tool-discipline failure, hidden agent layers, rendering corruption) maps directly onto `harness-patterns`. Retarget its evidence-collection greps at `app/src/lib/harness-patterns/`.                                                                            | M      |
| 15  | `silent-failure-hunter`         | `agents/silent-failure-hunter.md`       | **subagent**, not a skill → `.claude/agents/` | 59 ln. **Delete the 7-line "Prompt Defense Baseline" preamble** — it fails the no-op test (the model already does all of it) and costs load on every dispatch. Keep `model: sonnet`? No — override to Opus per standing preference for subagents.                                                                                                                                                                                                                                                                                   | S      |
| 16  | `living-docs-governance`        | `skills/living-docs-governance/`        | model                                         | Its core move ("inventory before creating anything; adopt the repo's existing docs structure over new root files") is exactly right for a repo with a mature `docs/INDEX.md`. Retarget its four roles onto ours: constitution = `CLAUDE.md`, map = `docs/INDEX.md`, status = the GitHub project board, history = `docs/plan/` + PR bodies.                                                                                                                                                                                          | M      |
| 17  | `council`                       | `skills/council/`                       | model                                         | 6.3 KB. Delete the "Related Skills" and "Persistence Rule" sections wholesale (both are entirely dangling ECC references). Replace the `When NOT to Use` table's right column with our real alternatives (`grilling`, `kg-code-review`, the built-in `/code-review`). See §3.1 for the grilling boundary.                                                                                                                                                                                                                           | M      |
| 18  | `loop-design-check`             | `skills/loop-design-check/`             | model                                         | 12.5 KB. Description is bloated with bilingual triggers — rewrite to one line. High fit: this repo ships `simpleLoop` / `actorCritic` / routines (#131), and the skill's five failure modes (spinning, Goodhart-gaming the verifier, running a wrong answer to completion, undecidable goal, judge non-independence) are live risks in `harness-patterns`.                                                                                                                                                                          | M      |
| 19  | `code-reviewer`                 | `agents/code-reviewer.md`               | **subagent** → `.claude/agents/`              | 323 ln. **Delete** the `### React/Next.js Patterns` block (lines 181–213) per the adoption decision, the "Prompt Defense Baseline" preamble, and the `v1.8 AI-Generated Code Review Addendum` (vendor-flavoured). **Keep** the four load-bearing parts: the Pre-Report Gate, HIGH/CRITICAL-require-proof, "zero findings is a valid review", and the **Common False Positives** list. This agent becomes the executor of `kg-code-review`'s Standards axis (§2.4) — which is how the false-positive list gets adopted exactly once. | M      |

**Declined from ECC:** the plugin install (adds ~21 k tokens of descriptions to
every session), `plankton-code-quality` (ships a hook that blocks `pnpm`),
`continuous-learning-v2` / `unified-memory` / `plan-canvas` (require
`npm install -g ecc-universal` or a background daemon — excluded by the
no-daemons constraint, and they would become a second memory system beside our
notes and h9s), and the ~280 remaining skills (personal working notes, sponsor
integrations, business-ops verticals).

### 2.3 ui-ux-pro-max → project set (Wave 5)

`kg-dtalk-ui` is **ours**, with two small vendored pieces. Sources verified at
`a38d04c`:

| Piece      | Source path                                                             | What we take                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WCAG §1    | `.claude/skills/ui-ux-pro-max/references/quick-reference.md` lines 7–33 | "1. Accessibility (CRITICAL)" — 24 rules, real WCAG 2.2 A/AA/AAA criteria with their conformance level named                                                                                                                                                                                                                                      |
| WCAG §2    | same file, lines 35–53                                                  | "2. Touch & Interaction (CRITICAL)" — 17 rules                                                                                                                                                                                                                                                                                                    |
| Charts row | `.claude/skills/ui-ux-pro-max/data/charts.csv` row **16**               | Relationship/Connection Data → Network Graph: render thresholds (**≤100 nodes SVG · 101–500 Canvas · >500 requires clustering/LOD**), edge colour `#90A4AE` @60 %, highlight `#F59E0B`, and the adjacency-table-as-accessible-source-of-truth fallback with its keyboard contract. Cytoscape.js is named in its own Library Recommendation column |

The rest of `kg-dtalk-ui` is this project's own tokens and recipes. **Do not
vendor the search tool or the design-system generator**: `--stack uno` in that
repo is the .NET **Uno Platform** (XAML/WinUI), not UnoCSS — an agent
auto-detecting "uno" from `package.json` gets C#/XAML guidance. And
`--design-system` always generates a _fresh_ palette from its 192-product
database, with no flag to validate against an existing token set, so it would
fight `uno.config.ts` rather than serve it.

Effort: **L**, and it blocks on OQ‑6.

### 2.4 `kg-code-review` — the synthesis skill (project set)

The only skill in the programme written from scratch. Its structure is
mattpocock's; its suppression list is ECC's; its standards are ours.

| Element                    | Origin                        | Content                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-axis shape             | mattpocock `code-review`      | **Standards** and **Spec** run as parallel subagents and are reported side by side, never merged or reranked — one axis passing must not mask the other failing                                                                                                                                                               |
| Fixed point                | mattpocock                    | `git diff <point>...HEAD` (three-dot, merge-base), validated with `git rev-parse` before any subagent spawns                                                                                                                                                                                                                  |
| Spec source                | mattpocock, retargeted        | `gh issue view <n> --comments` per `docs/agents/issue-tracker.md`; issue refs read from commit messages, then the PR body, then the branch name                                                                                                                                                                               |
| Fowler smell baseline      | mattpocock                    | 12 smells, each _what it is_ → _how to fix_, all explicitly judgement calls, all overridable by a documented repo standard                                                                                                                                                                                                    |
| False-positive suppression | ECC `agents/code-reviewer.md` | The 12-entry "Common False Positives — Skip These" list, plus the Pre-Report Gate and "zero findings is a valid review"                                                                                                                                                                                                       |
| Repo standards             | **new**                       | UnoCSS attributify only (never `class=`, except `i-*` icons); `.server.ts` + `assertServerOnImport()`; BAML functions always `.bind(b)`; never edit `baml_client/`; `pnpm` only, run from `app/`; conventional commits; **no attribution trailers**; `CLIENT_MAX_OUTPUT_TOKENS` kept in sync with the BAML client `max_tokens` |

Implementation note: the Standards subagent is dispatched as
`agentType: code-reviewer` (the vendored ECC agent, §2.2 #19) rather than as an
inline prompt. That is what keeps the false-positive list in exactly one file.

Effort: **L**.

### 2.5 ponytail → prose only

Not a skill. A short `## Code minimalism` section in `CLAUDE.md`, **rewritten in
our own words** rather than copied (it has to be adapted anyway), carrying the
7-rung ladder — YAGNI → reuse what's here → stdlib → platform → installed
dependency → one line → minimum new code — plus the guardrails that stop it
becoming an excuse (understand before climbing; root cause not symptom; never
lazy about validation at trust boundaries, error handling, security,
accessibility).

**The added line, which is the whole reason this is worth writing down:**

> Ark UI is the chosen primitive layer. Never replace an Ark component with a
> native element.

Ponytail's own rung 5 ("an already-installed dependency solves it") protects Ark
UI — but only if the project states that Ark UI is the chosen layer. Its flagship
published example replaces Radix Dialog with native `<dialog>`; without that line
the ladder argues against our stack. Add "adapted from ponytail (MIT)" as a
one-line credit.

**Do not** adopt the ponytail plugin: it uses SessionStart + SubagentStart +
UserPromptSubmit hooks to inject its ruleset unconditionally into every session
_and every subagent_ — excluded by the no-hooks constraint.

---

## 3. Overlap reconciliation

### 3.1 `grilling` vs `council` — keep both, different shapes

They look similar and are not. The distinguishing question is **who holds the
answer**.

|              | `grilling`                                                                         | `council`                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Shape        | Multi-round interview of the **human**; frontier of answerable questions per round | Single round; three **subagents** in fixed roles (Skeptic / Pragmatist / Critic) plus your own Architect position |
| Who decides  | The user, always — "the _decisions_ are the user's"                                | You synthesise a verdict                                                                                          |
| Use when     | The unknowns are the user's preferences, constraints, priorities                   | The unknowns are tradeoffs nobody owns, and conversational anchoring is the risk                                  |
| Anti-pattern | Using it when the user has no opinion yet — you stall                              | Using it for code review, implementation planning, or anything with a right answer                                |

**Do not merge them.** A merged skill would have to spawn subagents that answer
_on the user's behalf_, which is precisely what `grilling` forbids and what makes
it work.

They compose in one direction: a `council` verdict is good raw material for a
`grilling` round ("here are three positions, which constraint decides it for
you?"). The reverse — grilling to produce input for a council — means you had a
user available and should have just asked.

Both stay model-invoked. `grill-me` is the user-invoked typed trigger for
`grilling`; `council` needs no shim because "convene a council" is already a
distinct phrase.

### 3.2 ADR mechanism — pick one

Two candidates arrive with the adoption set and they disagree.

|           | mattpocock `domain-modeling/ADR-FORMAT.md`                                                                      | ECC `architecture-decision-records`                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Body      | 1–3 sentences. Optional Status / Considered Options / Consequences                                              | Nygard-style: Context, Decision, Alternatives (pros/cons/why-not), Consequences (positive/negative/risks) |
| Directory | `docs/adr/NNNN-slug.md`, created lazily                                                                         | `docs/adr/` + `README.md` index + `template.md`, created on confirmation                                  |
| Gate      | Three-condition test: hard to reverse **and** surprising without context **and** the result of a real trade-off | Detection signals (explicit + implicit phrases), never auto-write                                         |
| Lifecycle | Optional status frontmatter                                                                                     | `proposed → accepted → [deprecated \| superseded by]`                                                     |

**Decision: take mattpocock's body and gate, ECC's index and lifecycle.**

- **Body + gate: mattpocock.** The three-condition gate is the part that stops an
  ADR directory silting up, and a one-paragraph ADR actually gets written. ECC's
  full template makes every ADR a small essay; its own guidance then warns
  "if the context section exceeds 10 lines it's too long" — the template fights
  itself.
- **Index + lifecycle: ECC.** `docs/adr/README.md` as a `| ADR | Title | Status |
Date |` table is the thing that makes a directory readable at 20 entries, and
  `superseded by ADR-NNNN` is how a decision gets revisited without deleting the
  history. mattpocock's format has both as optional afterthoughts.
- **The confirm-before-write gate is ECC's and is kept**: present the draft, write
  only on explicit approval, discard silently on decline.

**File layout (single, canonical):**

```
docs/adr/
├── README.md              # index table — the only place statuses are aggregated
├── 0001-<slug>.md
└── 0002-<slug>.md
```

**Reconciling with this repo's existing decision-record culture.** Today decisions
live in three places, and adding a fourth only helps if each has a distinct job:

| Where                 | Holds                                                                                                   | Example                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `docs/plan/`          | Converged **shapes** — multi-page designs with alternatives, diagrams, deferred sections                | `plan/sandbox.md`, `plan/ROADMAP.md`, this doc |
| PR bodies             | The **narrative** of one change: what moved and why, review discussion                                  | PR #106, PR #117                               |
| `CLAUDE.md`           | Standing **dispositions** an agent must hold every turn                                                 | "never edit `baml_client/`"                    |
| **`docs/adr/`** (new) | Irreversible **one-liners with a why**, that are too small for a plan doc and too durable for a PR body | "Controller uses `*NoThink` clients"           |

The gap is real: the Anthropic-only default, the `ControllerAnthropic` NoThink
choice, and the redis-stack + amd64 platform pin are all currently recorded only
as `CLAUDE.md` prose, which states the _what_ under permanent context load while
the _why_ (a 12-prompt × 6-sample measurement; an arm64 `redisearch.so` SIGILL)
rides along with it. Moving the why to an ADR and leaving a one-line disposition
in `CLAUDE.md` is a net context saving.

**Back-fill: yes, a seed of five** (OQ‑2), each marked with its original date:

1. Anthropic-only fallback chains as the dev default; `USE_MIXED_CHAINS=1` opts
   into the mixed-provider chains.
2. `ControllerAnthropic` uses the `*NoThink` clients (#139) — with the measurement
   that decided it.
3. `redis` service must be redis-stack, pinned `platform: linux/amd64` on Apple
   Silicon.
4. `.server.ts` suffix + `assertServerOnImport()` as the server/client boundary.
5. harness-patterns replaces `lib/baml-agent/`; the old system is removed and must
   not be recreated.

An empty convention is a convention nobody follows — the seed is what gives
`domain-modeling` and `improve-codebase-architecture` something to read.

### 3.3 `kg-code-review` vs the built-in `/code-review`

Both exist. They answer different questions and neither replaces the other.

|            | Built-in `/code-review`                                                                                          | `kg-code-review`                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Question   | **Is it wrong?** — correctness bugs, plus reuse / simplification / efficiency cleanups                           | **Is it ours, and is it what was asked for?**                                    |
| Axes       | One, effort-scaled (low/medium = fewer high-confidence findings; high→max = broader, may include uncertain ones) | Two, deliberately unmerged: Standards and Spec                                   |
| Inputs     | The diff                                                                                                         | The diff **+ this repo's documented conventions + the originating GitHub issue** |
| Can act    | Yes — `--fix` applies findings, `--comment` posts inline PR comments                                             | No. It reports                                                                   |
| Ships with | Claude Code                                                                                                      | This repo                                                                        |

**Stated order of use:** run the built-in first (it can fix what it finds), then
`kg-code-review` before opening the PR (it catches convention drift and scope
creep against the issue — neither of which is a bug, so neither is in the
built-in's remit).

**Never name ours `code-review`.** A project skill sharing a built-in's name makes
resolution a coin flip; the `kg-` prefix is load-bearing here, not decoration.

### 3.4 `intent-driven-development` vs `AGENT-BRIEF.md`

Both produce a spec with acceptance criteria, and both are in the adoption set.
The split:

- **`AGENT-BRIEF.md` is the artifact** — a template, a doc, not a skill. It is what
  an Orca dispatch or a GitHub issue body looks like.
- **`intent-driven-development` is the procedure** that produces one when the
  request is ambiguous or risky enough to need discovery first.

Concretely: `intent-driven-development` keeps its Risk Review table (security /
persistent-data / external-effects / compatibility / UX) and its `AC-NNN`
criterion shape — both of which `AGENT-BRIEF.md` lacks and both of which are
genuinely useful — and its output is written **in the `AGENT-BRIEF.md` template's
shape**, not in its own competing header format. Its Status / Revision /
Prepared-for header and Revision Log are deleted: no consumer, pure ceremony.

---

## 4. Upstream sync policy

**Policy: pinned commit, manual diff review, no automation, on demand.**

Every vendored file has been _adapted_ — stack mismatches deleted, dangling
references stripped, invocation flags asserted. An automated pull would silently
reintroduce exactly what we removed. Upstream churn is also high (mattpocock: 182
commits in 2026‑07 alone; ECC ships weekly releases), and almost none of it will
matter to a prose procedure.

**Where the pin lives: `.claude/skills/PROVENANCE.md`, and nowhere else.**

```markdown
| Our path                                 | Upstream repo     | Upstream path                                    | Pinned commit | Adapted                                  | Bundle                              |
| ---------------------------------------- | ----------------- | ------------------------------------------------ | ------------- | ---------------------------------------- | ----------------------------------- |
| skills/grilling/SKILL.md                 | mattpocock/skills | skills/productivity/grilling/SKILL.md            | 068b6e0       | no                                       | generic                             |
| skills/domain-modeling/ADR-FORMAT.md     | mattpocock/skills | skills/engineering/domain-modeling/ADR-FORMAT.md | 068b6e0       | **yes** — §3.2                           | generic                             |
| agents/code-reviewer.md                  | affaan-m/ECC      | agents/code-reviewer.md                          | 50743ce       | **yes** — React block + preamble deleted | generic                             |
| skills/agent-architecture-audit/SKILL.md | affaan-m/ECC      | skills/agent-architecture-audit/SKILL.md         | 50743ce       | yes                                      | generic (orig. `oh-my-agent-check`) |
```

The per-file header (§8) carries **attribution only — repo, path, author,
license — and no SHA**, so bumping a pin is a one-place edit in the table. Two
copies of the same fact is exactly the duplication `writing-for-agents` warns
about, and the pin is the field that actually changes.

**The refresh procedure**, run when there is a reason to (an upstream release
note that sounds relevant, or a skill misbehaving):

```sh
git clone --filter=blob:none https://github.com/<repo> /tmp/<name>
git -C /tmp/<name> diff <pinned-sha>..HEAD -- <upstream-path>
```

Read the diff. Re-apply our adaptations by hand on top of anything worth taking.
Bump the row. One PR per source repo, so a bad refresh reverts cleanly.

**Explicitly not doing:** git submodules (they would drag whole repos in for a
handful of files, and both upstreams are monorepos of 30–285 skills), `npx
skills add` (it installs the whole set and re-installs on update, discarding our
edits), and the Claude Code plugin route (auto-updating and read-only — adaptation
is impossible by construction).

---

## 5. `CLAUDE.md` integration

### 5.1 The pointer block

Hand-written. Placed after **Design Decisions** and before **Harness Patterns —
Quick Reference**, so it sits with the other "how we work" material rather than
with the API reference. Never generated by a setup skill.

```markdown
## Agent skills

Procedures live in `.claude/skills/` (tracked in git, so worktrees inherit them).
Model-invoked skills announce themselves; the user-invoked ones you have to ask
for by name are `/grill-me` and `/improve-codebase-architecture`.

- Bare names (`grilling`, `codebase-design`, …) are stack-agnostic and are the
  candidate set for the open-source split. `kg-`-prefixed ones encode something
  only true of this repo.
- A `kg-*` skill may call a generic skill. A generic skill must never call a
  `kg-*` skill — that invariant is what keeps the generic set portable.
- Issue-tracker workflow: `docs/agents/issue-tracker.md`. Decision records:
  `docs/adr/`. Dispatch spec template: `docs/agents/AGENT-BRIEF.md`.
- Provenance and upstream pins for vendored files: `.claude/skills/PROVENANCE.md`.

`/kg-code-review` (conventions + spec fidelity) complements the built-in
`/code-review` (correctness bugs + cleanups). Run the built-in first — it can fix
what it finds.
```

**It does not list the skills.** Every model-invoked skill's description is
already permanently loaded; a list in `CLAUDE.md` restates it at full context cost
and goes stale the day a skill is renamed. Only the user-invoked ones — which by
construction have no description the agent can see — are named, and there are two.

That is the block's whole discipline for staying short: it may name **paths and
invariants**, never contents.

### 5.2 What moves out

`writing-for-agents` supplies the tests; applied to the current `CLAUDE.md` they
find four candidates. All four need sign-off (OQ‑3) — `CLAUDE.md` is the user's
document — and all four belong in their own PR so a revert is cheap.

| Section                                             | Test it fails                                                                                        | Recommendation                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design Decisions → "Probe before scaffolding"**   | Duplication — the paragraph _is_ the `grilling` procedure, now in a skill                            | Keep the trigger, drop the procedure: one line — "For architectural questions, converge with the user before writing implementation docs; `/grill-me` runs the interview. See `docs/plan/sandbox.md` for the doc that should follow." |
| **BAML client chain tables** (the two model tables) | Cache — the chains are one lookup away in `baml_src/anthropic-only.baml` and `baml_src/clients.baml` | Drop the chain columns, keep the **why** (the NoThink measurement, the Sonnet-tier backstop rationale) and move the long version to ADR‑0002                                                                                          |
| **Commands block**                                  | Cache — `pnpm dev`, `pnpm build`, `pnpm test:run` are a one-file lookup in `app/package.json`         | Keep only the non-obvious ones: the `app/` cwd requirement, the two llama-server ports (8080 chat vs 8090 embeddings — the trap), `USE_MIXED_CHAINS=1`, and `baml-generate` after any `baml_src/` edit. Drop the rest                  |
| **Documentation table**                             | Duplication — it is `docs/INDEX.md` restated, and drifts                                             | Collapse to a pointer at `docs/INDEX.md` plus the three most-reached rows                                                                                                                                                             |

Nothing is _replaced by_ a skill outright: skills are procedures, and `CLAUDE.md`
holds dispositions. `writing-for-agents` gains ownership of the theory of writing
these documents, which means the next `CLAUDE.md` edit has a discipline to follow
— but the file itself keeps its job.

---

## 6. Orca worker integration

### 6.1 The assumption, verified — and it is currently false

> **`.claude/` is gitignored** (`.gitignore:33`), so an in-repo `.claude/skills/`
> would **not** be inherited by a worktree today. The stated assumption does not
> hold as things stand.

What actually reaches a worktree, verified against `orca.yaml` (tracked at the
repo root) and the live worktrees:

1. A git worktree inherits **committed state only**.
2. `orca.yaml`'s `scripts.setup` copies the gitignored bits by hand: `app/.env`,
   `configs/mcp-config.yaml`, the optional `docker-compose.override.yml`, and —
   explicitly — `.claude/settings.json` + `.claude/settings.local.json`. Confirmed
   in this worktree: both settings files are present and byte-identical to the
   root checkout's; nothing else under `.claude/` is.
3. So skills would silently not exist for any worker.

**The fix — narrow the ignore rather than extend the copy loop:**

```diff
-.claude/
+.claude/*
+!.claude/skills/
+!.claude/agents/
```

The trailing-slash form (`.claude/`) makes git skip the directory entirely, so
negations inside it never apply; `.claude/*` is the form that allows re-inclusion.
`settings.local.json` stays ignored, which is what we want — it holds the local
permission allow-list.

Why this rather than adding `skills/` to `orca.yaml`'s copy loop: git is the
mechanism that already carries committed state into a worktree, and skills are
source. Copying them would make a worktree's skills reflect the _root checkout's_
working tree instead of the branch under test — so a PR that edits a skill could
not be reviewed in its own worktree. **No `orca.yaml` change is needed** beyond a
comment noting that skills now travel via git.

Also nothing to change in `issueCommand`: it already opens with "Read CLAUDE.md
first", and `CLAUDE.md` will carry the pointer block (§5.1). Model-invoked skills
announce themselves through their descriptions; the two user-invoked ones are
named in the block. Adding a skills list to `issueCommand` would be the same
duplication, in a prompt that runs on every dispatch.

### 6.2 `AGENT-BRIEF.md` as the standard dispatch spec

`docs/agents/AGENT-BRIEF.md` becomes the template for Orca dispatches and for
`ready-for-agent` issue bodies alike. Its upstream principles carry over
unchanged — describe interfaces and behavioural contracts, never file paths or
line numbers, because a brief may sit for weeks while the codebase moves.

What we add is a **standing acceptance-criteria block**, appended to every brief's
own criteria, so a dispatch never has to restate the house rules:

```markdown
**Standing acceptance criteria** (every brief in this repo):

- [ ] CI green: typecheck · lint · test · build (`.github/workflows/ci.yml`)
- [ ] Coverage floors not regressed — statements 93 / branches 82 /
      functions 92 / lines 94
- [ ] Prettier clean on changed files (`app/.prettierrc.json`; the CI gate checks
      changed files under `app/` only — see the note below)
- [ ] Conventional-commit subject line
- [ ] **No** `Co-Authored-By` / "Generated with" attribution trailers
- [ ] `pnpm` only, run from `app/` (never npm/npx)
- [ ] `pnpm baml-generate` re-run if anything under `baml_src/` changed;
      `baml_client/` never hand-edited
```

One verified caveat worth keeping in the template:

- The CI **Format check** step globs `app/**/*.{ts,tsx,js,jsx,json,css,md}` only —
  it does **not** cover `docs/**` or `.claude/**`. The `.githooks/pre-commit`
  → lint-staged path does format staged `*.md` anywhere in the tree, and it
  repairs rather than rejects. So a docs-only PR can be prettier-dirty and still
  go green; run prettier by hand on docs changes.

---

## 7. Sequencing

Six PRs, each independently valuable and CI-green. Every one of them touches only
Markdown, `.gitignore`, and `CLAUDE.md` — no TypeScript, no dependencies, so the
typecheck/lint/test/build gate is unaffected throughout.

| Wave  | PR title                                                                     | Contents                                                                                                                                                                                                                                                                                       | Mechanical?                              |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **0** | _(this PR)_ `docs(plan): skills adoption plan — curated procedure bundle(s)` | This document + one `docs/INDEX.md` row                                                                                                                                                                                                                                                        | ✅                                       |
| **1** | `chore(skills): track .claude/skills + adopt the generic core`               | `.gitignore` narrowing (§6.1) · `NOTICE.md` · `PROVENANCE.md` · `CLAUDE.md` pointer block (§5.1) · skills #1–#5, #8, #9 (`writing-for-agents`+mechanics, `grilling`, `grill-me`, `diagnosing-bugs`+hitl template, `codebase-design`+2 refs, `wizard`+template.sh, `resolving-merge-conflicts`) | ✅ mechanical                            |
| **2** | `docs(adr): ADR mechanism + seed records`                                    | `docs/adr/README.md` · 5 back-filled ADRs (§3.2) · `CONTEXT.md` seed **if** OQ‑1 says yes                                                                                                                                                                                                      | ⚠ **sign-off: OQ‑1, OQ‑2**               |
| **3** | `chore(skills): design + decision procedures`                                | `domain-modeling` (adapted, ADR-FORMAT replaced) · `improve-codebase-architecture` · `council` · `intent-driven-development` · `loop-design-check`                                                                                                                                             | ✅ mechanical _once Wave 2 lands_        |
| **4** | `chore(skills): review pipeline`                                             | `docs/agents/issue-tracker.md` (hand-written) · `kg-code-review` · `.claude/agents/code-reviewer.md` · `.claude/agents/silent-failure-hunter.md` · `agent-architecture-audit` · `living-docs-governance`                                                                                       | ⚠ **sign-off: OQ‑4** (board conventions) |
| **5** | `docs(agents): AGENT-BRIEF template + CLAUDE.md pruning`                     | `docs/agents/AGENT-BRIEF.md` with the standing criteria (§6.2) · ponytail minimalism section (§2.5) · the four `CLAUDE.md` prunings (§5.2)                                                                                                                                                     | ⚠ **sign-off: OQ‑3**                     |
| **6** | `chore(skills): kg-dtalk-ui styleguide`                                      | `kg-dtalk-ui` — own tokens/recipes + vendored WCAG §1‑2 + charts row 16 (§2.3)                                                                                                                                                                                                                 | ⚠ **sign-off: OQ‑6** (token inventory)   |

Dependency spine: **1 → 2 → 3**, and **1 → 4**. Waves 5 and 6 hang off 1 only and
can run in parallel with 3 and 4. Wave 1 is the only one that must go first —
without the `.gitignore` change nothing reaches a worker.

**Wave 1 is the acceptance test for the whole programme.** Once it lands, verify
in a fresh worktree: create one, confirm `.claude/skills/` is present without any
copy step, and confirm `/grill-me` resolves and successfully reaches `grilling`
through the Skill tool. If that cross-skill call fails silently, the invocation
flags were not preserved and every downstream wave inherits the bug.

---

## 8. Licensing and attribution

All four adopted sources are MIT. MIT requires the copyright notice and the
permission notice to travel with "all copies or substantial portions" — a
vendored `SKILL.md` is unambiguously a substantial portion, so this is not
optional.

**Two-part mechanism, no duplication:**

1. **Per-file header** — an HTML comment immediately after the YAML frontmatter:

   ```markdown
   ---
   name: grilling
   description: …
   ---

   <!-- Vendored from mattpocock/skills (MIT © 2026 Matt Pocock),
        skills/productivity/grilling/SKILL.md. Pin + adaptations:
        .claude/skills/PROVENANCE.md · full license: .claude/skills/NOTICE.md -->
   ```

   It is outside the frontmatter deliberately: an extra frontmatter key would be
   ignored by the loader but would still sit in the file, and the `description`
   — the one field under permanent context load — stays untouched. Two lines of
   body is the whole cost.

2. **`.claude/skills/NOTICE.md`** — the four full MIT texts, verbatim, with their
   copyright lines. This is the file that actually satisfies the permission-notice
   clause; the headers are pointers to it.

**Derivative works.** `kg-code-review` and `kg-dtalk-ui` are ours but contain MIT
material (ECC's false-positive list; ui-ux-pro-max's WCAG sections and chart row).
They carry the same header, naming both sources. This is a second reason those two
sit in the project set rather than the generic one — their attribution surface is
larger and messier than a straight vendored copy's.

**Implications for the OSS split.** If the generic set ships with an
open-sourced harness-playground:

- `NOTICE.md` must ship with it. The headers alone are not the notice.
- The repo's own `LICENSE` must not read as claiming authorship of the vendored
  files — a short "Third-party material" paragraph pointing at
  `.claude/skills/NOTICE.md` covers it.
- Every `kg-*` directory is excluded, which is exactly the naming convention's
  job. The check is one `ls`, not a judgement call.
- MIT is permissive enough that relicensing the combined work under the project's
  own license is fine, provided the notices survive. No copyleft in the set.
- `andrej-karpathy-skills` stays excluded. No LICENSE file at `2c60614` means
  all-rights-reserved by default; the fact that it is a third-party distillation
  of a Karpathy post — not authored or endorsed by him, and hosted by an org that
  promotes its own product — is a second reason not to reopen it.

---

## Open questions

Each is addressed to the user, with a recommended answer. Waves 2–6 name the ones
that gate them.

**OQ‑1 — Do we create a root `CONTEXT.md`?**
Three adopted skills (`domain-modeling`, `improve-codebase-architecture`,
`diagnosing-bugs`) read a glossary at `CONTEXT.md`. This repo has none, so those
lines currently no-op silently.
**Recommended: yes**, seeded in Wave 2 with the ~12 terms this codebase already
speaks but has never written down — _pattern_, _controller_, _actor_, _critic_,
_harness_, _EventView_, _ContextEvent_, _tool namespace_, _Data Stash_, _stash
session_, _sandbox flavour_, _routine_, _action_. It is cheap, it is genuinely
useful independent of the skills, and a `CONTEXT.md` that describes only vocabulary
(never implementation) will not rot the way a design doc does. The alternative —
deleting the pointers from three skills — costs the same effort and leaves the
vocabulary implicit.

**OQ‑2 — Does `docs/adr/` get created, and do we back-fill?**
**Recommended: yes to both**, with the five records named in §3.2. Back-filling is
what makes the directory readable enough for `improve-codebase-architecture` to
honour ("ADRs record decisions this command should not re-litigate") and it moves
three long _why_ passages out of always-loaded `CLAUDE.md` prose. Mark each with
its original date, per ECC's own don't-backfill-silently rule.

**OQ‑3 — Do the four `CLAUDE.md` prunings (§5.2) happen in this programme?**
**Recommended: yes, but as Wave 5's own PR**, separate from any skill, so a revert
costs one `git revert`. If you would rather keep `CLAUDE.md` frozen, Waves 1–4 are
unaffected — only the pointer block (§5.1) is load-bearing, and that is an
addition, not a prune.

**OQ‑4 — What does `docs/agents/issue-tracker.md` say about the project board?**
`kg-code-review`'s Spec axis needs one deterministic way to fetch an issue. `gh
issue view <n> --comments` is obvious; what is not obvious is whether the
[project board](https://github.com/users/mknw/projects/5) fields (Status /
Priority / MSCW) are part of the spec a review checks against.
**Recommended: no** — the board tracks _scheduling_, the issue body holds the
_spec_. Document `gh` issue commands only, and note the board as read-only
context. Reopening this later is cheap.

**OQ‑5 — `improve-codebase-architecture` emits a Tailwind-CDN HTML report.**
This repo is UnoCSS-attributify.
**Recommended: leave it.** The report is written to `$TMPDIR` and opened in a
browser; it never enters the repo, and no rule we have applies to a throwaway. Any
UnoCSS conversion is pure cost. Worth knowing it exists so it is not mistaken for
a violation during review.

**OQ‑6 — What is `kg-dtalk-ui`'s token inventory, and who owns it?**
`uno.config.ts` is the source of truth for `dark-bg-*`, `dark-text-*`,
`dark-border-*`, `neon-*`, `cyber-*`. A skill restating them is a **cache** by
`writing-for-agents`' test, and caches of a one-file lookup go stale.
**Recommended:** the skill carries **recipes and rules** (which token for which
role, the attributify-only rule, the `class="i-*"` icon exception, the
`color`-attribute collision, the Cytoscape render thresholds) and **points at
`uno.config.ts`** for the token list itself. That needs you to confirm the
role→token mapping once; it is not derivable from the config. Wave 6 blocks on it.

**OQ‑7 — Should the material-symbols icon migration ride along?**
`CLAUDE.md` currently documents `i-mdi-*` as the icon set; the standing preference
is material-symbols. `kg-dtalk-ui` will have to state one of them.
**Recommended: state material-symbols in the skill and fix `CLAUDE.md` in the same
Wave 6 PR** — a styleguide skill that contradicts `CLAUDE.md` is worse than either
one being stale alone. This is a one-line change, not a codebase migration.

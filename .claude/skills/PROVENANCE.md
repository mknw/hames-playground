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
--project tsconfig.json`, both from `ui/`). A cache of a non-obvious lookup —
the `ui/` cwd requirement — so it earns its load.

**C — `resolving-merge-conflicts` step 4.** Sharpened "discover the project's
automated checks" into the named commands, in order, with the `ui/` cwd stated.
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
are dead here. They now scope to `ui/src/lib/harness-patterns/` and
`ui/baml_src/`, with the source-code bullet naming the actual boundary files
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
`ui/src/lib/baml-agent/` → `harness-patterns/`, which is a live "do not recreate
this" rule in `CLAUDE.md`.

> These are **data hooks** by the plan's §1 rule — a generic skill naming stable
> project-supplied paths (`CLAUDE.md`, `docs/INDEX.md`, `docs/adr/`,
> `ui/src/lib/harness-patterns/`) and degrading gracefully — not dependencies on
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

---

<!-- Later waves append their own `## Wave N` section here. Do not edit the
     sections above; a wave that needs to change an earlier row bumps that row
     in place and says why in its own section. -->

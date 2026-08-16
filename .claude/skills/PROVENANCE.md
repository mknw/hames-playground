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
trailers, `pnpm`-only from `ui/`, `baml-generate` after `baml_src/` edits), plus
the two caveats that make them honest — the floors are not on `main` until PR
#165 merges, and the CI format check globs `ui/**` only, so a docs-only PR can
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

---

<!-- Later waves append their own `## Wave N` section here. Do not edit the
     sections above; a wave that needs to change an earlier row bumps that row
     in place and says why in its own section. -->
